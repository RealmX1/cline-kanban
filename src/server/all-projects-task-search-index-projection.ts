import type {
	RuntimeAllProjectsTaskSearchIndexResponse,
	RuntimeBoardData,
	RuntimeTaskSessionSummary,
} from "../core/api-contract";
import { isNeverStartedPlaceholderTaskSessionSummary } from "../core/session-activity";

/** 每个注册项目的原始输入：projectId + 展示名 + 已加载的 board（加载失败为 null，将被跳过）+ 各任务的对话推进时刻。 */
export interface AllProjectsTaskSearchIndexProjectInput {
	projectId: string;
	projectName: string;
	board: RuntimeBoardData | null;
	/** taskId → 对话上次推进时刻（epoch ms）；没有条目的任务投影为 null。 */
	agentConversationProgressObservedAtByTaskId: ReadonlyMap<string, number>;
}

/**
 * 把一个已加载项目「此刻 runtime 内存里的会话摘要」覆盖到「盘上 sessions.json」读出的对话推进时刻上。
 *
 * 已加载项目的内存摘要是权威：hydrate 时内存拷入了盘上全部摘要，此后盘上只由内存落盘（saveState / 关停）写入，
 * 所以盘上值只会是内存某个旧版本。**不能取两路较大者**——这个量并非严格单调：非 agent 回合里持久转录可以把
 * 低置信的 TUI 猜测往回纠（`mergeLastConversationProgressObservation` 唯一允许回退的路径），Cline / ACP 重建
 * 摘要与清空会话则整条替换、不带该字段。落盘前的窗口里取 max 会把 reducer 刻意拉回 / 清掉之前的过新值捡回来。
 *
 * 逐条 live 摘要：
 * - 未启动空壳（前端一聚焦卡片 `ensureEntry` 就地造出的全 null 占位）而盘上有该任务的值 → 保留盘上值。
 *   空壳携带的信息严格少于任何真实记录，与看板快照守卫（workspace-registry `buildWorkspaceStateSnapshot`）、
 *   落盘守卫（workspace-state `preservePersistedTaskSessionFactsAgainstStaleSnapshots`）同一口径；
 * - 其余摘要有推进时刻 → 直接覆盖；没有 → 从结果中删除（投影为 null，与该项目自己看板上的卡片、以及下一次
 *   落盘后的盘上终态一致，不会「先显示旧值、落盘后才消失」）。
 *
 * 内存里没有摘要的任务（未加载项目整体如此）沿用盘上值。返回新 Map，不改入参（入参可能是读取器的缓存表）。
 */
export function overlayLiveRuntimeSessionSummariesOntoPersistedAgentConversationProgressObservedAtByTaskId({
	persistedAgentConversationProgressObservedAtByTaskId,
	liveRuntimeSessionSummaries,
}: {
	persistedAgentConversationProgressObservedAtByTaskId: ReadonlyMap<string, number>;
	liveRuntimeSessionSummaries: ReadonlyArray<RuntimeTaskSessionSummary>;
}): Map<string, number> {
	const overlaidAgentConversationProgressObservedAtByTaskId = new Map(
		persistedAgentConversationProgressObservedAtByTaskId,
	);
	for (const liveRuntimeSessionSummary of liveRuntimeSessionSummaries) {
		const taskId = liveRuntimeSessionSummary.taskId;
		if (
			isNeverStartedPlaceholderTaskSessionSummary(liveRuntimeSessionSummary) &&
			overlaidAgentConversationProgressObservedAtByTaskId.has(taskId)
		) {
			continue;
		}
		const liveObservedAtMs = liveRuntimeSessionSummary.lastConversationProgressObservation?.observedAtMs;
		if (liveObservedAtMs === undefined) {
			overlaidAgentConversationProgressObservedAtByTaskId.delete(taskId);
			continue;
		}
		overlaidAgentConversationProgressObservedAtByTaskId.set(taskId, liveObservedAtMs);
	}
	return overlaidAgentConversationProgressObservedAtByTaskId;
}

/**
 * 把「各项目的 board」投影为跨项目任务搜索索引响应（镜像 in-progress-task-detail-projection 的纯函数模式）。
 *
 * - board 为 null（读盘失败）的项目整体跳过；
 * - 遍历全部列（含 trash/Done），逐卡输出匹配字段（taskId / title / prompt / columnId）加结果行排序与展示
 *   所需的卡片级持久事实（createdAt / updatedAt / agentId / mostRecentlyLaunchedAgentSessionAgentId），
 *   以及按 taskId 查到的对话推进时刻（agentConversationProgressObservedAt）；
 *   title 缺省归一为空串，两个 agent 字段的 undefined 与查不到的推进时刻归一为 null（契约是 nullable 而非 optional）。
 *
 * 纯函数：无 I/O、无闭包状态，可独立单测。
 */
export function projectAllProjectsTaskSearchIndex(
	projects: ReadonlyArray<AllProjectsTaskSearchIndexProjectInput>,
): RuntimeAllProjectsTaskSearchIndexResponse {
	const projectEntries: RuntimeAllProjectsTaskSearchIndexResponse["projects"] = [];
	for (const project of projects) {
		if (!project.board) {
			continue;
		}
		const tasks: RuntimeAllProjectsTaskSearchIndexResponse["projects"][number]["tasks"] = [];
		for (const column of project.board.columns) {
			for (const card of column.cards) {
				tasks.push({
					taskId: card.id,
					title: card.title ?? "",
					prompt: card.prompt,
					columnId: column.id,
					createdAt: card.createdAt,
					updatedAt: card.updatedAt,
					agentId: card.agentId ?? null,
					mostRecentlyLaunchedAgentSessionAgentId: card.mostRecentlyLaunchedAgentSessionAgentId ?? null,
					agentConversationProgressObservedAt:
						project.agentConversationProgressObservedAtByTaskId.get(card.id) ?? null,
				});
			}
		}
		projectEntries.push({
			projectId: project.projectId,
			projectName: project.projectName,
			tasks,
		});
	}
	return { projects: projectEntries };
}
