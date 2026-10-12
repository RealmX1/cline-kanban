// 「这次续跑到底要接哪一段对话」的域逻辑：把一条既存会话的**续跑寻址方式**解析成三态之一。
//
// 存在理由（本模块修的是一个真实事故）：终端 agent 的续跑历史上一律走「工作目录下最近一段对话」——
// Claude 的 `--continue`、Codex 的 `resume --last`。这个寻址在「一个 cwd 只住着一条会话」时恰好正确，
// 而 Kanban 里有三种情形会让多条会话共用同一个 cwd：
//   ① 主会话与它的 By the way 侧问会话（按设计共用同一个 worktree）；
//   ② 同一仓库下多个 `worktreeMode: "inplace"` 的任务（全部解析到仓库根目录）；
//   ③ 侧边栏 home agent 会话（cwd = workspace 根）撞上任意 inplace 任务。
// 这三种情形下 cwd-latest 必然抢错对话：重启 A 会把 B 的对话接过来，两条会话就此纠缠。
//
// 正确的 key 其实早就记下来了但没被用起来：summary 的加性 sidecar
// `agentNativeConversationSessionIdentity`（来自 hook、托管扩展或 ACP 协议），由各 adapter 转为各自的按-ID 恢复参数。
//
// 与 `agent-session-transport-selection.ts` 同层：纯函数、无 IO、无进程状态，被 `src/terminal/` 与
// `src/trpc/` 共同消费。判定所需的一切事实由调用方查好后传进来。
//
// 与「建卡时的播种」（`card.taskAgentSessionInitialization`）的分工——两者语义正交，且支持的 harness 与 ID 格式不同，绝不可合并：
//   播种 = 「这张新卡要从**别人的**某段历史会话长出来」，是一次性的开局参数；
//   本模块 = 「这条**会话自己**上一世的对话在哪」，每次重启现算。
// 播种一旦被当作重启寻址用，从垃圾桶拖回来的任务会去续播种源的对话而不是它自己的。

import { canAgentResumeByRecordedNativeConversationSessionId } from "./agent-catalog";
import {
	type RuntimeAgentNativeConversationSessionIdentity,
	type RuntimeObservedAgentNativeConversationSessionResumeAddressing,
	runtimeObservedAgentNativeConversationSessionResumeAddressingSchema,
} from "./api-contract";

// 与本次启动共用同一个执行工作目录的**另一条**已知会话（不含本会话自己）。
// 调用方从 session 列表里按「已解析的 cwd 相等」筛出来，是否真的构成竞争由本模块判断。
export interface TaskConversationSessionSharingExecutionWorkingDirectory {
	taskConversationSessionId: string;
	// 该会话**实际跑起来过**的 agent；从未启动过的会话为 null（它不可能在这个 cwd 里留下转录）。
	agentId: string | null;
	// 仅用于组装拒绝文案，让用户一眼认出竞争者是谁。
	taskConversationSessionRole: "main" | "by_the_way" | null;
}

export type AgentConversationSessionResumeAddressing =
	| {
			kind: "addressed_by_observed_agent_native_session_id";
			// 直接喂给 adapter 的按-id 续跑轴。恒为 `resume_existing_session`：fork 会让 harness 新造一个
			// session id，而 sidecar 要到下一个 hook 事件才追得上，中间这段窗口里本会话的身份是错的，
			// 下一次重启又会去续被 fork 的那条源对话。只读约束由 `readOnlyQuestionSession` 独立保障，
			// 不靠 fork 来实现。
			taskAgentSessionInitialization: RuntimeObservedAgentNativeConversationSessionResumeAddressing;
	  }
	| {
			kind: "latest_agent_conversation_in_execution_working_directory";
			// 为什么退回到 cwd-latest 仍然是安全的（backward compatibility 的落点）。
			reason: "not_resuming_prior_agent_conversation" | "execution_working_directory_has_no_competing_session";
	  }
	| {
			kind: "refused_ambiguous_execution_working_directory";
			competingTaskConversationSessions: readonly TaskConversationSessionSharingExecutionWorkingDirectory[];
	  };

export interface AgentConversationSessionResumeAddressingResolutionInput {
	// 本次启动是否要重播既有对话。false = 全新开局，压根不该寻址。
	resumesPriorAgentConversation: boolean;
	// 本次要 spawn 的 agent。
	launchAgentId: string;
	// 本会话 summary 上的原生会话身份 sidecar（上一世由 hook 落下的）。
	observedAgentNativeConversationSessionIdentity: RuntimeAgentNativeConversationSessionIdentity | null | undefined;
	// 同 cwd 的其它已知会话（本会话自己已被调用方剔除）。
	taskConversationSessionsSharingExecutionWorkingDirectory: readonly TaskConversationSessionSharingExecutionWorkingDirectory[];
}

// 只有跑同一个 agent 的会话才会争抢同一份转录：`claude --continue` 看不见 codex 的 rollout，
// 反之亦然。从未启动过（agentId === null）的会话不可能留下转录，同样不算竞争者。
//
// 这条过滤是「拒绝」不至于误伤的关键：同一个仓库根目录下并存一条 claude inplace 任务和一条 codex
// inplace 任务是完全正常的，它们各自的 `--continue` 互不干扰，不该被拦下。
function selectCompetingTaskConversationSessions(
	input: AgentConversationSessionResumeAddressingResolutionInput,
): readonly TaskConversationSessionSharingExecutionWorkingDirectory[] {
	return input.taskConversationSessionsSharingExecutionWorkingDirectory.filter(
		(candidate) => candidate.agentId !== null && candidate.agentId === input.launchAgentId,
	);
}

export function resolveAgentConversationSessionResumeAddressing(
	input: AgentConversationSessionResumeAddressingResolutionInput,
): AgentConversationSessionResumeAddressing {
	// ① 不是续跑就不寻址。全新开局本来就该从空白开始，任何寻址都是错的。
	if (!input.resumesPriorAgentConversation) {
		return {
			kind: "latest_agent_conversation_in_execution_working_directory",
			reason: "not_resuming_prior_agent_conversation",
		};
	}
	const identity = input.observedAgentNativeConversationSessionIdentity;
	if (identity) {
		// 原生 ID 由 harness 报告；不把 Kimi 的 session_<UUID> 强制解析成 UUID。
		if (
			identity.sourceAgentId === input.launchAgentId &&
			canAgentResumeByRecordedNativeConversationSessionId(input.launchAgentId)
		) {
			const parsed = runtimeObservedAgentNativeConversationSessionResumeAddressingSchema.safeParse({
				sourceAgentId: identity.sourceAgentId,
				sourceSessionId: identity.nativeSessionId,
				sourceSessionReuseMode: "resume_existing_session",
			});
			if (!parsed.success)
				throw new Error("Recorded native conversation session ID is invalid; refusing latest-session fallback.");
			if (parsed.success) {
				return {
					kind: "addressed_by_observed_agent_native_session_id",
					taskAgentSessionInitialization: parsed.data,
				};
			}
		}
	}
	// ⑤ 按不了 id，就看这个 cwd 到底会不会猜错。
	//    独占 ⇒ 沿用今天的 cwd-latest，行为一行不变（全部历史数据与绝大多数任务走这一支）；
	//    被竞争 ⇒ 拒绝并如实列出竞争者，绝不赌「最近那一条恰好是我」。
	//    口径与仓库既有的「宁可停在已停止并如实报错，绝不静默降级」一致。
	const competingTaskConversationSessions = selectCompetingTaskConversationSessions(input);
	if (competingTaskConversationSessions.length === 0) {
		return {
			kind: "latest_agent_conversation_in_execution_working_directory",
			reason: "execution_working_directory_has_no_competing_session",
		};
	}
	return {
		kind: "refused_ambiguous_execution_working_directory",
		competingTaskConversationSessions,
	};
}

// 拒绝态的用户可读文案。放在这里而不是各调用方，是为了让服务端错误、日志与测试断言用的是同一句话。
export function describeRefusedAmbiguousExecutionWorkingDirectoryResumeAddressing(input: {
	launchAgentId: string;
	competingTaskConversationSessions: readonly TaskConversationSessionSharingExecutionWorkingDirectory[];
}): string {
	const competitors = input.competingTaskConversationSessions
		.map((session) =>
			session.taskConversationSessionRole
				? `${session.taskConversationSessionId} (${session.taskConversationSessionRole})`
				: session.taskConversationSessionId,
		)
		.join(", ");
	// 出路只准写**当前产品里真的走得通**的动作。这段文案已经错过两次，两次都是因为写了「听起来合理」
	// 而不是「验证过可达」的建议：
	//   ① 第一版写「先发一条消息让 id 被记下来再重启」——走到这条文案的前提恰恰是会话起不来，死循环；
	//   ② 第二版写「停掉/删掉竞争会话再重启」——TerminalSessionManager 全文没有 entries.delete，
	//      stopTaskSession 也不动 agentId 与 taskConversationSessionMetadata，而竞争判据的「会话对话族」
	//      那一支读的是持久化 metadata（跨运行时重启由 hydrateFromRecord 原样重建），
	//      且 app-router 里根本没有删除侧问会话的 procedure ⇒ 停掉竞争者不会让它离开竞争集合。
	// 现在只留两条经核对确实可达的：换去竞争会话里继续，或给本任务开一条全新会话。
	// 并说明这是过渡态：任何会话在新版本下跑过一轮就会记下 id，此后重启一律按 id、不再经过本闸门。
	return (
		`Cannot resume this ${input.launchAgentId} session safely: its working directory is shared with ` +
		`${input.competingTaskConversationSessions.length} other ${input.launchAgentId} session(s) — ${competitors} — ` +
		`and this session has no recorded agent session id to resume by. ` +
		`Resuming the most recent conversation in the working directory would pick up the wrong conversation, ` +
		`so this session was left untouched. ` +
		`Continue in one of the sessions listed above, or start a fresh session for this task. ` +
		`Any session that runs once on this version records its agent session id, after which restarting it resumes by id.`
	);
}
