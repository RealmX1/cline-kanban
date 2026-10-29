import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeTaskSessionSummary } from "../../src/core/api-contract";
import {
	createTaskCommandExecutionService,
	type TaskCommandExecutionDependencies,
} from "../../src/task-command-execution/task-command-execution-service";
import {
	mutateTaskCommandExecutions,
	taskCommandExecutionArtifactDirectory,
} from "../../src/task-command-execution/task-command-execution-store";
import { inspectOwnedCommandSupervisor } from "../../src/task-command-execution/task-command-execution-supervisor";

const isolatedHome = vi.hoisted(() => ({ path: "" }));
vi.mock("../../src/state/workspace-state", () => ({
	getWorkspaceDirectoryPath: (workspaceId: string) => join(isolatedHome.path, workspaceId),
	getRuntimeHomePath: () => isolatedHome.path,
}));
let directory: string;
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "owned-command-supervisor-"));
	isolatedHome.path = directory;
});
afterEach(async () => {
	const artifacts = process.env.KANBAN_TASK_COMMAND_EXECUTION_TEST_EVIDENCE_DIRECTORY;
	if (artifacts) {
		await mkdir(artifacts, { recursive: true });
		await cp(directory, join(artifacts, basename(directory)), { recursive: true });
	}
	await rm(directory, { recursive: true, force: true });
});

function createService() {
	const summary = {
		taskId: "session",
		workspacePath: directory,
		turnOwner: "agent",
		liveness: "live",
		userTurnKind: null,
		runtimeSessionIncarnationId: randomUUID(),
		agentNativeConversationSessionIdentity: { nativeSessionId: "native-session" },
	} as RuntimeTaskSessionSummary;
	const deliver = vi.fn<TaskCommandExecutionDependencies["deliver"]>(async (_record, validate, settled) => {
		await validate("before_first_transport_write");
		const receipt = { status: "delivered_and_submit_confirmed" as const, reason: null };
		await settled(receipt);
		return { ok: true, summary, terminalDelivery: receipt };
	});
	const dependencies: TaskCommandExecutionDependencies = {
		readOwner: async () => ({
			taskId: "task",
			taskIncarnationCreatedAtEpochMs: 1,
			conversationSessionId: "session",
			nativeSessionId: "native-session",
			worktreePath: directory,
			summary,
		}),
		park: async () => true,
		unpark: async () => undefined,
		deliver,
		reconcileDelivery: async () => "unknown",
		listWorkspaceIds: async () => ["workspace"],
		warn: () => undefined,
	};
	return { dependencies, service: createTaskCommandExecutionService(dependencies), deliver };
}

describe("独立监督进程跨 runtime 恢复", { timeout: 30_000 }, () => {
	it("接管身份匹配的存活命令，快速结果只交回一次", async () => {
		const { service, dependencies, deliver } = createService();
		const resultFile = join(directory, "business-result.json");
		const invocationFile = join(directory, "invocations.txt");
		const command = [
			process.execPath,
			"-e",
			`require('node:fs').appendFileSync(${JSON.stringify(invocationFile)},'once');setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({disposition:'agent_review_ready',status:'ready_to_commit'})),1000)`,
		];
		let record = await service.start("workspace", {
			taskId: "task",
			idempotencyKey: "run",
			specification: {
				command,
				resumeCommand: command,
				resultFile,
				workingDirectory: directory,
				materialSha256: "a".repeat(64),
				label: "重启接管验证",
			},
		});
		try {
			await vi.waitFor(async () => expect(await inspectOwnedCommandSupervisor(record)).toBe("running"), {
				timeout: 10_000,
			});
			service.stop();
			await mutateTaskCommandExecutions("workspace", (records) => ({
				records: records.map((item) => ({ ...item, custodianRuntimeProcessInstanceId: randomUUID() })),
				result: undefined,
			}));
			const restarted = createTaskCommandExecutionService(dependencies);
			await vi.waitFor(
				async () => {
					await restarted.sweepExecution("workspace", record.executionId);
					record = await restarted.inspect("workspace", record);
					expect(record.resultDelivery?.state).toBe("native_accepted");
				},
				{ timeout: 12_000, interval: 100 },
			);
			expect(record.launchAttemptCount).toBe(1);
			expect((await readFile(invocationFile, "utf8")).split("\n").filter(Boolean)).toEqual(["once"]);
			expect(deliver).toHaveBeenCalledTimes(1);
			restarted.stop();
		} finally {
			await service.cancel("workspace", record);
		}
	});

	it("监督进程退出且无业务结果时恢复同一工作，退出码不冒充完成", async () => {
		const { service } = createService();
		const resultFile = join(directory, "business-result.json");
		const command = [process.execPath, "-e", "process.exit(0)"];
		let record = await service.start("workspace", {
			taskId: "task",
			idempotencyKey: "resume-run",
			specification: {
				command,
				resumeCommand: [
					process.execPath,
					"-e",
					`require('node:fs').writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({disposition:'agent_review_ready'}))`,
				],
				resultFile,
				workingDirectory: directory,
				materialSha256: "b".repeat(64),
				label: "机器重启等价恢复",
			},
		});
		try {
			await vi.waitFor(async () => expect(await inspectOwnedCommandSupervisor(record)).toBe("exited"), {
				timeout: 10_000,
			});
			await service.sweepExecution("workspace", record.executionId);
			await vi.waitFor(
				async () => {
					await service.sweepExecution("workspace", record.executionId);
					record = await service.inspect("workspace", record);
					expect(record.resultDelivery?.state).toBe("native_accepted");
				},
				{ timeout: 12_000, interval: 100 },
			);
			expect(record.launchAttemptCount).toBe(2);
		} finally {
			await service.cancel("workspace", record);
			service.stop();
		}
	});

	it("撤销在有界宽限后终止忽略 SIGTERM 的所属 CLI 与脱离进程组的后代", async () => {
		const { service } = createService();
		const childPidFile = join(directory, "descendant-pid.txt");
		const command = [
			process.execPath,
			"-e",
			`const child=require('node:child_process').spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{detached:true,stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(childPidFile)},String(child.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`,
		];
		const record = await service.start("workspace", {
			taskId: "task",
			idempotencyKey: "cancel-run",
			specification: {
				command,
				resumeCommand: command,
				resultFile: join(directory, "never-published.json"),
				workingDirectory: directory,
				materialSha256: "c".repeat(64),
				label: "取消所属后代",
			},
		});
		let childPid: number | null = null;
		try {
			await vi.waitFor(
				async () => {
					childPid = Number(await readFile(childPidFile, "utf8"));
					const progress = JSON.parse(
						await readFile(
							join(
								taskCommandExecutionArtifactDirectory("workspace", record.executionId),
								`supervisor-progress-${record.launchNonce}.json`,
							),
							"utf8",
						),
					) as { ownedProcesses: { pid: number }[] };
					expect(progress.ownedProcesses.some((item) => item.pid === childPid)).toBe(true);
				},
				{ timeout: 10_000 },
			);
			await service.cancel("workspace", record);
			await vi.waitFor(async () => expect(await inspectOwnedCommandSupervisor(record)).toBe("exited"), {
				timeout: 10_000,
			});
			expect((await service.inspect("workspace", record)).businessDisposition).toBe("cancelled");
		} finally {
			await service.cancel("workspace", record);
			service.stop();
			if (childPid) {
				try {
					process.kill(childPid, "SIGKILL");
				} catch {
					/* 已退出。 */
				}
			}
		}
	});
});
