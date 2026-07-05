import { describe, expect, it } from "vitest";

import {
	parseClaudeHelpModelAliases,
	parseCodexModelCatalog,
} from "../../../src/terminal/terminal-agent-model-selection";

// A representative `claude --help` `--model` line: only 3 example aliases, no haiku, no versions.
const CLAUDE_HELP_STDOUT = `  --model <model>  Model for the current session. e.g. 'sonnet', 'opus', or 'opusplan'.`;

describe("terminal agent model selection", () => {
	it("supplements Claude Code aliases with haiku + curated version labels and concrete model-ids", () => {
		const options = parseClaudeHelpModelAliases(CLAUDE_HELP_STDOUT);
		const byModelId = new Map(options.map((option) => [option.modelId, option]));

		// haiku is absent from --help yet must always surface.
		expect(byModelId.get("haiku")).toEqual({
			modelId: "haiku",
			label: "Haiku 4.5",
			description: "claude-haiku-4-5-20251001",
		});
		// Curated categories carry versioned labels + concrete model-ids for the hover tooltip.
		expect(byModelId.get("opus")).toEqual({ modelId: "opus", label: "Opus 4.8", description: "claude-opus-4-8" });
		expect(byModelId.get("sonnet")).toEqual({ modelId: "sonnet", label: "Sonnet 5", description: "claude-sonnet-5" });
		expect(byModelId.get("fable")).toEqual({ modelId: "fable", label: "Fable 5", description: "claude-fable-5" });
		// A help-advertised alias we don't curate still surfaces (auto-discovery preserved), capitalized fallback.
		expect(byModelId.get("opusplan")).toEqual({ modelId: "opusplan", label: "Opusplan" });
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

		expect(options).toEqual([{ modelId: "gpt-5.5", label: "GPT-5.5" }]);
	});
});
