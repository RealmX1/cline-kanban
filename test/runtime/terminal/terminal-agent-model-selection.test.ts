import { describe, expect, it } from "vitest";

import { parseCodexModelCatalog } from "../../../src/terminal/terminal-agent-model-selection";

describe("terminal agent model selection", () => {
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
