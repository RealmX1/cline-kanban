import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { taskLookupConversationSchema } from "../../src/core/task-lookup-conversation-contract";
import { RUNTIME_PROCESS_INSTANCE_CONSIDERED_DEAD_AFTER_MS } from "../../src/state/runtime-process-instance-heartbeat-registry";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForChildProcessExit,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(() => children.sigkillEveryStillRunningChildProcessAndWaitForExit());
function waitForMessage(
	child: ChildProcess,
	matches: (message: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
	return new Promise((resolveMessage, reject) => {
		const cleanup = () => {
			clearTimeout(timeout);
			child.off("message", onMessage);
			child.off("exit", onExit);
			child.off("error", onError);
		};
		const onMessage = (message: unknown) => {
			if (!message || typeof message !== "object" || !matches(message as Record<string, unknown>)) return;
			cleanup();
			if ("error" in message) reject(new Error(String(message.error)));
			else resolveMessage(message as Record<string, unknown>);
		};
		const onExit = () => {
			cleanup();
			reject(new Error("隔离查卡进程提前退出"));
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		const timeout = setTimeout(() => {
			cleanup();
			reject(new Error("等待隔离查卡进程响应超时"));
		}, 30_000);
		child.on("message", onMessage);
		child.once("exit", onExit);
		child.once("error", onError);
	});
}
async function request(child: ChildProcess, operation: string, conversationId?: string) {
	const requestId = randomUUID();
	const response = waitForMessage(child, (message) => message.requestId === requestId);
	child.send({ requestId, operation, conversationId });
	return await response;
}
it("共享 HOME 的真实进程互不误中断，所属进程死亡后先保留宽限期再恢复", { timeout: 120000 }, async () => {
	const fixture = createIsolatedGitTestWorkspaceFixture();
	const storage = join(fixture.fixtureRootDirectoryPath, "shared-task-lookup-conversations");
	const start = async () => {
		const child = children.register(
			spawn(
				process.execPath,
				[
					"--import",
					"tsx",
					resolve("test/integration/task-lookup-execution-ownership-child-process-fixture.ts"),
					storage,
				],
				{
					cwd: process.cwd(),
					env: fixture.createIsolatedChildProcessEnvironment(),
					stdio: ["ignore", "ignore", "pipe", "ipc"],
				},
			),
		);
		child.stderr?.resume();
		const ready = await waitForMessage(child, (message) => message.kind === "ready");
		return { child, owner: String(ready.owningRuntimeProcessInstanceId) };
	};
	const first = await start();
	const started = taskLookupConversationSchema.parse((await request(first.child, "start")).conversation);
	const second = await start();
	const observed = taskLookupConversationSchema.parse(
		(await request(second.child, "read", started.conversationId)).conversation,
	);
	expect(observed.turns[0]).toMatchObject({ status: "running", owningRuntimeProcessInstanceId: first.owner });
	await request(first.child, "release");
	const completed = taskLookupConversationSchema.parse(
		(await request(second.child, "read", started.conversationId)).conversation,
	);
	expect(completed.turns[0]?.status).toBe("completed");
	const interrupted = taskLookupConversationSchema.parse((await request(first.child, "start")).conversation);
	first.child.kill("SIGKILL");
	expect(await waitForChildProcessExit(first.child, 5000)).toBe(true);
	expect(
		taskLookupConversationSchema.parse((await request(second.child, "read", interrupted.conversationId)).conversation)
			.turns[0]?.status,
	).toBe("running");
	const heartbeatPath = join(
		fixture.isolatedHomeDirectoryPath,
		".cline",
		"kanban",
		"runtime-process-instance-heartbeats",
		`${first.owner}.json`,
	);
	const heartbeat = JSON.parse(await readFile(heartbeatPath, "utf8"));
	await writeFile(
		heartbeatPath,
		JSON.stringify({
			...heartbeat,
			lastHeartbeatAtEpochMs: Date.now() - RUNTIME_PROCESS_INSTANCE_CONSIDERED_DEAD_AFTER_MS - 1,
		}),
	);
	const recovered = taskLookupConversationSchema.parse(
		(await request(second.child, "read", interrupted.conversationId)).conversation,
	);
	expect(recovered.turns[0]).toMatchObject({
		status: "interrupted",
		executionFailureDiagnostic: { reasonCode: "owning_runtime_unavailable", failedPhase: "recalling_candidates" },
	});
	await request(second.child, "close");
	expect(await waitForChildProcessExit(second.child, 5000)).toBe(true);
});
