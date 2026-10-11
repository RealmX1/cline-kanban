import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { TaskBoardSearchResult } from "@/search/task-board-search";

/** 上一次收敛时的输入快照：判定「这次变化是不是一次纯粹的实时重排」要拿它对比。 */
interface PreviousActiveResultIndexConvergenceInput {
	resultIdentityKeys: readonly string[];
	resultOrderingIntentSignature: string;
	isBrowsingAllTasksWithoutQuery: boolean;
}

export interface TaskSpotlightSearchActiveResultIndex {
	/** 已夹到结果范围内的选中行；-1 = 无选中。 */
	activeIndex: number;
	setActiveIndex: (index: number) => void;
	moveActive: (delta: number) => void;
}

function splitResultsIdentitySignatureIntoKeys(resultsIdentitySignature: string): readonly string[] {
	return resultsIdentitySignature.length === 0 ? [] : resultsIdentitySignature.split("\n");
}

function hasSameResultMembership(previousKeys: readonly string[], nextKeys: readonly string[]): boolean {
	if (previousKeys.length !== nextKeys.length) {
		return false;
	}
	const previousKeySet = new Set(previousKeys);
	return nextKeys.every((key) => previousKeySet.has(key));
}

/**
 * Spotlight 结果列表的选中行（↑↓ 导航 + 回车打开的那一行）。
 *
 * 收敛规则——结果集**身份签名**（成员 + 顺序）变化时：
 * - 默认：浏览态回到「无选中」（-1），搜索态回到第 0 行（有查询串时第 0 行就是最佳命中，回车直达是这个弹层的核心动作）；
 * - 例外：**纯实时重排**时选中行跟着同一个任务走。判据是「成员完全不变 + 用户这边决定排序的输入
 *   （`resultOrderingIntentSignature`：查询串 / 模式 / 字段范围 / 生效排序档）不变」——此时顺序变化只可能来自
 *   实时数据，典型是 direct 的 relevance 档与 agent 活跃档按「对话上次推进」排序，某个 agent 一推进，它那行
 *   就挪到前面。若照默认规则钉回第 0 行，只要有 agent 在跑，用户用 ↓ 选中的行就会被不断抢走，回车打开错误的任务。
 *   成员变了（board 多了张卡、过滤条件变了）或用户自己改了排序输入时，仍按默认规则收敛。
 *
 * 只认身份签名、**不认 `results` 的数组引用**：结果行上下文的叠加层随会话文案频繁换引用，成员与顺序却分毫未动，
 * 以引用为依赖会把选中行反复钉回去。签名里字段间那个不可见字符是 U+0001，projectId / taskId 里都不可能出现。
 */
export function useTaskSpotlightSearchActiveResultIndex({
	results,
	isBrowsingAllTasksWithoutQuery,
	resultOrderingIntentSignature,
}: {
	results: readonly TaskBoardSearchResult[];
	isBrowsingAllTasksWithoutQuery: boolean;
	resultOrderingIntentSignature: string;
}): TaskSpotlightSearchActiveResultIndex {
	// 空查询浏览态刻意不预选任何行（-1）：⌘K 之后直接回车是既有的肌肉记忆，预选第 0 行会让它变成
	// 「随手打开某个任务」。用户按 ↓ 或开始输入后才进入有选中行的状态。
	const [activeIndex, setActiveIndex] = useState(-1);

	const resultsIdentitySignature = useMemo(
		() => results.map((result) => `${result.document.projectId}\u0001${result.document.taskId}`).join("\n"),
		[results],
	);

	const previousConvergenceInputRef = useRef<PreviousActiveResultIndexConvergenceInput | null>(null);

	useEffect(() => {
		const resultIdentityKeys = splitResultsIdentitySignatureIntoKeys(resultsIdentitySignature);
		const previousConvergenceInput = previousConvergenceInputRef.current;
		previousConvergenceInputRef.current = {
			resultIdentityKeys,
			resultOrderingIntentSignature,
			isBrowsingAllTasksWithoutQuery,
		};
		const isLiveReorderOfSameResults =
			previousConvergenceInput !== null &&
			previousConvergenceInput.isBrowsingAllTasksWithoutQuery === isBrowsingAllTasksWithoutQuery &&
			previousConvergenceInput.resultOrderingIntentSignature === resultOrderingIntentSignature &&
			hasSameResultMembership(previousConvergenceInput.resultIdentityKeys, resultIdentityKeys);
		setActiveIndex((previousActiveIndex) => {
			if (isLiveReorderOfSameResults && previousActiveIndex >= 0) {
				const previouslyActiveResultKey = previousConvergenceInput?.resultIdentityKeys[previousActiveIndex];
				const followedActiveIndex =
					previouslyActiveResultKey === undefined ? -1 : resultIdentityKeys.indexOf(previouslyActiveResultKey);
				if (followedActiveIndex >= 0) {
					return followedActiveIndex;
				}
			}
			return isBrowsingAllTasksWithoutQuery ? -1 : 0;
		});
	}, [resultsIdentitySignature, isBrowsingAllTasksWithoutQuery, resultOrderingIntentSignature]);

	const activeIndexClamped = results.length === 0 || activeIndex < 0 ? -1 : Math.min(activeIndex, results.length - 1);

	const moveActive = useCallback(
		(delta: number) => {
			setActiveIndex((previous) => {
				if (results.length === 0) {
					return -1;
				}
				// 「无选中」态下按 ↓ 落到第一行、按 ↑ 落到最后一行。不能走下面的取模式环绕：
				// previous=-1 时它会算出第 1 行，把第 0 行整个跳过去。
				if (previous < 0) {
					return delta > 0 ? 0 : results.length - 1;
				}
				const base = previous % results.length;
				return (base + (delta % results.length) + results.length) % results.length;
			});
		},
		[results.length],
	);

	return { activeIndex: activeIndexClamped, setActiveIndex, moveActive };
}
