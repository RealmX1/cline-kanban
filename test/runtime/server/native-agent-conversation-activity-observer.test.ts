import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	NativeAgentConversationActivityReadResult,
	ReadNativeAgentConversationActivityInput,
} from "../../../src/agent-session-history/native-agent-conversation-activity-reader";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { applySessionFacets } from "../../../src/core/session-activity";
import { createNativeAgentConversationActivityObserver } from "../../../src/server/native-agent-conversation-activity-observer";

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function transcriptFixture() {
	const directory = await mkdtemp(join(tmpdir(), "kanban-native-accepted-observer-"));
	directories.push(directory);
	const transcriptPath = join(directory, "main.jsonl");
	await writeFile(transcriptPath, "");
	const summary = applySessionFacets({
		taskId: "conversation-main",
		state: "idle",
		agentId: "claude",
		workspacePath: directory,
		pid: 12,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		runtimeSessionIncarnationId: "incarnation-1",
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "claude",
			nativeSessionId: "main",
			transcriptPath,
			observedAt: 1,
		},
	});
	return { transcriptPath, summary };
}

function userRecord(uuid: string) {
	return {
		type: "user",
		promptSource: "typed",
		sessionId: "main",
		uuid,
		timestamp: "2026-10-22T10:00:00Z",
		message: { role: "user", content: "相同正文" },
	};
}

describe("原生会话的可靠输入接受边沿", () => {
	it("初始化只建基线；新增真实用户记录立即确认，重复正文按原生消息身份区分", async () => {
		const { transcriptPath, summary } = await transcriptFixture();
		await appendFile(transcriptPath, `${JSON.stringify(userRecord("old"))}\n`);
		const onAccepted = vi.fn();
		const observer = createNativeAgentConversationActivityObserver({
			onAccepted,
			cooldownMs: 0,
			nowMs: () => Date.parse("2026-10-22T09:00:00Z"),
		});
		await observer.observeTaskSessionSummary("workspace", summary, () => summary);
		expect(onAccepted).not.toHaveBeenCalled();
		await appendFile(transcriptPath, `${JSON.stringify(userRecord("new-1"))}\n`);
		await observer.observeTaskSessionSummary("workspace", summary, () => summary);
		expect(onAccepted).toHaveBeenCalledTimes(1);
		expect(onAccepted.mock.calls[0]?.[0]).toMatchObject({
			conversationSessionId: "conversation-main",
			nativeSessionId: "main",
			evidenceKind: "native_user_prompt_acceptance",
			eventId: "claude:main:new-1",
		});
		await appendFile(transcriptPath, `${JSON.stringify(userRecord("new-2"))}\n`);
		await observer.observeTaskSessionSummary("workspace", summary, () => summary);
		expect(onAccepted).toHaveBeenCalledTimes(2);
		observer.dispose();
	});

	it("工具结果、侧链、系统通知、压缩摘要和 synthetic 输入不能确认用户提交", async () => {
		const { transcriptPath, summary } = await transcriptFixture();
		const onAccepted = vi.fn();
		const observer = createNativeAgentConversationActivityObserver({
			onAccepted,
			cooldownMs: 0,
			nowMs: () => Date.parse("2026-10-22T09:00:00Z"),
		});
		await observer.observeTaskSessionSummary("workspace", summary, () => summary);
		const records = [
			{ ...userRecord("tool"), message: { role: "user", content: [{ type: "tool_result", content: "done" }] } },
			{ ...userRecord("sidechain"), isSidechain: true },
			{ ...userRecord("synthetic"), synthetic: true },
			{ ...userRecord("summary"), isCompactSummary: true },
			{ ...userRecord("notice"), message: { role: "user", content: "<task-notification>完成</task-notification>" } },
			{
				...userRecord("notice-with-image"),
				message: {
					role: "user",
					content: [
						{ type: "text", text: "<task-notification>完成</task-notification>" },
						{ type: "image", source: { type: "base64", data: "fixture" } },
					],
				},
			},
		];
		await appendFile(transcriptPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
		await observer.observeTaskSessionSummary("workspace", summary, () => summary);
		expect(onAccepted).not.toHaveBeenCalled();
		observer.dispose();
	});

	it.each(["incarnation", "native_session", "transcript_path"])(
		"原生查询期间 %s 已替换时丢弃旧结果",
		async (change) => {
			const { summary } = await transcriptFixture();
			const onAccepted = vi.fn();
			let current: RuntimeTaskSessionSummary = summary;
			let release: ((value: NativeAgentConversationActivityReadResult) => void) | undefined;
			const readNativeActivity = vi.fn(
				() =>
					new Promise<NativeAgentConversationActivityReadResult>((resolve) => {
						release = resolve;
					}),
			);
			const observer = createNativeAgentConversationActivityObserver({ onAccepted, readNativeActivity });
			const pending = observer.observeTaskSessionSummary("workspace", summary, () => current);
			await vi.waitFor(() => expect(readNativeActivity).toHaveBeenCalledTimes(1));
			current =
				change === "incarnation"
					? { ...summary, runtimeSessionIncarnationId: "incarnation-replaced" }
					: {
							...summary,
							agentNativeConversationSessionIdentity: {
								sourceAgentId: "claude",
								nativeSessionId: change === "native_session" ? "replacement" : "main",
								transcriptPath:
									change === "transcript_path" ? "/isolated/replacement.jsonl" : "/isolated/main.jsonl",
								observedAt: 1,
							},
						};
			release?.({
				events: [
					{
						activityKind: "accepted_user_input",
						observedAtMs: 2,
						evidenceKind: "native_user_prompt_acceptance",
						eventId: "old-query",
						nativeSessionId: "main",
					},
				],
				cursor: { transport: "codex_control", predecessorTurnId: "turn", seenEventIds: [] },
			});
			await pending;
			expect(onAccepted).not.toHaveBeenCalled();
			observer.dispose();
		},
	);

	it("下游接受处理失败时不提交游标，下一次核验可重试同一原生事件", async () => {
		const { summary } = await transcriptFixture();
		const onAccepted = vi.fn().mockRejectedValueOnce(new Error("暂时无法保存卡片")).mockResolvedValue(undefined);
		const onReadFailed = vi.fn();
		const readNativeActivity = vi.fn(
			async (
				_input: ReadNativeAgentConversationActivityInput,
			): Promise<NativeAgentConversationActivityReadResult> => ({
				events: [
					{
						observedAtMs: 2,
						activityKind: "accepted_user_input",
						evidenceKind: "native_user_prompt_acceptance",
						eventId: "same-event",
						nativeSessionId: "main",
					},
				],
				cursor: { transport: "codex_control", predecessorTurnId: "turn", seenEventIds: ["same-event"] },
			}),
		);
		const observer = createNativeAgentConversationActivityObserver({
			onAccepted,
			onReadFailed,
			readNativeActivity,
			cooldownMs: 0,
		});
		await observer.observeTaskSessionSummary("workspace", summary, () => summary);
		await observer.observeTaskSessionSummary("workspace", summary, () => summary);
		expect(onAccepted).toHaveBeenCalledTimes(2);
		expect(onReadFailed).toHaveBeenCalledTimes(1);
		expect(readNativeActivity.mock.calls.map(([input]) => input.cursor)).toEqual([null, null]);
		observer.dispose();
	});
});
