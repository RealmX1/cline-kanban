// 把触发器的内部归宿翻译成契约层的响应形状（B.2）。
//
// 单独成一个模块而不是塞进 runtime-server 的注入闭包里：这是**契约翻译**，不是装配。核心包的作业
// 有四种归宿（accepted / rejected / skipped / fork_failed），触发器在它之上还有「根本没开跑」的五种
// 理由，两层合起来的映射有真实的判断在里面——面板要据此显示「为什么这次没判」，翻译错了用户看到的
// 就是错的解释。放在这里才测得到。

import type { RuntimeRequestExplorationThreadGraphMaintenanceResponse } from "../core/api-contract";
import type { ExplorationThreadGraphMaintenanceOutcome } from "./exploration-thread-graph-maintenance-trigger";

export function translateExplorationThreadGraphMaintenanceOutcome(
	outcome: ExplorationThreadGraphMaintenanceOutcome,
): RuntimeRequestExplorationThreadGraphMaintenanceResponse {
	if (outcome.kind === "not_started") {
		return { kind: "not_started", reason: outcome.reason };
	}
	if (outcome.kind === "failed") {
		return { kind: "failed", message: outcome.message };
	}

	const result = outcome.result;
	switch (result.outcome) {
		case "accepted":
			return {
				kind: "completed",
				jobOutcome: "accepted",
				// placedTurnCount 是落盘后的**总数**，不是本次新增数（核心包语义，别当增量读）。
				placedTurnCount: result.placedTurnCount,
				remainingTurnCount: result.remainingTurnCount,
				detail: null,
			};
		case "rejected":
			return {
				kind: "completed",
				jobOutcome: "rejected",
				placedTurnCount: null,
				remainingTurnCount: null,
				// 漏斗的拒绝理由原样透传：它是可穷举的 union，面板显示它比显示「失败了」有用得多。
				detail: result.rejectionReason,
			};
		case "skipped":
			return {
				kind: "completed",
				jobOutcome: "skipped",
				placedTurnCount: null,
				remainingTurnCount: null,
				detail: result.skipReason,
			};
		case "fork_failed":
			return {
				kind: "completed",
				jobOutcome: "fork_failed",
				placedTurnCount: null,
				remainingTurnCount: null,
				detail: `${result.stopReason}: ${result.outputTextExcerpt}`,
			};
	}
}
