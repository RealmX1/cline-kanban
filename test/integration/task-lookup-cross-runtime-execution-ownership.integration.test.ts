import { fork } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { taskLookupConversationSchema } from "../../src/core/task-lookup-conversation-contract";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { waitForConditionWithinLoadSensitiveTwoTierDeadline } from "../utilities/load-sensitive-wall-clock-two-tier-deadline";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	sigkillChildProcessAndWaitForExit,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const childProcesses = createSpawnedChildProcessRegistrySigkilledAfterEachTest();

it("两个独立进程共用隔离 HOME 时不误中断；归属崩溃后保留历史并允许显式重提", { timeout: 90000 }, async (context) => {
	const fixture = createIsolatedGitTestWorkspaceFixture();
	const waitUntil = async (description: string, condition: () => boolean | Promise<boolean>) => {
		await waitForConditionWithinLoadSensitiveTwoTierDeadline(
			context,
			{
				waitedForDescription: description,
				softDeadlineMsExpectedOnUncontendedHost: 3000,
				hardDeadlineMsOnlyExplainedByRealHangOrRegression: 20000,
			},
			condition,
		);
	};
	const startRuntime = async () => {
		const child = childProcesses.register(
			fork(
				fileURLToPath(new URL("./task-lookup-cross-runtime-execution-ownership-fixture.ts", import.meta.url)),
				[],
				{
					execArgv: ["--import", "tsx"],
					env: fixture.createIsolatedChildProcessEnvironment(),
					silent: true,
				},
			),
		);
		child.stdout?.resume();
		child.stderr?.resume();
		let ownerId = "";
		let sequence = 0;
		const replies = new Map<number, { value?: unknown; error?: string }>();
		child.on(
			"message",
			(message: { event?: string; ownerId?: string; requestId?: number; value?: unknown; error?: string }) => {
				if (message.event === "ready") ownerId = message.ownerId ?? "";
				if (message.requestId !== undefined) replies.set(message.requestId, message);
			},
		);
		await waitUntil("隔离查卡进程启动", () => ownerId.length > 0);
		return {
			child,
			ownerId,
			request: async (operation: string, input?: unknown) => {
				const requestId = ++sequence;
				child.send({ requestId, operation, input });
				await waitUntil("隔离查卡进程返回结果", () => replies.has(requestId));
				const reply = replies.get(requestId);
				if (reply?.error) throw new Error(reply.error);
				return taskLookupConversationSchema.parse(reply?.value);
			},
		};
	};
	const runtimeHome = join(fixture.isolatedHomeDirectoryPath, ".cline", "kanban");
	const releasePath = join(runtimeHome, "allow-task-lookup-model-execution-to-complete");
	const first = await startRuntime();
	const conversation = await first.request("create");
	await first.request("submit", {
		conversationId: conversation.conversationId,
		requestId: "first",
		questionText: "第一轮",
	});
	const second = await startRuntime();
	expect((await second.request("get", conversation.conversationId)).turns[0]?.status).toBe("running");
	await writeFile(releasePath, "complete");
	await waitUntil(
		"首个进程正常完成查询",
		async () => (await second.request("get", conversation.conversationId)).turns[0]?.status === "completed",
	);
	await rm(releasePath);
	await first.request("submit", {
		conversationId: conversation.conversationId,
		requestId: "crashed",
		questionText: "会崩溃的第二轮",
	});
	expect(await sigkillChildProcessAndWaitForExit(first.child)).toBe(true);
	expect((await second.request("get", conversation.conversationId)).turns[1]?.status).toBe("running");
	// 已确认进程退出；推进该隔离心跳的年龄，无须在测试里空等两分钟宽限期。
	const heartbeatPath = join(runtimeHome, "runtime-process-instance-heartbeats", `${first.ownerId}.json`);
	const heartbeat = JSON.parse(await readFile(heartbeatPath, "utf8"));
	await writeFile(heartbeatPath, JSON.stringify({ ...heartbeat, lastHeartbeatAtEpochMs: 0 }));
	expect((await second.request("get", conversation.conversationId)).turns[1]?.status).toBe("interrupted");
	await writeFile(releasePath, "complete");
	await second.request("submit", {
		conversationId: conversation.conversationId,
		requestId: "explicit-retry",
		questionText: "会崩溃的第二轮",
	});
	await waitUntil(
		"后继进程完成显式重新提问",
		async () => (await second.request("get", conversation.conversationId)).turns[2]?.status === "completed",
	);
	expect((await second.request("get", conversation.conversationId)).turns.map((turn) => turn.status)).toEqual([
		"completed",
		"interrupted",
		"completed",
	]);
});
