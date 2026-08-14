import { describe, expect, it } from "vitest";

import type { RuntimeTerminalAgentModelSelectionOption } from "../../../src/core/api-contract";
import { filterTerminalAgentModelOptionsToLatestProductLineGeneration } from "../../../src/terminal/agent-model-product-line-latest-generation-filter";

function buildOptions(
	entries: ReadonlyArray<readonly [modelId: string, label: string]>,
): RuntimeTerminalAgentModelSelectionOption[] {
	return entries.map(([modelId, label]) => ({ modelId, label, modelSelectionGroup: "latest_tracking_alias" }));
}

// 取自 `cursor-agent --list-models`（2026.08 实测）里 grok / composer / auto 那 17 行。
const CURSOR_GROK_AND_COMPOSER_OPTIONS = buildOptions([
	["auto", "Auto (current, default)"],
	["cursor-grok-4.6-high-fast", "Cursor Grok 4.6 Fast"],
	["composer-2.5", "Composer 2.5"],
	["cursor-grok-4.5-high", "Cursor Grok 4.5"],
	["cursor-grok-4.5-high-fast", "Cursor Grok 4.5 Fast"],
	["cursor-grok-4.6-low", "Cursor Grok 4.6 Low"],
	["cursor-grok-4.6-low-fast", "Cursor Grok 4.6 Low Fast"],
	["cursor-grok-4.6-medium", "Cursor Grok 4.6 Medium"],
	["cursor-grok-4.6-medium-fast", "Cursor Grok 4.6 Medium Fast"],
	["cursor-grok-4.6-high", "Cursor Grok 4.6"],
	["cursor-grok-4.6-xhigh", "Cursor Grok 4.6 Extra High"],
	["cursor-grok-4.6-xhigh-fast", "Cursor Grok 4.6 Extra High Fast"],
	["composer-2.5-fast", "Composer 2.5 Fast"],
	["cursor-grok-4.5-low", "Cursor Grok 4.5 Low"],
	["cursor-grok-4.5-low-fast", "Cursor Grok 4.5 Low Fast"],
	["cursor-grok-4.5-medium", "Cursor Grok 4.5 Medium"],
	["cursor-grok-4.5-medium-fast", "Cursor Grok 4.5 Medium Fast"],
]);

// 取自 `codex debug models`，已按 visibility=hide 过滤后的 7 条。
const CODEX_GPT_OPTIONS = buildOptions([
	["gpt-5.6-sol", "GPT-5.6 Sol"],
	["gpt-5.6-terra", "GPT-5.6 Terra"],
	["gpt-5.6-luna", "GPT-5.6 Luna"],
	["gpt-5.5", "GPT-5.5"],
	["gpt-5.4", "GPT-5.4"],
	["gpt-5.4-mini", "GPT-5.4 mini"],
	["gpt-5.3-codex-spark", "GPT-5.3 Codex Spark"],
]);

// 取自 `kimi provider list --json` 的 `.models`：版本号只在 displayName 里，id 里没有。
const KIMI_OPTIONS = buildOptions([
	["kimi-code/kimi-for-coding", "K2.7 Coding"],
	["kimi-code/kimi-for-coding-highspeed", "K2.7 Coding Highspeed"],
	["kimi-code/k3", "K3"],
	["kimi-code/k3-256k", "K3-256k"],
]);

describe("filterTerminalAgentModelOptionsToLatestProductLineGeneration", () => {
	it("keeps every tier of Cursor's newest grok generation and drops the previous one", () => {
		const modelIds = filterTerminalAgentModelOptionsToLatestProductLineGeneration(
			"cursor",
			CURSOR_GROK_AND_COMPOSER_OPTIONS,
		).map((option) => option.modelId);

		// 代内所有分体全留：low / medium / high / xhigh 各自的 fast 与非 fast。
		expect(modelIds).toEqual([
			"auto",
			"cursor-grok-4.6-high-fast",
			"composer-2.5",
			"cursor-grok-4.6-low",
			"cursor-grok-4.6-low-fast",
			"cursor-grok-4.6-medium",
			"cursor-grok-4.6-medium-fast",
			"cursor-grok-4.6-high",
			"cursor-grok-4.6-xhigh",
			"cursor-grok-4.6-xhigh-fast",
			"composer-2.5-fast",
		]);
		expect(modelIds.some((modelId) => modelId.includes("4.5"))).toBe(false);
	});

	it("keeps auto, which belongs to no product line at all", () => {
		const modelIds = filterTerminalAgentModelOptionsToLatestProductLineGeneration(
			"cursor",
			CURSOR_GROK_AND_COMPOSER_OPTIONS,
		).map((option) => option.modelId);

		expect(modelIds).toContain("auto");
	});

	it("collapses Codex to the GPT-5.6 line, dropping 5.5 and the older mini / spark variants", () => {
		const modelIds = filterTerminalAgentModelOptionsToLatestProductLineGeneration("codex", CODEX_GPT_OPTIONS).map(
			(option) => option.modelId,
		);

		expect(modelIds).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
	});

	it("reads Kimi's generation from the display name because its model ids carry no version", () => {
		const modelIds = filterTerminalAgentModelOptionsToLatestProductLineGeneration("kimi", KIMI_OPTIONS).map(
			(option) => option.modelId,
		);

		expect(modelIds).toEqual(["kimi-code/k3", "kimi-code/k3-256k"]);
	});

	it("leaves Claude's curated table untouched because it has no product-line rule", () => {
		const claudeOptions = buildOptions([
			["opus", "Opus"],
			["claude-opus-4-6", "Opus 4.6"],
			["claude-sonnet-5", "Sonnet 5"],
		]);

		expect(
			filterTerminalAgentModelOptionsToLatestProductLineGeneration("claude", claudeOptions).map(
				(option) => option.modelId,
			),
		).toEqual(["opus", "claude-opus-4-6", "claude-sonnet-5"]);
	});

	// 本模块存在的全部理由：上一版那道写死版本号的白名单在 Cursor 给 grok 加 `cursor-` 前缀当天
	// 静默吞掉了 14 个模型。规则匹配不上时必须保留，宁可多显示一个过时选项，也不能让新模型消失。
	it("fails open on naming schemes no rule recognises", () => {
		const unrecognizedOptions = buildOptions([
			["cursor-grok-4.6-high", "Cursor Grok 4.6"],
			["quokka-next", "Quokka Next"],
			["xai/grok-5-high", "Grok 5"],
		]);

		const modelIds = filterTerminalAgentModelOptionsToLatestProductLineGeneration("cursor", unrecognizedOptions).map(
			(option) => option.modelId,
		);

		// `quokka-next` 没有任何版本号可抽，规则匹配不上 ⇒ 保留。
		expect(modelIds).toContain("quokka-next");
		// `xai/grok-5-high` 用了新的命名空间前缀，但 grok 规则按分隔符匹配得上，于是 5 > 4.6，4.6 反而下架。
		expect(modelIds).toEqual(["quokka-next", "xai/grok-5-high"]);
	});

	it("compares generations numerically rather than lexicographically", () => {
		const doubleDigitMinorOptions = buildOptions([
			["cursor-grok-4.9-high", "Cursor Grok 4.9"],
			["cursor-grok-4.10-high", "Cursor Grok 4.10"],
		]);

		expect(
			filterTerminalAgentModelOptionsToLatestProductLineGeneration("cursor", doubleDigitMinorOptions).map(
				(option) => option.modelId,
			),
		).toEqual(["cursor-grok-4.10-high"]);
	});
});
