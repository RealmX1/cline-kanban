import type {
	CrossProjectTaskSwitcherPromptCacheWarmthAnchorSource,
	CrossProjectTaskSwitcherPromptCacheWarmthEstimate,
} from "@runtime-cross-project-recently-active-task-switcher-section-assignment";
import { Minimize2, Timer } from "lucide-react";
import type { ReactElement } from "react";

import { cn } from "@/components/ui/cn";

const MINUTE_MS = 60_000;
// 剩余不足这么久时倒计时药丸转警示色。
// EXPERIMENT_NODE: 倒计时药丸转警示色的阈值取 10 分钟；够不够人从切过去到发出下一句。
const PROMPT_CACHE_WARMTH_EXPIRY_WARNING_THRESHOLD_MS = 10 * MINUTE_MS;

function formatPromptCacheWarmthRemainingDuration(remainingMs: number): string {
	if (remainingMs < MINUTE_MS) {
		return "<1m";
	}
	const remainingMinutes = Math.floor(remainingMs / MINUTE_MS);
	if (remainingMinutes < 60) {
		return `${remainingMinutes}m`;
	}
	return `${Math.floor(remainingMinutes / 60)}h${String(remainingMinutes % 60).padStart(2, "0")}m`;
}

const PROMPT_CACHE_WARMTH_ANCHOR_SOURCE_DESCRIPTION: Record<
	CrossProjectTaskSwitcherPromptCacheWarmthAnchorSource,
	string
> = {
	main_agent_conversation_model_request_dispatch_observation: "last main-conversation model request",
	manual_compaction_replaced_main_conversation_without_follow_up_request:
		"manual /compact completed (conversation replaced by a summary)",
	last_substantive_agent_terminal_output: "last substantive agent output (agent has no turn hooks)",
};

function isPromptCacheWarmthAnchoredOnManualCompaction(
	estimate: CrossProjectTaskSwitcherPromptCacheWarmthEstimate,
): boolean {
	return (
		estimate.promptCacheWarmthAnchorSource ===
		"manual_compaction_replaced_main_conversation_without_follow_up_request"
	);
}

function formatContextTokenCountInThousands(tokenCount: number): string {
	return `~${Math.max(1, Math.round(tokenCount / 1000))}k`;
}

// 手动压缩后不显示倒计时（2026-10-05 用户拍板 B′）：压缩请求只按 5 分钟档读了被替换前的旧前缀，下一条回复
// 不论早晚都要重写压缩后的上下文。harness 报了大小（Kimi）才写 N，否则给 Claude 的实测范围，不造数字。
function describeManualCompactionReplacedMainConversation(
	estimate: CrossProjectTaskSwitcherPromptCacheWarmthEstimate,
): string {
	const reportedTokenCount = estimate.mainAgentConversationContextTokenCountAfterCompactionReportedByHarness;
	return [
		`Compacted · ${new Date(estimate.promptCacheWarmthAnchorAt).toLocaleString()} · ${
			PROMPT_CACHE_WARMTH_ANCHOR_SOURCE_DESCRIPTION[estimate.promptCacheWarmthAnchorSource]
		}`,
		reportedTokenCount !== undefined
			? `Your next reply rewrites ${formatContextTokenCountInThousands(reportedTokenCount)} tokens of compacted context`
			: "Your next reply rewrites the compacted context (measured 86k–103k tokens on Claude); only the system and project-context layers still hit the cache",
	].join("\n");
}

function describePromptCacheWarmthEstimate(estimate: CrossProjectTaskSwitcherPromptCacheWarmthEstimate): string {
	return [
		`Prompt cache expected to expire · ${new Date(estimate.promptCacheExpectedExpiryAt).toLocaleString()}`,
		`Countdown started · ${new Date(estimate.promptCacheWarmthAnchorAt).toLocaleString()} · ${
			PROMPT_CACHE_WARMTH_ANCHOR_SOURCE_DESCRIPTION[estimate.promptCacheWarmthAnchorSource]
		}`,
	].join("\n");
}

/**
 * Cache warm 区的倒计时药丸（手动压缩后改显示「Compacted」）。精简行第 2 行右侧与完整卡片（hover 展开 / 固定展开）
 * 元信息行右侧共用，两处都在时长药丸组的最前面：换成完整卡时不能把它丢掉。
 */
export function CrossProjectTaskSwitcherRowPromptCacheWarmthPill({
	promptCacheWarmthEstimate,
	nowMs,
}: {
	promptCacheWarmthEstimate: CrossProjectTaskSwitcherPromptCacheWarmthEstimate;
	nowMs: number;
}): ReactElement {
	if (isPromptCacheWarmthAnchoredOnManualCompaction(promptCacheWarmthEstimate)) {
		const reportedTokenCount =
			promptCacheWarmthEstimate.mainAgentConversationContextTokenCountAfterCompactionReportedByHarness;
		return (
			<span
				className="inline-flex shrink-0 items-center gap-0.5 rounded-sm bg-surface-4 px-1 text-[10px] leading-4 text-text-secondary"
				title={describeManualCompactionReplacedMainConversation(promptCacheWarmthEstimate)}
			>
				<Minimize2 size={10} className="shrink-0" />
				{reportedTokenCount !== undefined
					? `Compacted · ${formatContextTokenCountInThousands(reportedTokenCount)}`
					: "Compacted"}
			</span>
		);
	}
	const promptCacheWarmthRemainingMs = promptCacheWarmthEstimate.promptCacheExpectedExpiryAt - nowMs;
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center gap-0.5 rounded-sm px-1 text-[10px] leading-4",
				promptCacheWarmthRemainingMs < PROMPT_CACHE_WARMTH_EXPIRY_WARNING_THRESHOLD_MS
					? "bg-status-gold/15 text-status-gold"
					: "bg-accent/15 text-accent",
			)}
			title={describePromptCacheWarmthEstimate(promptCacheWarmthEstimate)}
		>
			<Timer size={10} className="shrink-0" />
			{formatPromptCacheWarmthRemainingDuration(promptCacheWarmthRemainingMs)}
		</span>
	);
}
