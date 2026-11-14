import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { RuntimeTaskSessionSummary } from "../../src/core/api-contract";
import { taskCommandExecutionSpecificationSchema } from "../../src/core/task-command-execution-contract";
import {
	createTaskCommandExecutionService,
	type TaskCommandExecutionDependencies,
} from "../../src/task-command-execution/task-command-execution-service";
import {
	readTaskCommandExecutions,
	taskCommandExecutionArtifactDirectory,
} from "../../src/task-command-execution/task-command-execution-store";
import {
	cancelOwnedCommandProcesses,
	hasSameProcessGeneration,
	inspectOwnedCommandSupervisor,
	launchOwnedCommandSupervisor,
	type OwnedProcessIdentity,
	readProcessIdentity,
} from "../../src/task-command-execution/task-command-execution-supervisor";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { createTempDir } from "../utilities/temp-dir";

const isolatedHome = vi.hoisted(() => ({ path: "" }));
vi.mock("../../src/state/workspace-state", () => ({
	getWorkspaceDirectoryPath: (workspaceId: string) => join(isolatedHome.path, "workspaces", workspaceId),
	getRuntimeHomePath: () => isolatedHome.path,
}));
afterEach(() => vi.unstubAllEnvs());

describe("未登记的独立重部署监督进程自动接回", { timeout: 90_000 }, () => {
	it("真实进程先独立执行，runtime 恢复后发现并接回；机器等待不交回，最终只交回一次", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		isolatedHome.path = join(fixture.isolatedHomeDirectoryPath, ".cline/kanban");
		vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
		vi.stubEnv("CODEX_HOME", join(fixture.isolatedHomeDirectoryPath, ".codex"));
		vi.stubEnv("CODEX_SQLITE_HOME", join(fixture.isolatedHomeDirectoryPath, ".codex"));
		const workingDirectory = fixture.fixtureRootDirectoryPath;
		const resultFile = join(workingDirectory, "business-result.json");
		const invocationFile = join(workingDirectory, "invocations.txt");
		const releaseFile = join(workingDirectory, "release-final-result");
		const command = [
			process.execPath,
			"-e",
			`const fs=require('node:fs'); fs.appendFileSync(${JSON.stringify(invocationFile)},'once'); fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({disposition:'machine_evidence_pending',recovery:{action:'resume_same_run',maximum_unchanged_retries:0}})); const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(releaseFile)})){clearInterval(timer);fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({disposition:'agent_review_ready',status:'succeeded'}));}},50);`,
		];
		const specification = taskCommandExecutionSpecificationSchema.parse({
			command,
			resumeCommand: command,
			resultFile,
			workingDirectory,
			materialSha256: "a".repeat(64),
			label: "隔离离线重部署",
			resumeCommandPreservesBusinessSingleFlight: true,
		});
		const executionId = randomUUID();
		const launchNonce = randomUUID();
		const artifactDirectory = taskCommandExecutionArtifactDirectory("workspace", executionId);
		const record = {
			workspaceId: "workspace",
			executionId,
			launchNonce,
			launchAttemptCount: 1,
			revocationFile: join(artifactDirectory, "execution-revocation.json"),
			specification,
		};
		const metadata = await stat(workingDirectory);
		const summary = {
			taskId: "session",
			workspacePath: workingDirectory,
			turnOwner: "agent",
			liveness: "live",
			userTurnKind: null,
			runtimeSessionIncarnationId: "session-generation",
		} as RuntimeTaskSessionSummary;
		const deliver = vi.fn<TaskCommandExecutionDependencies["deliver"]>(async (_record, validate, settled) => {
			await validate("before_first_transport_write");
			const receipt = { status: "delivered_and_submit_confirmed" as const, reason: null };
			await settled(receipt);
			return { ok: true, summary, terminalDelivery: receipt };
		});
		const launch = vi.fn<NonNullable<TaskCommandExecutionDependencies["launch"]>>(async () => {
			throw new Error("禁止再次派发已经存在的独立命令");
		});
		const service = createTaskCommandExecutionService({
			readOwner: async () => ({
				taskId: "task",
				taskIncarnationCreatedAtEpochMs: 1,
				conversationSessionId: "session",
				nativeSessionId: "native-session",
				worktreePath: workingDirectory,
				summary,
			}),
			park: async () => true,
			unpark: async () => undefined,
			deliver,
			launch,
			reconcileDelivery: async () => "unknown",
			listWorkspaceIds: async () => ["workspace"],
			warn: () => undefined,
		});
		try {
			await mkdir(artifactDirectory, { recursive: true });
			expect(await readTaskCommandExecutions("workspace")).toEqual([]);
			await launchOwnedCommandSupervisor(record, async () => undefined, { superviseProcessGroup: true });
			await vi.waitFor(async () => expect(await inspectOwnedCommandSupervisor(record)).toBe("running"), {
				timeout: 15_000,
			});
			const materials = await readFile(join(artifactDirectory, `launch-materials-${launchNonce}.json`));
			const adoption = {
				taskId: "task",
				idempotencyKey: "offline-run",
				specification,
				executionId,
				launchNonce,
				launchMaterialsSha256: createHash("sha256").update(materials).digest("hex"),
				expectedOwner: {
					taskIncarnationCreatedAtEpochMs: 1,
					conversationSessionId: "session",
					nativeSessionId: "native-session",
					runtimeSessionIncarnationId: "session-generation",
					worktreeIdentity: {
						realPath: workingDirectory,
						device: metadata.dev,
						inode: metadata.ino,
						createdAtEpochMs: metadata.birthtimeMs,
					},
				},
			};
			await writeFile(
				join(artifactDirectory, "pending-existing-supervisor-adoption.json"),
				JSON.stringify(adoption),
			);
			service.startRecovery();
			await vi.waitFor(
				async () =>
					expect((await service.inspect("workspace", { taskId: "task", executionId })).businessDisposition).toBe(
						"machine_evidence_pending",
					),
				{ timeout: 15_000 },
			);
			expect(deliver).not.toHaveBeenCalled();
			await writeFile(releaseFile, "条件恢复");
			await vi.waitFor(
				async () =>
					expect((await service.inspect("workspace", { taskId: "task", executionId })).resultDelivery?.state).toBe(
						"native_accepted",
					),
				{ timeout: 20_000 },
			);
			await service.sweepExecution("workspace", executionId);
			expect(launch).not.toHaveBeenCalled();
			expect(deliver).toHaveBeenCalledTimes(1);
			expect(await readFile(invocationFile, "utf8")).toBe("once");
		} finally {
			service.stop();
			await writeFile(record.revocationFile, JSON.stringify({ executionId, revokedAtEpochMs: Date.now() }));
			await cancelOwnedCommandProcesses({ ...record, previousLaunchNonces: [] });
			await vi.waitFor(async () => expect(await inspectOwnedCommandSupervisor(record)).toBe("exited"), {
				timeout: 15_000,
			});
			fixture.cleanup();
		}
	});
});

describe("通用监督者无 runtime 时的语义恢复", { timeout: 60_000 }, () => {
	it.each([
		"recover-after-supervisor-restart",
		"stop-before-recovery-dispatch",
		"resume-without-business-result",
		"terminal-result-without-dispatch",
	])("同一持久预算、无浏览器或 runtime：%s", async (scenario) => {
		const sandbox = createTempDir("owned-supervisor-semantic-recovery-");
		const resultFile = join(sandbox.path, "business-result.json");
		const attemptsFile = join(sandbox.path, "worker-attempt-count.txt");
		const evidenceFile = join(sandbox.path, "semantic-evidence.txt");
		const stopFile = join(sandbox.path, "owner-stop-observed.txt");
		const producerRevocationFile = join(sandbox.path, "producer-revocation.json");
		await writeFile(evidenceFile, "unavailable");
		const worker = [
			process.execPath,
			"-e",
			`
const fs=require('node:fs');
let attempts=0;try{attempts=Number(fs.readFileSync(${JSON.stringify(attemptsFile)},'utf8'));}catch{}
fs.writeFileSync(${JSON.stringify(attemptsFile)},String(attempts+1));
const ready=fs.readFileSync(${JSON.stringify(evidenceFile)},'utf8')==='ready';
fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({disposition:ready?'agent_review_ready':'machine_evidence_pending',recovery:ready?null:{action:'resume_same_run',retry_not_before_epoch_ms:0,maximum_unchanged_retries:1}}));
`,
		];
		const observation = [
			process.execPath,
			"-e",
			`
const fs=require('node:fs');const crypto=require('node:crypto');
process.stdout.write(JSON.stringify({evidenceSha256:crypto.createHash('sha256').update(fs.readFileSync(${JSON.stringify(evidenceFile)})).digest('hex')}));
`,
		];
		const validation = [
			process.execPath,
			"-e",
			`
const fs=require('node:fs');
if(fs.existsSync(${JSON.stringify(stopFile)})){fs.writeFileSync(${JSON.stringify(producerRevocationFile)},JSON.stringify({source:'persistent_owner_stop'}));process.exitCode=2;}
`,
		];
		const specification = taskCommandExecutionSpecificationSchema.parse({
			command: worker,
			resumeCommand: worker,
			resumeCommandPreservesBusinessSingleFlight: true,
			supervisorMaintainsSemanticRecovery: true,
			beforeSupervisorRecoveryDispatchValidationCommand: validation,
			workingDirectory: sandbox.path,
			resultFile,
			materialSha256: "a".repeat(64),
			label: "隔离语义恢复",
			producerExecutionRevocationFile: producerRevocationFile,
			readOnlyRecoveryEvidenceObservationCommand: observation,
			recoveryEvidenceObservationMode: "semantic_observation_only",
		});
		let record = {
			workspaceId: "isolated",
			executionId: randomUUID(),
			launchNonce: randomUUID(),
			launchAttemptCount: 1,
			previousLaunchNonces: [] as string[],
			revocationFile: join(sandbox.path, "execution-revocation.json"),
			specification,
		};
		const options = {
			artifactDirectory: sandbox.path,
			preventRedispatch: true,
			semanticRecoveryObservationIntervalMs: 20,
			deadlineAtEpochMs: Date.now() + 25_000,
		};
		const progress = async () =>
			JSON.parse(await readFile(join(sandbox.path, `supervisor-progress-${record.launchNonce}.json`), "utf8")) as {
				status: string;
				semanticRecoveryObservationCount?: number;
			};
		onTestFinished(async () => {
			await writeFile(record.revocationFile, "{}");
			await cancelOwnedCommandProcesses(record, options);
			for (const launchNonce of [...record.previousLaunchNonces, record.launchNonce])
				await vi.waitFor(
					async () =>
						expect(await inspectOwnedCommandSupervisor({ ...record, launchNonce }, options)).toBe("exited"),
					{
						timeout: 5_000,
					},
				);
			sandbox.cleanup();
		}, 30_000);
		if (scenario === "resume-without-business-result") {
			record = { ...record, launchAttemptCount: 2 };
			await writeFile(evidenceFile, "ready");
		}
		if (scenario === "terminal-result-without-dispatch") {
			record = { ...record, launchAttemptCount: 2 };
			await writeFile(resultFile, JSON.stringify({ disposition: "agent_review_ready" }));
		}
		await launchOwnedCommandSupervisor(record, async () => undefined, options);
		if (scenario === "terminal-result-without-dispatch") {
			await vi.waitFor(async () => expect(await inspectOwnedCommandSupervisor(record, options)).toBe("exited"), {
				timeout: 5_000,
			});
			expect((await progress()).status).toBe("exited");
			await expect(readFile(attemptsFile, "utf8")).rejects.toThrow();
			return;
		}
		if (scenario === "resume-without-business-result") {
			await vi.waitFor(
				async () => expect(JSON.parse(await readFile(resultFile, "utf8")).disposition).toBe("agent_review_ready"),
				{ timeout: 5_000 },
			);
			expect(await readFile(attemptsFile, "utf8")).toBe("1");
			return;
		}
		await vi.waitFor(
			async () => {
				expect(await readFile(attemptsFile, "utf8")).toBe("2");
				expect((await progress()).semanticRecoveryObservationCount).toBeGreaterThanOrEqual(3);
			},
			{ timeout: 10_000 },
		);
		if (scenario === "recover-after-supervisor-restart") {
			const identity = JSON.parse(
				await readFile(join(sandbox.path, `supervisor-identity-${record.launchNonce}.json`), "utf8"),
			) as OwnedProcessIdentity;
			expect(hasSameProcessGeneration(await readProcessIdentity(identity.pid), identity)).toBe(true);
			process.kill(identity.pid, "SIGTERM");
			await vi.waitFor(async () => expect(await inspectOwnedCommandSupervisor(record, options)).toBe("exited"), {
				timeout: 5_000,
			});
			record = {
				...record,
				launchNonce: randomUUID(),
				launchAttemptCount: 2,
				previousLaunchNonces: [...record.previousLaunchNonces, record.launchNonce],
			};
			await launchOwnedCommandSupervisor(record, async () => undefined, options);
			await vi.waitFor(
				async () => expect((await progress()).semanticRecoveryObservationCount).toBeGreaterThanOrEqual(3),
				{ timeout: 5_000 },
			);
			expect(await readFile(attemptsFile, "utf8")).toBe("2");
			await writeFile(evidenceFile, "ready");
			await vi.waitFor(
				async () => expect(JSON.parse(await readFile(resultFile, "utf8")).disposition).toBe("agent_review_ready"),
				{ timeout: 5_000 },
			);
			expect(await readFile(attemptsFile, "utf8")).toBe("3");
		} else {
			await writeFile(stopFile, "持久 Stop");
			await writeFile(evidenceFile, "ready");
			await vi.waitFor(async () => expect((await progress()).status).toBe("cancelled"), { timeout: 5_000 });
			expect(await readFile(attemptsFile, "utf8")).toBe("2");
		}
	});
});
