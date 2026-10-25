import {
	buildCrossProjectTaskSwitcherEntryKey,
	type CrossProjectTaskSwitcherEntryInProject,
	type CrossProjectTaskSwitcherSections,
} from "@runtime-cross-project-recently-active-task-switcher-section-assignment";
import { useEffect, useMemo, useRef } from "react";

import { useDocumentVisibility } from "@/hooks/use-document-visibility";
import { fetchTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries } from "@/runtime/cross-project-task-worktree-git-metadata-query";
import {
	applyCrossProjectTaskWorktreeGitMetadataPollResults,
	markCrossProjectTaskWorktreeGitMetadataPollFailed,
	markCrossProjectTaskWorktreeGitMetadataPollStarted,
} from "@/stores/cross-project-task-worktree-git-metadata-store";
import { useInterval } from "@/utils/react-use";

// EXPERIMENT_NODE: 跨项目切换面板「其他项目」行的 git 元数据轮询间隔取 5 秒（当前项目推流是 3 秒一轮）；
// 服务端有 fs-stat 门控，没变化的 worktree 一次 git 都不跑，间隔主要决定「agent 写完文件后多久看到」。
const CROSS_PROJECT_TASK_WORKTREE_GIT_METADATA_POLL_INTERVAL_MS = 5_000;
// 与服务端请求 schema 的上限（CROSS_PROJECT_TASK_WORKTREE_GIT_METADATA_REQUEST_MAXIMUM_TASK_COUNT）一致；
// web-ui 只能从 api-contract 引类型，故在此另记一份。
const CROSS_PROJECT_TASK_WORKTREE_GIT_METADATA_REQUEST_MAXIMUM_TASK_COUNT = 100;

// 面板四个区里会显示的全部条目（Pinned 与下方区重复的，由下面的选择函数按键去重）。
export function collectEntriesShownInCrossProjectTaskSwitcherSections(
	sections: CrossProjectTaskSwitcherSections,
): CrossProjectTaskSwitcherEntryInProject[] {
	const remainingEntries = sections.remainingSection.entries;
	return [
		...sections.pinnedEntries,
		...sections.runningEntries,
		...sections.promptCacheWarmAwaitingUserEntries,
		...remainingEntries,
	];
}

// 要轮询的条目：不在 Backlog（还没有 worktree）的全部条目，**含当前项目**。All projects 下状态流只探焦点任务
//（与 auto-review 的 Review 列任务），当前项目其余行的 git 状态也得靠这里。
export function selectCrossProjectTaskSwitcherEntriesNeedingWorktreeGitMetadataPoll(
	entriesInProjects: readonly CrossProjectTaskSwitcherEntryInProject[],
): Array<{ workspaceId: string; taskId: string }> {
	const seenEntryKeys = new Set<string>();
	const tasks: Array<{ workspaceId: string; taskId: string }> = [];
	for (const { workspaceId, entry } of entriesInProjects) {
		if (entry.columnId === "backlog") {
			continue;
		}
		const entryKey = buildCrossProjectTaskSwitcherEntryKey(workspaceId, entry.taskId);
		if (seenEntryKeys.has(entryKey)) {
			continue;
		}
		seenEntryKeys.add(entryKey);
		tasks.push({ workspaceId, taskId: entry.taskId });
	}
	return tasks;
}

// 只在面板挂载（调用方即面板）且页面可见时轮询；条目集合变化时立刻补一轮，不等下一个 tick。
export function useCrossProjectTaskWorktreeGitMetadataPolling({
	entriesInProjects,
	currentProjectId,
}: {
	entriesInProjects: readonly CrossProjectTaskSwitcherEntryInProject[];
	currentProjectId: string | null;
}): void {
	const isDocumentVisible = useDocumentVisibility();
	const tasksNeedingPoll = useMemo(
		() => selectCrossProjectTaskSwitcherEntriesNeedingWorktreeGitMetadataPoll(entriesInProjects),
		[entriesInProjects],
	);
	// 广播每 150ms 就换一份 entries 数组，但要请求的键集合很少变；按签名触发「立刻补一轮」，避免每批都发请求。
	const tasksNeedingPollSignature = tasksNeedingPoll
		.map(({ workspaceId, taskId }) => buildCrossProjectTaskSwitcherEntryKey(workspaceId, taskId))
		.join("\n");
	const latestPollInputRef = useRef({ tasksNeedingPoll, currentProjectId, isDocumentVisible });
	latestPollInputRef.current = { tasksNeedingPoll, currentProjectId, isDocumentVisible };
	const isPollCycleInFlightRef = useRef(false);
	const isPollingHostMountedRef = useRef(false);
	const needsImmediatePollAfterCurrentCycleRef = useRef(false);
	useEffect(() => {
		isPollingHostMountedRef.current = true;
		return () => {
			isPollingHostMountedRef.current = false;
		};
	}, []);

	const pollOnce: () => void = useRef(() => {
		const { tasksNeedingPoll: tasks, currentProjectId: scopeProjectId } = latestPollInputRef.current;
		if (tasks.length === 0 || isPollCycleInFlightRef.current) {
			return;
		}
		isPollCycleInFlightRef.current = true;
		needsImmediatePollAfterCurrentCycleRef.current = false;
		markCrossProjectTaskWorktreeGitMetadataPollStarted(tasks);
		void (async () => {
			try {
				for (
					let offset = 0;
					offset < tasks.length;
					offset += CROSS_PROJECT_TASK_WORKTREE_GIT_METADATA_REQUEST_MAXIMUM_TASK_COUNT
				) {
					if (!isPollingHostMountedRef.current || !latestPollInputRef.current.isDocumentVisible) break;
					// 候选变化不重置本轮进度，整轮结束后补查新集合，避免持续重排饿死后半段任务。
					const batch = tasks.slice(
						offset,
						offset + CROSS_PROJECT_TASK_WORKTREE_GIT_METADATA_REQUEST_MAXIMUM_TASK_COUNT,
					);
					try {
						const response = await fetchTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries(
							scopeProjectId,
							{ tasks: batch },
						);
						if (!isPollingHostMountedRef.current) break;
						applyCrossProjectTaskWorktreeGitMetadataPollResults(response.tasks);
						const returnedEntryKeys = new Set(
							response.tasks.map(({ workspaceId, taskId }) =>
								buildCrossProjectTaskSwitcherEntryKey(workspaceId, taskId),
							),
						);
						markCrossProjectTaskWorktreeGitMetadataPollFailed(
							batch.filter(
								({ workspaceId, taskId }) =>
									!returnedEntryKeys.has(buildCrossProjectTaskSwitcherEntryKey(workspaceId, taskId)),
							),
						);
					} catch {
						// 失败保留上一份快照，也不能饿死后续批次；下个 tick 自动重试。
						if (isPollingHostMountedRef.current) markCrossProjectTaskWorktreeGitMetadataPollFailed(batch);
					}
				}
			} finally {
				isPollCycleInFlightRef.current = false;
				if (
					isPollingHostMountedRef.current &&
					latestPollInputRef.current.isDocumentVisible &&
					needsImmediatePollAfterCurrentCycleRef.current
				)
					pollOnce();
			}
		})();
	}).current;

	// 签名变化（条目集合变化）或页面重新可见时立刻补一轮，不等下一个 tick。
	useEffect(() => {
		if (isDocumentVisible) {
			needsImmediatePollAfterCurrentCycleRef.current = true;
			pollOnce();
		}
	}, [isDocumentVisible, tasksNeedingPollSignature, currentProjectId, pollOnce]);

	useInterval(
		() => {
			pollOnce();
		},
		isDocumentVisible ? CROSS_PROJECT_TASK_WORKTREE_GIT_METADATA_POLL_INTERVAL_MS : null,
	);
}
