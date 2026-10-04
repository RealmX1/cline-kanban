import { isHomeAgentSessionId } from "../core/home-agent-session";
import { findLiveKanbanBoardCardIdentityProjectionByWorkspaceAndTaskId } from "../inter-work-unit-relation-ledger/kanban-board-card-identity-projection-from-ledger-events";
import { readRecordedInterWorkUnitRelationProjectionOfActiveKanbanRuntimeLiveCapture } from "../inter-work-unit-relation-ledger/kanban-runtime-inter-work-unit-relation-ledger-live-capture-activation";
import { assembleRecordedRelationNeighborhoodSummaryOfWorkUnit } from "../inter-work-unit-relation-ledger/work-unit-relation-neighborhood-summary-assembly";
import { resolveAppendSystemPromptCommandPrefix } from "./append-system-prompt";

// dd2db 1b「会话启动时注入邻域摘要」：卡片会话启动时，若它与别的工作单元之间有默认可见的记录型关系
// （谁建了它、从谁的会话 fork / 采纳、谁改过它的需求、它建了谁……），把邻域摘要作为一段 append system prompt 注入。
// 只是启动那一刻的快照；agent 要最新的就跑 CLI。
//
// 绝不阻断会话启动：账本不可用、卡认不出、读超时一律退化为不注入。ACP 通道没有 system prompt 机制，不经过这里；
// Cline 通道已停止维护（AGENTS.md），不接。
// EXPERIMENT_NODE: 启动注入的读超时 2s——runtime 刚起时首读要全量重放账本（3484 实测约 0.6s），超时只是这次不注入。
const NEIGHBORHOOD_SUMMARY_READ_TIMEOUT_MS_AT_SESSION_START = 2_000;

export function renderInterWorkUnitRelationNeighborhoodAppendSystemPrompt(
	renderedNeighborhoodSummaryText: string,
	kanbanCommandPrefix: string,
): string {
	return `# Kanban Relations Of This Task

Kanban records how this task relates to other Kanban work units (task cards and standalone agent sessions): who created it, whose conversation session it forked or resumed, who amended its requirements, and which work units it acted on. Use it to find the context this task came from. This is a snapshot taken when the session started; refresh it with \`${kanbanCommandPrefix} work-unit get-relation-neighborhood-summary\`, and resolve any task id it mentions with \`${kanbanCommandPrefix} task get --task-id <id>\` (works across projects).

${renderedNeighborhoodSummaryText}`;
}

export async function resolveInterWorkUnitRelationNeighborhoodAppendSystemPrompt(input: {
	workspaceId: string | undefined;
	taskId: string;
}): Promise<string | null> {
	const workspaceId = input.workspaceId;
	if (!workspaceId || isHomeAgentSessionId(input.taskId)) {
		return null;
	}
	const neighborhoodSummaryText = readRecordedInterWorkUnitRelationProjectionOfActiveKanbanRuntimeLiveCapture(
		async (reader) => {
			// by-the-way 会话的 taskId 是会话 id 而不是卡 id，认不出卡就不注入。
			const cardProjection = findLiveKanbanBoardCardIdentityProjectionByWorkspaceAndTaskId(
				reader.projectionState.kanbanBoardCardIdentityProjectionState,
				workspaceId,
				input.taskId,
			);
			if (!cardProjection) {
				return null;
			}
			const neighborhood = await assembleRecordedRelationNeighborhoodSummaryOfWorkUnit(
				reader,
				cardProjection.kanbanBoardCard,
				() => null,
			);
			return neighborhood.hasAnyRelationVisibleByDefault ? neighborhood.renderedNeighborhoodSummaryText : null;
		},
	).catch(() => null);
	let readTimeout: ReturnType<typeof setTimeout> | undefined;
	const readTimedOut = new Promise<null>((resolve) => {
		readTimeout = setTimeout(() => resolve(null), NEIGHBORHOOD_SUMMARY_READ_TIMEOUT_MS_AT_SESSION_START);
	});
	try {
		const renderedNeighborhoodSummaryText = await Promise.race([neighborhoodSummaryText, readTimedOut]);
		return renderedNeighborhoodSummaryText
			? renderInterWorkUnitRelationNeighborhoodAppendSystemPrompt(
					renderedNeighborhoodSummaryText,
					resolveAppendSystemPromptCommandPrefix(),
				)
			: null;
	} finally {
		clearTimeout(readTimeout);
	}
}
