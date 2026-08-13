import { describe, expect, it } from "vitest";

import type { RuntimeTerminalAgentModelSelectionOption } from "../../../src/core/api-contract";
import { isKanbanCursorAgentModelId } from "../../../src/core/cursor-agent-models";
import {
	isClaudeCodeCuratedTerminalAgentModelSelectionOptionId,
	isClaudeCodeLatestTrackingAliasModelSelectionOptionId,
	isClaudeCodePhaseSwitchingCompositeModelSelectionOptionId,
	parseClaudeHelpModelAliases,
	parseCodexModelCatalog,
	parseCursorModelList,
	parseKimiProviderModelCatalog,
	resolveClaudeLaunchModelIdentityForObservedTranscriptModelIdentity,
	selectCursorLaunchDefaultModelIdFromCatalog,
} from "../../../src/terminal/terminal-agent-model-selection";

// A representative `claude --help` `--model` line: only 3 example aliases, no haiku, no versions.
const CLAUDE_HELP_STDOUT = `  --model <model>  Model for the current session. e.g. 'sonnet', 'opus', or 'mythos'.`;

describe("terminal agent model selection", () => {
	it("labels latest-tracking Claude aliases without a version number so they can never go stale", () => {
		const options = parseClaudeHelpModelAliases(CLAUDE_HELP_STDOUT);
		const byModelId = new Map(options.map((option) => [option.modelId, option]));

		// The regression this guards: `opus` resolves to whatever the newest Opus is, so pinning a
		// version number into its label (it used to read "Opus 4.8") silently mislabels the button
		// the moment Anthropic ships a new Opus. Alias labels must stay version-free.
		for (const modelId of ["opus", "sonnet", "haiku", "fable"]) {
			const option = byModelId.get(modelId);
			expect(option?.modelSelectionGroup).toBe("latest_tracking_alias");
			expect(option?.label).not.toMatch(/\d/);
		}
		// haiku is absent from --help yet must always surface.
		expect(byModelId.get("haiku")?.label).toBe("Haiku");
		// 1M-context and mixed-mode aliases are curated too.
		expect(byModelId.get("opus[1m]")?.modelSelectionGroup).toBe("latest_tracking_alias");
		expect(byModelId.get("sonnet[1m]")?.modelSelectionGroup).toBe("latest_tracking_alias");
		expect(byModelId.get("opusplan")?.label).toBe("Opus Plan");
		// A help-advertised alias we don't curate still surfaces (auto-discovery preserved).
		expect(byModelId.get("mythos")).toEqual({
			modelId: "mythos",
			label: "Mythos",
			modelSelectionGroup: "latest_tracking_alias",
		});
	});

	it("offers concrete Claude versions as a separately grouped pinned tier", () => {
		const options = parseClaudeHelpModelAliases(CLAUDE_HELP_STDOUT);
		const byModelId = new Map(options.map((option) => [option.modelId, option]));

		expect(byModelId.get("claude-opus-5")).toEqual({
			modelId: "claude-opus-5",
			label: "Opus 5",
			description: "claude-opus-5",
			modelSelectionGroup: "pinned_version",
		});
		expect(byModelId.get("claude-opus-4-8")?.modelSelectionGroup).toBe("pinned_version");
		expect(byModelId.get("claude-opus-5[1m]")?.label).toBe("Opus 5 · 1M");

		// `deduplicateModelOptions` rebuilds each option field-by-field, so a missing passthrough
		// would silently drop the grouping and collapse the picker back to a single tier.
		expect(options.every((option) => option.modelSelectionGroup !== undefined)).toBe(true);
		expect(options.some((option) => option.modelSelectionGroup === "pinned_version")).toBe(true);
	});

	it("excludes hidden Codex catalog models from coding agent model options", () => {
		const options = parseCodexModelCatalog(
			JSON.stringify({
				models: [
					{
						slug: "gpt-5.5",
						display_name: "GPT-5.5",
						visibility: "list",
					},
					{
						slug: "codex-auto-review",
						display_name: "Codex Auto Review",
						visibility: "hide",
					},
				],
			}),
		);

		expect(options).toEqual([{ modelId: "gpt-5.5", label: "GPT-5.5", modelSelectionGroup: "latest_tracking_alias" }]);
	});

	it("stamps a selection group on every option so agents without tiers stay cache-migratable", () => {
		// 前端靠「有 option 却无一条带分档」识别 `modelSelectionGroup` 引入前写下的旧 localStorage 缓存。
		// 那条判据只有在后端给每个 option 都填了分档时才成立；codex / cursor 的解析本身不区分档位，
		// 一旦它们的响应缺分档，就会被永久判成过期缓存、再也 seed 不了。
		const codexOptions = parseCodexModelCatalog(
			JSON.stringify({ models: [{ slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list" }] }),
		);
		expect(codexOptions.every((option) => option.modelSelectionGroup === "latest_tracking_alias")).toBe(true);

		const claudeOptions = parseClaudeHelpModelAliases(CLAUDE_HELP_STDOUT);
		expect(claudeOptions.every((option) => option.modelSelectionGroup !== undefined)).toBe(true);
	});
});

// driver 已按契约剥掉 ANSI，所以解析器收到的是这样的纯文本表。样本逐字取自 `cursor-agent --list-models`。
const CURSOR_LIST_MODELS_STDOUT = [
	"Available models",
	"",
	"auto - Auto (current, default)",
	"gpt-5.3-codex-high - Codex 5.3 High",
	"claude-4.5-sonnet - Claude Sonnet 4.5",
	"cursor-grok-4.6-high - Cursor Grok 4.6",
	"cursor-grok-4.6-xhigh-fast - Cursor Grok 4.6 Extra High Fast",
	"cursor-grok-4.5-high - Cursor Grok 4.5",
	"composer-2.5-fast - Composer 2.5 Fast",
].join("\n");

describe("parseCursorModelList", () => {
	it("keeps only the grok / composer / auto families Kanban launches Cursor with", () => {
		const modelIds = parseCursorModelList(CURSOR_LIST_MODELS_STDOUT).map((option) => option.modelId);

		// 回归本次的根因：上游给 grok 的 id 加了 `cursor-` 前缀后，写死 `grok-4.5` 的白名单把每一个
		// grok 条目都静默丢掉了，选择器上只剩 auto 与两条 composer。
		expect(modelIds).toEqual([
			"auto",
			"cursor-grok-4.6-high",
			"cursor-grok-4.6-xhigh-fast",
			"cursor-grok-4.5-high",
			"composer-2.5-fast",
		]);
		// Cursor 转售的 GPT / Claude 不在放行范围内。
		expect(modelIds).not.toContain("gpt-5.3-codex-high");
		expect(modelIds).not.toContain("claude-4.5-sonnet");
	});

	it("flags the CLI's current model, whose marker actually reads `(current, default)`", () => {
		const options = parseCursorModelList(CURSOR_LIST_MODELS_STDOUT);

		// 旧实现判的是整串 `(current)`，与真实输出永远对不上，于是这个标记从来没亮起过。
		expect(options.find((option) => option.modelId === "auto")?.isCurrent).toBe(true);
		expect(options.find((option) => option.modelId === "cursor-grok-4.6-high")?.isCurrent).toBeUndefined();
	});

	it("ignores lines that are not `id - label` rows", () => {
		expect(parseCursorModelList("Available models\n\n   \nnot a row").map((option) => option.modelId)).toEqual([]);
	});
});

// cursor 是唯一**无条件**注入 `--model` 的 adapter，所以这个选择直接进每一次 Cursor 会话的 argv，
// 同时决定模型选择器上那颗 Default chip 指向谁。
describe("selectCursorLaunchDefaultModelIdFromCatalog", () => {
	const buildCatalogOptions = (modelIds: readonly string[]): RuntimeTerminalAgentModelSelectionOption[] =>
		modelIds.map((modelId) => ({ modelId, label: modelId, modelSelectionGroup: "latest_tracking_alias" as const }));

	// grok 4.6 各档在真实 `cursor-agent --list-models` 里的**原始顺序**：fast 档排在最前，
	// 非 fast 的 low / medium / high / xhigh 全在它后面。回退次序的正确性完全取决于这个顺序。
	const LATEST_GENERATION_GROK_MODEL_IDS_IN_CATALOG_ORDER = [
		"cursor-grok-4.6-high-fast",
		"cursor-grok-4.6-low",
		"cursor-grok-4.6-low-fast",
		"cursor-grok-4.6-medium",
		"cursor-grok-4.6-medium-fast",
		"cursor-grok-4.6-high",
		"cursor-grok-4.6-xhigh",
		"cursor-grok-4.6-xhigh-fast",
	];

	it("picks the exact `-high` tier even though a fast tier comes first in the catalog", () => {
		const options = buildCatalogOptions([
			"auto",
			...LATEST_GENERATION_GROK_MODEL_IDS_IN_CATALOG_ORDER,
			"composer-2.5",
		]);

		expect(selectCursorLaunchDefaultModelIdFromCatalog(options)).toBe("cursor-grok-4.6-high");
	});

	it("falls back to a non-fast tier instead of the first grok row when the exact `-high` tier is gone", () => {
		// 上游改名或账号权限变化都会造成这一形状。旧实现在这里取目录第一条 grok，
		// 而那恰恰是 `-high-fast`——把低质量档静默钉成每一次会话的启动默认值。
		const options = buildCatalogOptions(
			LATEST_GENERATION_GROK_MODEL_IDS_IN_CATALOG_ORDER.filter((modelId) => modelId !== "cursor-grok-4.6-high"),
		);

		expect(selectCursorLaunchDefaultModelIdFromCatalog(options)).toBe("cursor-grok-4.6-low");
	});

	it("treats a parameterised fast id as fast so it never outranks a plain tier", () => {
		// `[context=…]` 后缀是上游明文支持的写法，挂上之后 `-fast` 不在结尾，但那依然是 fast 档。
		const options = buildCatalogOptions(["cursor-grok-4.6-medium-fast[context=1m]", "cursor-grok-4.6-medium"]);

		expect(selectCursorLaunchDefaultModelIdFromCatalog(options)).toBe("cursor-grok-4.6-medium");
	});

	it("settles for a fast tier only when the whole generation is fast", () => {
		const options = buildCatalogOptions(["auto", "cursor-grok-4.6-medium-fast", "cursor-grok-4.6-low-fast"]);

		expect(selectCursorLaunchDefaultModelIdFromCatalog(options)).toBe("cursor-grok-4.6-medium-fast");
	});

	it("returns null when the catalog lists no grok at all, leaving the probe-failure fallback to the caller", () => {
		expect(selectCursorLaunchDefaultModelIdFromCatalog(buildCatalogOptions(["auto", "composer-2.5"]))).toBeNull();
	});
});

// 逐字取自 `kimi provider list --json`（截断到本模块实际读取的字段）。
const KIMI_PROVIDER_LIST_JSON_STDOUT = JSON.stringify({
	providers: { "managed:kimi-code": { type: "kimi", apiKey: "", baseUrl: "https://api.kimi.com/coding/v1" } },
	models: {
		"kimi-code/kimi-for-coding": {
			provider: "managed:kimi-code",
			model: "kimi-for-coding",
			displayName: "K2.7 Coding",
		},
		"kimi-code/k3": { provider: "managed:kimi-code", model: "k3", displayName: "K3" },
		"kimi-code/k3-256k": { provider: "managed:kimi-code", model: "k3-256k", displayName: "K3-256k" },
	},
});

describe("parseKimiProviderModelCatalog", () => {
	it("uses the alias as the model id and the display name as the label", () => {
		expect(parseKimiProviderModelCatalog(KIMI_PROVIDER_LIST_JSON_STDOUT)).toEqual([
			{ modelId: "kimi-code/kimi-for-coding", label: "K2.7 Coding", modelSelectionGroup: "latest_tracking_alias" },
			{ modelId: "kimi-code/k3", label: "K3", modelSelectionGroup: "latest_tracking_alias" },
			{ modelId: "kimi-code/k3-256k", label: "K3-256k", modelSelectionGroup: "latest_tracking_alias" },
		]);
	});

	it("falls back to the alias when a model carries no display name", () => {
		const options = parseKimiProviderModelCatalog(JSON.stringify({ models: { "kimi-code/k9": {} } }));

		expect(options).toEqual([
			{ modelId: "kimi-code/k9", label: "kimi-code/k9", modelSelectionGroup: "latest_tracking_alias" },
		]);
	});

	it("returns nothing when the payload carries no models map", () => {
		expect(parseKimiProviderModelCatalog(JSON.stringify({ providers: {} }))).toEqual([]);
	});
});

// 合法性判据（能不能启动）与展示判据（要不要出现在 chip 行）刻意分离：前者必须继续接受过时代次，
// 否则钉在旧模型上的卡片会被 zod 契约与启动参数校验双双拒绝。
describe("isKanbanCursorAgentModelId", () => {
	it("accepts every grok naming scheme upstream has used, current and previous generations alike", () => {
		for (const modelId of [
			"cursor-grok-4.6-high",
			"cursor-grok-4.6-xhigh-fast",
			"cursor-grok-4.5-high",
			"grok-4.5-high",
			"grok-4.5[context=1m]",
		]) {
			expect(isKanbanCursorAgentModelId(modelId)).toBe(true);
		}
	});

	it("accepts auto and the composer family", () => {
		expect(isKanbanCursorAgentModelId("auto")).toBe(true);
		expect(isKanbanCursorAgentModelId("composer")).toBe(true);
		expect(isKanbanCursorAgentModelId("composer-2.5-fast")).toBe(true);
	});

	it("rejects the models Cursor merely resells", () => {
		for (const modelId of ["gpt-5.3-codex-high", "claude-4.5-sonnet", "gemini-3-pro", "glm-4.6", "  "]) {
			expect(isKanbanCursorAgentModelId(modelId)).toBe(false);
		}
	});
});

// 恢复既有会话时要把「转录里观测到的裸 model id」翻译成能交给 CLI 的启动 id。
// 转录物理上从不记录 `[1m]` 后缀，直接用裸 id 启动会把 1M 会话静默降到 200k。
describe("resolveClaudeLaunchModelIdentityForObservedTranscriptModelIdentity", () => {
	it("upgrades an observed bare model id to its 1M variant so resuming never silently drops to 200k", () => {
		expect(resolveClaudeLaunchModelIdentityForObservedTranscriptModelIdentity("claude-opus-5")).toBe(
			"claude-opus-5[1m]",
		);
		expect(resolveClaudeLaunchModelIdentityForObservedTranscriptModelIdentity("claude-fable-5")).toBe(
			"claude-fable-5[1m]",
		);
	});

	it("keeps the bare id when the curated table has no 1M variant for it", () => {
		// claude-haiku-4-5 / claude-sonnet-4-6 在策展表里都只有 200k 一档。
		expect(resolveClaudeLaunchModelIdentityForObservedTranscriptModelIdentity("claude-haiku-4-5")).toBe(
			"claude-haiku-4-5",
		);
		expect(resolveClaudeLaunchModelIdentityForObservedTranscriptModelIdentity("claude-sonnet-4-6")).toBe(
			"claude-sonnet-4-6",
		);
	});

	it("passes through ids the curated table has never heard of so a new upstream model keeps its generation", () => {
		// 策展表漏补新版本时，保住「代次正确」优先于保住 1M——总好过继续跑在完全不同的模型上。
		expect(resolveClaudeLaunchModelIdentityForObservedTranscriptModelIdentity("claude-opus-9")).toBe("claude-opus-9");
	});

	it("returns null for blank input instead of emitting an empty --model value", () => {
		expect(resolveClaudeLaunchModelIdentityForObservedTranscriptModelIdentity("   ")).toBeNull();
	});
});

// 恢复流程用这三个谓词决定「能不能回写卡片」「要不要连启动都别顶替」。
describe("claude model selection option tier predicates", () => {
	it("recognises curated ids from both tiers and rejects unknown ones", () => {
		expect(isClaudeCodeCuratedTerminalAgentModelSelectionOptionId("opus")).toBe(true);
		expect(isClaudeCodeCuratedTerminalAgentModelSelectionOptionId("claude-opus-5[1m]")).toBe(true);
		expect(isClaudeCodeCuratedTerminalAgentModelSelectionOptionId("claude-opus-9")).toBe(false);
	});

	it("separates latest-tracking aliases from pinned versions so resuming never demotes a follow-latest card", () => {
		expect(isClaudeCodeLatestTrackingAliasModelSelectionOptionId("opus")).toBe(true);
		expect(isClaudeCodeLatestTrackingAliasModelSelectionOptionId("fable[1m]")).toBe(true);
		expect(isClaudeCodeLatestTrackingAliasModelSelectionOptionId("opusplan")).toBe(true);
		expect(isClaudeCodeLatestTrackingAliasModelSelectionOptionId("claude-opus-5")).toBe(false);
	});

	it("flags opusplan as phase-switching so a transcript model can never replace the strategy", () => {
		// opusplan 是「计划期 Opus、其余 Sonnet」的策略，不是模型；转录只记录当轮实际模型。
		expect(isClaudeCodePhaseSwitchingCompositeModelSelectionOptionId("opusplan")).toBe(true);
		expect(isClaudeCodePhaseSwitchingCompositeModelSelectionOptionId("opus")).toBe(false);
		expect(isClaudeCodePhaseSwitchingCompositeModelSelectionOptionId("claude-sonnet-5[1m]")).toBe(false);
	});
});
