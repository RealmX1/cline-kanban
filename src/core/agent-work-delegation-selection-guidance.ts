export const SAME_TASK_COLLABORATION_SESSION_CREATION_GUIDANCE =
	"Peer Session（task_collaborator）：承接与当前 Task 紧密相关且互补、适合共享当前 workspace/worktree 的独立协作线，能明显受益于用户单独查看、持续讨论和调整方向。只读旁支讨论可用 By the way。";

export const INDEPENDENT_TASK_CREATION_GUIDANCE =
	"新 Task：承接需要独立安排、跟踪和验收的工作，包括主线完成后的接续事项或与当前目标关联较弱的新发现。独立任务也可并行开展；需要等待前置成果时，记录依赖和接续条件。";

export const AGENT_WORK_DELEGATION_SELECTION_CAVEAT =
	"以上是选择时的参考建议。请在已有授权和权限边界内，结合实际目标、可用能力及协作成本自行判断。";

// EXPERIMENT_NODE: 设计 Task Force 时重新评估其与 Peer Session、By the way 的职责及替代或共存关系，目前尚未定案。
export function renderAgentWorkDelegationSelectionGuidance(): string {
	return `工作分流参考：
Subagent：承接当前会话内部的直接子任务 fan-out、并行调查、局部实现和独立复核，由当前会话调度并整合结果。
${SAME_TASK_COLLABORATION_SESSION_CREATION_GUIDANCE}
${INDEPENDENT_TASK_CREATION_GUIDANCE}
优先复用已有会话或任务；创建新的执行载体须有明确收益。${AGENT_WORK_DELEGATION_SELECTION_CAVEAT}`;
}
