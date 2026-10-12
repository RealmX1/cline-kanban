import type { RuntimeBoardCard, RuntimeTaskSessionStartRequest } from "./api-contract";

// 从看板卡片构造 `runtime.startTaskSession` 的请求：浏览器（use-task-sessions.ts 的 startTaskSession）、
// kanban CLI 与 `taskCardAction.*` 的服务端动作共用这一份字段映射。
//
// 为什么集中：此前 CLI 有一份手写映射（buildCliTaskSessionStartRequest），漏了 images / taskConversationMode /
// terminalAgentModelOverrideSettings——经 CLI 启动的卡静默丢掉附图、会话模式回落 operational、终端 agent 的
// 模型覆盖失效。字段以 runtimeTaskSessionStartRequestSchema 为准逐项核对；新增卡片上「启动时消费」的字段时
// 只改这里。
//
// 刻意**不**从卡片带的字段：
//   - requestedAgentSessionTransport：省略即由服务端按「卡片固化值 → 全局默认 → catalog 默认」解析，
//     显式传只属于通道切换 procedure；
//   - workspaceTaskId / taskConversationSessionMetadata：只属于 By the way 子会话；
//   - mode / resumePriorAgentConversationWithoutResendingPrompt / taskSessionStartOriginDeclaredByClient：
//     与卡片无关，是具体启动入口的声明。

export interface TaskSessionStartRequestHintsBeyondBoardCard {
	// 从 Done 恢复：续跑原对话，不重投 prompt / 附图，也不带「开局」语义的 startInPlanMode。
	resumeFromTrash?: boolean;
	// 浏览器按终端面板几何估出的 PTY 尺寸。TUI 在启动宽度下硬折行历史，之后 resize 修不回来，
	// 所以浏览器有几何时应随请求带上；CLI 没有就省略，由服务端用缺省尺寸。
	agentTerminalGeometryForTaskSessionSpawn?: { cols: number; rows: number };
}

export function buildTaskSessionStartRequestFromBoardCard(
	taskCard: RuntimeBoardCard,
	hints: TaskSessionStartRequestHintsBeyondBoardCard = {},
): RuntimeTaskSessionStartRequest {
	const resumeFromTrash = hints.resumeFromTrash === true;
	return {
		taskId: taskCard.id,
		prompt: resumeFromTrash ? "" : taskCard.prompt.trim(),
		taskTitle: taskCard.title,
		images: resumeFromTrash ? undefined : taskCard.images,
		startInPlanMode: resumeFromTrash ? undefined : taskCard.startInPlanMode,
		// 权限档位在续跑时同样适用（与 startInPlanMode 不同：那是「开局」语义，续跑没有开局）。
		taskAgentPermissionMode: taskCard.taskAgentPermissionMode,
		// 会话模式是「下次启动生效」的卡片声明：漏传 = 服务端静默掉回 operational 缺省。
		taskConversationMode: taskCard.taskConversationMode,
		...(resumeFromTrash ? { resumeFromTrash: true } : {}),
		baseRef: taskCard.baseRef,
		...(hints.agentTerminalGeometryForTaskSessionSpawn
			? {
					cols: hints.agentTerminalGeometryForTaskSessionSpawn.cols,
					rows: hints.agentTerminalGeometryForTaskSessionSpawn.rows,
				}
			: {}),
		agentId: taskCard.agentId,
		clineSettings: taskCard.clineSettings,
		terminalAgentModelOverrideSettings: taskCard.terminalAgentModelOverrideSettings,
		...(taskCard.parentSessionId ? { parentSessionId: taskCard.parentSessionId } : {}),
		...(taskCard.taskAgentSessionInitialization
			? { taskAgentSessionInitialization: taskCard.taskAgentSessionInitialization }
			: {}),
		...(taskCard.worktreeMode ? { worktreeMode: taskCard.worktreeMode } : {}),
		...(taskCard.prepFilePath ? { prepFilePath: taskCard.prepFilePath } : {}),
	};
}
