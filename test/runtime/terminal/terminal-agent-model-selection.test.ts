import { describe, expect, it } from "vitest";

import {
	isClaudeCodeCuratedTerminalAgentModelSelectionOptionId,
	isClaudeCodeLatestTrackingAliasModelSelectionOptionId,
	isClaudeCodePhaseSwitchingCompositeModelSelectionOptionId,
	parseClaudeHelpModelAliases,
	parseCodexModelCatalog,
	resolveClaudeLaunchModelIdentityForObservedTranscriptModelIdentity,
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
