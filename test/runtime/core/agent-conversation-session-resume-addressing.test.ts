// 「这次续跑要接哪一段对话」的三态寻址。最要紧的三条不变量：
//  1. 有原生 session id 且该 harness 支持按-id 续跑 ⇒ 一律按 id，绝不落回 cwd-latest；
//  2. 按不了 id 时，cwd 独占才沿用 `--continue`（backward compatibility 的唯一落点）；
//  3. cwd 被同 agent 的其它会话竞争 ⇒ 拒绝并列出竞争者，绝不赌「最近那一条恰好是我」。
import { describe, expect, it } from "vitest";

import {
	type AgentConversationSessionResumeAddressingResolutionInput,
	describeRefusedAmbiguousExecutionWorkingDirectoryResumeAddressing,
	resolveAgentConversationSessionResumeAddressing,
	type TaskConversationSessionSharingExecutionWorkingDirectory,
} from "../../../src/core/agent-conversation-session-resume-addressing";

const OBSERVED_NATIVE_SESSION_ID = "6f1a0c9e-4f8b-4a2f-9b3c-2f4d5e6a7b8c";

function createInput(
	overrides: Partial<AgentConversationSessionResumeAddressingResolutionInput> = {},
): AgentConversationSessionResumeAddressingResolutionInput {
	return {
		resumesPriorAgentConversation: true,
		launchAgentId: "claude",
		observedAgentNativeConversationSessionIdentity: {
			sourceAgentId: "claude",
			nativeSessionId: OBSERVED_NATIVE_SESSION_ID,
			transcriptPath: "/tmp/transcript.jsonl",
			observedAt: 1_700_000_000_000,
		},
		taskConversationSessionsSharingExecutionWorkingDirectory: [],
		...overrides,
	};
}

const MAIN_SESSION_SHARING_WORKTREE: TaskConversationSessionSharingExecutionWorkingDirectory = {
	taskConversationSessionId: "card-1",
	agentId: "claude",
	taskConversationSessionRole: "main",
};

describe("agent conversation session resume addressing", () => {
	it("addresses by the observed native session id, resuming rather than forking", () => {
		const addressing = resolveAgentConversationSessionResumeAddressing(
			createInput({ taskConversationSessionsSharingExecutionWorkingDirectory: [MAIN_SESSION_SHARING_WORKTREE] }),
		);

		expect(addressing).toEqual({
			kind: "addressed_by_observed_agent_native_session_id",
			taskAgentSessionInitialization: {
				sourceAgentId: "claude",
				sourceSessionId: OBSERVED_NATIVE_SESSION_ID,
				// fork 会让 harness 新造 id、让 sidecar 持续漂移，下次重启就会去续被 fork 的源对话。
				sourceSessionReuseMode: "resume_existing_session",
			},
		});
	});

	it("does not address a fresh start at all", () => {
		const addressing = resolveAgentConversationSessionResumeAddressing(
			createInput({ resumesPriorAgentConversation: false }),
		);

		expect(addressing).toEqual({
			kind: "latest_agent_conversation_in_execution_working_directory",
			reason: "not_resuming_prior_agent_conversation",
		});
	});

	// 卡片换过 agent（或靠兜底救回时解析成了另一个 agent）之后，上一世的 claude session id
	// 拿去喂 codex 只会得到一个 not found。
	it("refuses to reuse a session id recorded by a different harness than the one being launched", () => {
		const addressing = resolveAgentConversationSessionResumeAddressing(
			createInput({
				launchAgentId: "codex",
				taskConversationSessionsSharingExecutionWorkingDirectory: [
					{ ...MAIN_SESSION_SHARING_WORKTREE, agentId: "codex" },
				],
			}),
		);

		expect(addressing.kind).toBe("refused_ambiguous_execution_working_directory");
	});

	it.each(["kimi", "omp"])("%s 使用原生 ID，不因共享目录回落到最近会话", (agentId) => {
		const nativeSessionId = agentId === "kimi" ? `session_${OBSERVED_NATIVE_SESSION_ID}` : OBSERVED_NATIVE_SESSION_ID;
		const addressing = resolveAgentConversationSessionResumeAddressing(
			createInput({
				launchAgentId: agentId,
				observedAgentNativeConversationSessionIdentity: {
					sourceAgentId: agentId,
					nativeSessionId,
					transcriptPath: null,
					observedAt: 1,
				},
				taskConversationSessionsSharingExecutionWorkingDirectory: [{ ...MAIN_SESSION_SHARING_WORKTREE, agentId }],
			}),
		);
		expect(addressing).toMatchObject({
			kind: "addressed_by_observed_agent_native_session_id",
			taskAgentSessionInitialization: { sourceSessionId: nativeSessionId },
		});
	});

	it("非法绑定不能静默回落最近会话", () => {
		expect(() =>
			resolveAgentConversationSessionResumeAddressing(
				createInput({
					observedAgentNativeConversationSessionIdentity: {
						sourceAgentId: "claude",
						nativeSessionId: "--continue",
						transcriptPath: null,
						observedAt: 1,
					},
				}),
			),
		).toThrow("refusing latest-session fallback");
	});

	// backward compatibility 的落点：老会话没有 sidecar，但它独占 cwd ⇒ 行为与今天一模一样。
	it("keeps today's cwd-latest resume when no id was recorded and the working directory is uncontested", () => {
		const addressing = resolveAgentConversationSessionResumeAddressing(
			createInput({ observedAgentNativeConversationSessionIdentity: null }),
		);

		expect(addressing).toEqual({
			kind: "latest_agent_conversation_in_execution_working_directory",
			reason: "execution_working_directory_has_no_competing_session",
		});
	});

	it("refuses when no id was recorded and the working directory is contested", () => {
		const addressing = resolveAgentConversationSessionResumeAddressing(
			createInput({
				observedAgentNativeConversationSessionIdentity: undefined,
				taskConversationSessionsSharingExecutionWorkingDirectory: [MAIN_SESSION_SHARING_WORKTREE],
			}),
		);

		expect(addressing).toEqual({
			kind: "refused_ambiguous_execution_working_directory",
			competingTaskConversationSessions: [MAIN_SESSION_SHARING_WORKTREE],
		});
	});

	// 同一个仓库根目录下并存一条 claude inplace 任务和一条 codex inplace 任务是完全正常的：
	// 它们各自的 `--continue` 互不干扰，拒绝不得误伤。
	it("does not treat sessions running a different agent, or never-launched sessions, as competitors", () => {
		const addressing = resolveAgentConversationSessionResumeAddressing(
			createInput({
				observedAgentNativeConversationSessionIdentity: null,
				taskConversationSessionsSharingExecutionWorkingDirectory: [
					{ taskConversationSessionId: "card-codex", agentId: "codex", taskConversationSessionRole: "main" },
					{ taskConversationSessionId: "card-never-started", agentId: null, taskConversationSessionRole: "main" },
				],
			}),
		);

		expect(addressing).toEqual({
			kind: "latest_agent_conversation_in_execution_working_directory",
			reason: "execution_working_directory_has_no_competing_session",
		});
	});

	it("names every competitor in the refusal message so the user can tell who is contesting the directory", () => {
		const message = describeRefusedAmbiguousExecutionWorkingDirectoryResumeAddressing({
			launchAgentId: "claude",
			competingTaskConversationSessions: [
				MAIN_SESSION_SHARING_WORKTREE,
				{
					taskConversationSessionId: "task-conversation-session-abc",
					agentId: "claude",
					taskConversationSessionRole: "by_the_way",
				},
			],
		});

		expect(message).toContain("card-1 (main)");
		expect(message).toContain("task-conversation-session-abc (by_the_way)");
		expect(message).toContain("no recorded agent session id");
		// 出路只准写**当前产品里真的走得通**的动作：换去竞争会话里继续，或给本任务开一条全新会话。
		// 「停掉/删掉竞争会话」做不到——manager 没有 entries.delete、stopTaskSession 不动
		// taskConversationSessionMetadata、也没有删除侧问会话的 procedure，停掉不会让它离开竞争集合。
		expect(message).toContain("start a fresh session");
		expect(message).not.toMatch(/stop|delete/iu);
	});
});
