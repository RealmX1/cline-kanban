import type { RuntimeAgentId } from "./api-contract";

// 各 coding agent **主对话**的 prompt cache 实测保持时长，供跨项目切换面板的「缓存倒计时区」
// （docs/context-cross-project-recently-active-task-switcher.md）估算「再不回复，旧轮次就要按全价重算」的时刻。
//
// 来源：2026-10-02 本机实测（my-ai-setup 仓库任务 d9ce2 的报告《prompt-cache-retention-per-coding-agent-and-
// model-provider-measured-2026-10》）。方法是隔 N 分钟发第 2 轮、看第 1 轮独有内容是否按缓存价读回。
// 只覆盖当时本机的账户与默认模型（Claude 订阅主对话、Codex gpt-6.1-sol、Kimi k3、Cursor grok-4.7）；
// 换账户 / 换模型 / 上游改策略都会让这里的数字失真，重测后直接改表。
//
// 表里没有的 agent（cline / omp / gemini / opencode / droid / kiro）一律不进倒计时区，落到剩余区——
// 没测过就不猜。

export type CodingAgentPromptCacheRetentionScope =
	// 缓存在服务端，按前缀命中：agent 进程退出后用 --resume 续会话照样命中（Claude Code、Cursor 实测）。
	| "provider_server_side_cache_survives_agent_process_restart"
	// 换进程续会话会重新注入 developer / world_state 段，前缀失配，旧轮次全价重算（Codex、Kimi 实测）。
	// 所以只有 agent 进程还活着（liveness === "live"）时，倒计时才有意义。
	| "same_agent_process_only_cache_lost_when_agent_process_exits";

// 倒计时起点（最后一次向主对话模型发请求的时刻）从哪个信号读。
export type CodingAgentPromptCacheWarmthAnchorSignal =
	// harness 有「紧接着就发请求」的 hook（UserPromptSubmit / PostToolUse …），读
	// summary.lastMainAgentConversationModelRequestDispatchObservation。
	| "main_agent_conversation_model_request_dispatch_hook_events"
	// harness 没有回合类 hook（Cursor），退而读最近一次实质 TUI 输出（≈ 最后一次响应结束）。它有会话恢复
	// 重播保护（suppressSubstantiveOutputUntilContinues），不会被恢复刷成 now。
	| "last_substantive_agent_terminal_output_because_harness_has_no_turn_hooks";

export interface CodingAgentPromptCacheRetentionMeasuredLowerBound {
	promptCacheRetentionTtlLowerBoundMs: number;
	promptCacheRetentionScope: CodingAgentPromptCacheRetentionScope;
	promptCacheWarmthAnchorSignal: CodingAgentPromptCacheWarmthAnchorSignal;
}

const MINUTE_MS = 60_000;

// EXPERIMENT_NODE: 取实测「全部命中」的最长间隔（区间下限），宁可早一点掉出倒计时区也不让人误以为还热；可改取区间中点，或对 Cursor 这类概率性命中改用命中率曲线。
export const CODING_AGENT_PROMPT_CACHE_RETENTION_MEASURED_LOWER_BOUND_BY_AGENT_ID: Readonly<
	Partial<Record<RuntimeAgentId, CodingAgentPromptCacheRetentionMeasuredLowerBound>>
> = {
	// 55m 2/2 命中，65m 0/2。订阅主对话写入档位 1h（subagent 是 5m，与这里无关）。
	claude: {
		promptCacheRetentionTtlLowerBoundMs: 55 * MINUTE_MS,
		promptCacheRetentionScope: "provider_server_side_cache_survives_agent_process_restart",
		promptCacheWarmthAnchorSignal: "main_agent_conversation_model_request_dispatch_hook_events",
	},
	// ≤2h 13/14 命中，3h 起 0/8。文档只写「至少 30m」。
	codex: {
		promptCacheRetentionTtlLowerBoundMs: 120 * MINUTE_MS,
		promptCacheRetentionScope: "same_agent_process_only_cache_lost_when_agent_process_exits",
		promptCacheWarmthAnchorSignal: "main_agent_conversation_model_request_dispatch_hook_events",
	},
	// 20m、25m 各 2/2 命中，30m 起 0/16。边界陡峭，像固定 30m TTL。
	kimi: {
		promptCacheRetentionTtlLowerBoundMs: 25 * MINUTE_MS,
		promptCacheRetentionScope: "same_agent_process_only_cache_lost_when_agent_process_exits",
		promptCacheWarmthAnchorSignal: "main_agent_conversation_model_request_dispatch_hook_events",
	},
	// 20m 6/6、25m 3/4，30m 起 0/19；短间隔也常失配（请求落到没有该缓存的后端），命中是概率性的。
	cursor: {
		promptCacheRetentionTtlLowerBoundMs: 20 * MINUTE_MS,
		promptCacheRetentionScope: "provider_server_side_cache_survives_agent_process_restart",
		promptCacheWarmthAnchorSignal: "last_substantive_agent_terminal_output_because_harness_has_no_turn_hooks",
	},
};
