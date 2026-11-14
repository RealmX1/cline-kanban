import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { getRuntimeFetch } from "../../../src/core/runtime-endpoint";
import { taskCommandExecutionRecordSchema } from "../../../src/core/task-command-execution-contract";
import { startPreparedLocalRedeployment } from "../../../src/deployment/local-redeployment-owned-execution";
import {
	assertLocalRedeploymentOwnerStillEligible,
	createLocalRedeploymentOwnedCommandSpecification,
	type FrozenLocalRedeploymentRequest,
	readFrozenLocalRedeploymentRequest,
} from "../../../src/deployment/local-redeployment-preparation";
import {
	observeLocalRedeploymentRuntimeBaseline,
	observeStandardLocalRedeploymentRecoveryEvidence,
} from "../../../src/deployment/local-redeployment-standard-execution";
import { lockedFileSystem } from "../../../src/fs/locked-file-system";
import { readRuntimeProcessInstanceLiveness } from "../../../src/state/runtime-process-instance-heartbeat-registry";
import {
	mutateTaskCommandExecutions,
	readTaskCommandExecutions,
	taskCommandExecutionArtifactDirectory,
} from "../../../src/task-command-execution/task-command-execution-store";
import {
	inspectOwnedCommandSupervisor,
	launchOwnedCommandSupervisor,
} from "../../../src/task-command-execution/task-command-execution-supervisor";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

vi.mock("../../../src/core/runtime-endpoint", () => ({ getRuntimeFetch: vi.fn() }));
vi.mock("../../../src/deployment/local-redeployment-preparation", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	readFrozenLocalRedeploymentRequest: vi.fn(),
	assertLocalRedeploymentOwnerStillEligible: vi.fn(),
}));
vi.mock("../../../src/deployment/local-redeployment-standard-execution", () => ({
	observeLocalRedeploymentRuntimeBaseline: vi.fn(),
	observeStandardLocalRedeploymentRecoveryEvidence: vi.fn(),
}));
vi.mock("../../../src/state/runtime-process-instance-heartbeat-registry", () => ({
	readRuntimeProcessInstanceLiveness: vi.fn(),
}));
vi.mock("../../../src/task-command-execution/task-command-execution-store", () => ({
	readTaskCommandExecutions: vi.fn(),
	mutateTaskCommandExecutions: vi.fn(),
	taskCommandExecutionArtifactDirectory: (_workspaceId: string, executionId: string) =>
		join(process.env.HOME ?? "", "supervisor-artifacts", executionId),
}));
vi.mock("../../../src/task-command-execution/task-command-execution-supervisor", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	inspectOwnedCommandSupervisor: vi.fn(),
	launchOwnedCommandSupervisor: vi.fn(),
}));

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.unstubAllEnvs());

async function prepareIsolatedRedeployment() {
	const fixture = createIsolatedGitTestWorkspaceFixture();
	onTestFinished(fixture.cleanup);
	vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
	const directory = join(fixture.fixtureRootDirectoryPath, "persistent-redeployment");
	await mkdir(directory);
	const frozen: FrozenLocalRedeploymentRequest = {
		request: {
			schemaVersion: 1,
			executionId: "032609d8-7508-4bdc-b202-1d7bd7da8a14",
			workspaceId: "workspace",
			taskId: "task",
			originatingTaskWorktreePath: fixture.fixtureRootDirectoryPath,
			sourceCheckoutPath: fixture.fixtureRootDirectoryPath,
			candidateSourceCommit: "a".repeat(40),
			deploymentNodeBinaryPath: process.execPath,
			distributionDirectoryPath: join(fixture.fixtureRootDirectoryPath, "distribution"),
			runtimeIdentity: {
				runtimeHomeDirectoryPath: join(fixture.isolatedHomeDirectoryPath, ".cline/kanban"),
				runtimeHost: "127.0.0.1",
				runtimePort: 39884,
			},
			serviceLaunch: { command: [process.execPath] },
			authorization: { sourceReference: "test:isolated", userRequestQuote: "仅隔离部署" },
		},
		requestSha256: "b".repeat(64),
		executorSha256: "c".repeat(64),
		npmCliEntrypointPath: join(fixture.fixtureRootDirectoryPath, "npm-cli.js"),
		serviceExecutableSha256: "d".repeat(64),
		owner: {
			taskIncarnationCreatedAtEpochMs: 1,
			conversationSessionId: "task-session",
			nativeSessionId: "native-session",
			runtimeSessionIncarnationId: "session-generation",
			worktreeIdentity: { realPath: fixture.fixtureRootDirectoryPath, device: 1, inode: 1, createdAtEpochMs: 1 },
		},
	};
	const specification = createLocalRedeploymentOwnedCommandSpecification(directory, frozen);
	await writeFile(join(directory, "owned-command-specification.json"), JSON.stringify(specification));
	vi.mocked(readFrozenLocalRedeploymentRequest).mockResolvedValue(frozen);
	vi.mocked(assertLocalRedeploymentOwnerStillEligible).mockResolvedValue(undefined);
	vi.mocked(readTaskCommandExecutions).mockResolvedValue([]);
	vi.mocked(readRuntimeProcessInstanceLiveness).mockResolvedValue("dead");
	vi.mocked(inspectOwnedCommandSupervisor).mockResolvedValue("not_started");
	vi.mocked(observeLocalRedeploymentRuntimeBaseline).mockResolvedValue({
		state: "verified_offline",
		runtimeBefore: null,
		listenerObservation: "connection_refused_and_no_listener",
		systemBootIdentity: "current-boot",
	});
	vi.mocked(observeStandardLocalRedeploymentRecoveryEvidence).mockResolvedValue({ evidenceSha256: "e".repeat(64) });
	const registered = taskCommandExecutionRecordSchema.parse({
		workspaceId: "workspace",
		taskId: "task",
		executionId: "132609d8-7508-4bdc-b202-1d7bd7da8a14",
		idempotencyKey: `local-redeployment:${frozen.request.executionId}`,
		taskIncarnationCreatedAtEpochMs: frozen.owner?.taskIncarnationCreatedAtEpochMs,
		originatingConversationSessionId: frozen.owner?.conversationSessionId,
		originatingNativeSessionId: frozen.owner?.nativeSessionId,
		originatingRuntimeSessionIncarnationId: frozen.owner?.runtimeSessionIncarnationId,
		worktreeIdentity: frozen.owner?.worktreeIdentity,
		specification,
		revokedAtEpochMs: null,
		launchAttemptCount: 1,
		launchNonce: "232609d8-7508-4bdc-b202-1d7bd7da8a14",
		previousLaunchNonces: [],
		custodianRuntimeProcessInstanceId: "332609d8-7508-4bdc-b202-1d7bd7da8a14",
		revocationFile: join(fixture.isolatedHomeDirectoryPath, "registered-revocation.json"),
		materialSha256: "f".repeat(64),
		createdAtEpochMs: 1,
		updatedAtEpochMs: 1,
		launchState: "exited",
		revokedLaunchAttemptCount: null,
		revokedResultWriteAttemptCount: null,
		businessDisposition: null,
		progress: null,
		recovery: null,
		lastRecoveryEvidenceSha256: null,
		unchangedRecoveryAttemptCount: 0,
		nextRecoveryAtEpochMs: null,
		parkOwned: false,
		logicalResultCount: 0,
		resultDelivery: null,
		cancellationObservation: null,
	});
	return { directory, frozen, specification, registered };
}

describe("冻结所属执行的在线登记、离线恢复与最后 Stop 门禁", () => {
	it("在线登记提交准备时冻结的完整 owner", async () => {
		const context = await prepareIsolatedRedeployment();
		vi.mocked(observeLocalRedeploymentRuntimeBaseline).mockResolvedValue({
			state: "verified_online",
			runtimeBefore: { processId: 12345, processStartTimeText: "Fri Nov 13 12:00:00 2026" },
		});
		const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
		vi.mocked(getRuntimeFetch).mockResolvedValue(fetch);
		await startPreparedLocalRedeployment(context.directory);
		expect(JSON.parse(fetch.mock.calls[0]?.[1].body).expectedOwner).toEqual(context.frozen.owner);
		expect(launchOwnedCommandSupervisor).not.toHaveBeenCalled();
	});

	it("已有在线登记在原 runtime 和监督者退出后按原 executionId 接续", async () => {
		const context = await prepareIsolatedRedeployment();
		vi.mocked(readTaskCommandExecutions).mockResolvedValue([context.registered]);
		vi.mocked(inspectOwnedCommandSupervisor).mockResolvedValue("exited");
		vi.mocked(mutateTaskCommandExecutions).mockImplementation(
			async (_workspaceId, mutation) => (await mutation([context.registered])).result,
		);
		await startPreparedLocalRedeployment(context.directory);
		const dispatched = vi.mocked(launchOwnedCommandSupervisor).mock.calls[0]?.[0];
		expect(dispatched?.executionId).toBe(context.registered.executionId);
		expect(dispatched?.launchNonce).not.toBe(context.registered.launchNonce);
		expect(dispatched?.launchAttemptCount).toBe(2);
		expect(mutateTaskCommandExecutions).toHaveBeenCalledTimes(1);
	});

	it.each(["running", "unknown"] as const)("已有监督状态 %s 时不派发第二个执行者", async (status) => {
		const context = await prepareIsolatedRedeployment();
		vi.mocked(readTaskCommandExecutions).mockResolvedValue([context.registered]);
		vi.mocked(inspectOwnedCommandSupervisor).mockResolvedValue(status);
		await startPreparedLocalRedeployment(context.directory);
		expect(launchOwnedCommandSupervisor).not.toHaveBeenCalled();
		expect(mutateTaskCommandExecutions).not.toHaveBeenCalled();
	});

	it("入口检查后出现持久 Stop，最后 launch 校验仍阻止实际派发", async () => {
		const context = await prepareIsolatedRedeployment();
		vi.mocked(assertLocalRedeploymentOwnerStillEligible)
			.mockResolvedValueOnce(undefined)
			.mockRejectedValue(new Error("原会话持久 Stop 继续有效"));
		let actualDispatchCount = 0;
		vi.mocked(launchOwnedCommandSupervisor).mockImplementation(async (_record, validate) => {
			await validate();
			actualDispatchCount++;
		});
		await expect(startPreparedLocalRedeployment(context.directory)).rejects.toThrow("持久 Stop");
		expect(actualDispatchCount).toBe(0);
	});

	it("Stop 发生于 pending adoption 原件发布期间，发布后重查仍阻止实际派发", async () => {
		const context = await prepareIsolatedRedeployment();
		const artifactDirectory = taskCommandExecutionArtifactDirectory("workspace", context.frozen.request.executionId);
		const pendingAdoptionPath = join(artifactDirectory, "pending-existing-supervisor-adoption.json");
		let ownerStopped = false;
		let actualDispatchCount = 0;
		vi.mocked(assertLocalRedeploymentOwnerStillEligible).mockImplementation(async () => {
			if (ownerStopped) throw new Error("原会话持久 Stop 继续有效");
		});
		const actualAtomicWrite = lockedFileSystem.writeJsonFileAtomic.bind(lockedFileSystem);
		const atomicWrite = vi
			.spyOn(lockedFileSystem, "writeJsonFileAtomic")
			.mockImplementation(async (path, value, options) => {
				if (path === pendingAdoptionPath) {
					expect(existsSync(pendingAdoptionPath)).toBe(false);
					ownerStopped = true;
				}
				await actualAtomicWrite(path, value, options);
			});
		vi.mocked(launchOwnedCommandSupervisor).mockImplementation(async (record, validate) => {
			await validate();
			await mkdir(artifactDirectory, { recursive: true });
			await writeFile(join(artifactDirectory, `launch-materials-${record.launchNonce}.json`), "{}");
			await validate();
			actualDispatchCount++;
		});
		try {
			await expect(startPreparedLocalRedeployment(context.directory)).rejects.toThrow("持久 Stop");
			expect(existsSync(pendingAdoptionPath)).toBe(true);
			expect(actualDispatchCount).toBe(0);
		} finally {
			atomicWrite.mockRestore();
		}
	});
});
