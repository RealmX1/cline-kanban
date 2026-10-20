import { describe, expect, it } from "vitest";
import {
	extractAgentNativeConversationSessionIdentityFromHookPayload,
	isSameAgentNativeConversationSessionIdentity,
} from "../../../../src/commands/hook-events/agent-native-conversation-session-identity-extraction";

// N0a：原生会话身份只认 hook 载荷里的 session_id（宁缺毋滥，不从路径反推）。

describe("extractAgentNativeConversationSessionIdentityFromHookPayload", () => {
	it("Claude Code 载荷（snake_case）→ 完整身份，来源规范化为小写", () => {
		expect(
			extractAgentNativeConversationSessionIdentityFromHookPayload({
				payload: {
					session_id: "a1b2",
					transcript_path: "/Users/dev/.claude/projects/-Users-dev-repo/a1b2.jsonl",
					hook_event_name: "Stop",
				},
				sourceAgentId: "Claude",
				observedAt: 42,
			}),
		).toEqual({
			sourceAgentId: "claude",
			nativeSessionId: "a1b2",
			transcriptPath: "/Users/dev/.claude/projects/-Users-dev-repo/a1b2.jsonl",
			observedAt: 42,
		});
	});

	it("camelCase 字段同样识别；transcript 缺省 → null", () => {
		expect(
			extractAgentNativeConversationSessionIdentityFromHookPayload({
				payload: { sessionId: "thread-9" },
				sourceAgentId: "claude",
				observedAt: 1,
			}),
		).toEqual({ sourceAgentId: "claude", nativeSessionId: "thread-9", transcriptPath: null, observedAt: 1 });
	});

	it.each([null, undefined, "", "   "])("Codex 后台记忆整理 hook 无持久转录（%s）时不建立主身份", (path) => {
		expect(
			extractAgentNativeConversationSessionIdentityFromHookPayload({
				sourceAgentId: "codex",
				payload: { session_id: "01a1592f-121b-7d31-9435-768bfffda4e8", transcript_path: path },
			}),
		).toBeUndefined();
	});

	it("正常 Codex SessionStart 仍记录首个持久身份，并保留路径内空格", () => {
		expect(
			extractAgentNativeConversationSessionIdentityFromHookPayload({
				sourceAgentId: "Codex",
				payload: { session_id: "main-1", transcriptPath: " /home/test  profile/rollout.jsonl " },
				observedAt: 9,
			}),
		).toEqual({
			sourceAgentId: "codex",
			nativeSessionId: "main-1",
			transcriptPath: "/home/test  profile/rollout.jsonl",
			observedAt: 9,
		});
	});

	it("缺 session id / 空白 session id / 无载荷 / 判不出来源 → 不产出身份", () => {
		expect(
			extractAgentNativeConversationSessionIdentityFromHookPayload({
				payload: { transcript_path: "/x/.claude/projects/p/s.jsonl" },
				sourceAgentId: "claude",
			}),
		).toBeUndefined();
		expect(
			extractAgentNativeConversationSessionIdentityFromHookPayload({
				payload: { session_id: "   " },
				sourceAgentId: "claude",
			}),
		).toBeUndefined();
		expect(
			extractAgentNativeConversationSessionIdentityFromHookPayload({ payload: null, sourceAgentId: "claude" }),
		).toBeUndefined();
		expect(
			extractAgentNativeConversationSessionIdentityFromHookPayload({
				payload: { session_id: "a1b2" },
				sourceAgentId: null,
			}),
		).toBeUndefined();
	});

	it("transcript 路径逐字保留内部空白（连续空格 / 制表符），只裁首尾空白；snake_case 与 camelCase 同样", () => {
		const transcriptPathWithInternalWhitespace = "/tmp/Claude  Profiles/projects/repo\twith-tab/session-1.jsonl";
		expect(
			extractAgentNativeConversationSessionIdentityFromHookPayload({
				payload: { session_id: "a1b2", transcript_path: `  ${transcriptPathWithInternalWhitespace}\n` },
				sourceAgentId: "claude",
				observedAt: 1,
			})?.transcriptPath,
		).toBe(transcriptPathWithInternalWhitespace);
		expect(
			extractAgentNativeConversationSessionIdentityFromHookPayload({
				payload: { sessionId: "a1b2", transcriptPath: transcriptPathWithInternalWhitespace },
				sourceAgentId: "claude",
				observedAt: 1,
			})?.transcriptPath,
		).toBe(transcriptPathWithInternalWhitespace);
	});

	it("transcript 路径为纯空白 → 视同缺省（null），不影响身份产出", () => {
		expect(
			extractAgentNativeConversationSessionIdentityFromHookPayload({
				payload: { session_id: "a1b2", transcript_path: "   " },
				sourceAgentId: "claude",
				observedAt: 1,
			}),
		).toEqual({ sourceAgentId: "claude", nativeSessionId: "a1b2", transcriptPath: null, observedAt: 1 });
	});

	it("observedAt 缺省时取当前时间", () => {
		const before = Date.now();
		const identity = extractAgentNativeConversationSessionIdentityFromHookPayload({
			payload: { session_id: "a1b2" },
			sourceAgentId: "claude",
		});
		expect(identity?.observedAt).toBeGreaterThanOrEqual(before);
	});
});

describe("isSameAgentNativeConversationSessionIdentity", () => {
	const identity = { sourceAgentId: "claude", nativeSessionId: "a1b2", transcriptPath: "/t.jsonl", observedAt: 1 };

	it("三个身份字段全等即相同（observedAt 不参与）", () => {
		expect(isSameAgentNativeConversationSessionIdentity({ ...identity, observedAt: 99 }, identity)).toBe(true);
	});

	it("任一身份字段不同 / 左侧为空 → 不同", () => {
		expect(isSameAgentNativeConversationSessionIdentity(null, identity)).toBe(false);
		expect(isSameAgentNativeConversationSessionIdentity(undefined, identity)).toBe(false);
		expect(isSameAgentNativeConversationSessionIdentity({ ...identity, nativeSessionId: "zz" }, identity)).toBe(
			false,
		);
		expect(isSameAgentNativeConversationSessionIdentity({ ...identity, transcriptPath: null }, identity)).toBe(false);
		expect(isSameAgentNativeConversationSessionIdentity({ ...identity, sourceAgentId: "codex" }, identity)).toBe(
			false,
		);
	});
});

it("子 agent 的 transcript 不能覆盖主会话原生身份", () => {
	expect(
		extractAgentNativeConversationSessionIdentityFromHookPayload({
			sourceAgentId: "codex",
			payload: { session_id: "parent", agent_id: "child", transcript_path: "/child.jsonl" },
		}),
	).toBeUndefined();
});
