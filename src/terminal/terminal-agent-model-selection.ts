import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { isKanbanCursorAgentModelId, KANBAN_CURSOR_AGENT_DEFAULT_MODEL_ID } from "../core/agent-catalog";
import type {
	RuntimeTerminalAgentModelSelectionAgentId,
	RuntimeTerminalAgentModelSelectionOption,
	RuntimeTerminalAgentModelSelectionOptionsResponse,
} from "../core/api-contract";

const execFileAsync = promisify(execFile);
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function deduplicateModelOptions(
	options: RuntimeTerminalAgentModelSelectionOption[],
): RuntimeTerminalAgentModelSelectionOption[] {
	const seen = new Set<string>();
	const deduplicated: RuntimeTerminalAgentModelSelectionOption[] = [];
	for (const option of options) {
		const modelId = option.modelId.trim();
		if (!modelId || seen.has(modelId)) {
			continue;
		}
		seen.add(modelId);
		deduplicated.push({
			modelId,
			label: option.label.trim() || modelId,
			...(option.description ? { description: option.description } : {}),
			...(option.isCurrent ? { isCurrent: true } : {}),
		});
	}
	return deduplicated;
}

function parseCodexModelCatalog(stdout: string): RuntimeTerminalAgentModelSelectionOption[] {
	const parsed = JSON.parse(stdout) as {
		models?: Array<{ slug?: unknown; display_name?: unknown }>;
	};
	const models = Array.isArray(parsed.models) ? parsed.models : [];
	return deduplicateModelOptions(
		models.flatMap((model): RuntimeTerminalAgentModelSelectionOption[] => {
			const modelId = typeof model.slug === "string" ? model.slug.trim() : "";
			if (!modelId) {
				return [];
			}
			const displayName = typeof model.display_name === "string" ? model.display_name.trim() : "";
			const label = displayName || modelId;
			return [{ modelId, label }];
		}),
	);
}

function parseClaudeHelpModelAliases(stdout: string): RuntimeTerminalAgentModelSelectionOption[] {
	const aliases = new Set<string>();
	const aliasMatch = stdout.match(/e\.g\.\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*or\s*'([^']+)'/);
	if (aliasMatch) {
		for (const alias of aliasMatch.slice(1)) {
			if (alias) {
				aliases.add(alias.trim());
			}
		}
	}
	for (const alias of ["sonnet", "opus", "fable"]) {
		aliases.add(alias);
	}
	return deduplicateModelOptions(
		[...aliases].map((alias) => ({
			modelId: alias,
			label: alias.charAt(0).toUpperCase() + alias.slice(1),
		})),
	);
}

function parseCursorModelList(stdout: string): RuntimeTerminalAgentModelSelectionOption[] {
	const stripped = stdout.replace(ANSI_PATTERN, "");
	const options: RuntimeTerminalAgentModelSelectionOption[] = [];
	for (const line of stripped.split(/\r?\n/)) {
		const match = line.match(/^\s*([A-Za-z0-9_.:-]+)\s+-\s+(.+?)\s*$/);
		if (!match) {
			continue;
		}
		const modelId = match[1]?.trim() ?? "";
		const label = match[2]?.trim() ?? modelId;
		if (!isKanbanCursorAgentModelId(modelId)) {
			continue;
		}
		options.push({
			modelId,
			label,
			...(label.includes("(current)") ? { isCurrent: true } : {}),
		});
	}
	return deduplicateModelOptions(options);
}

function buildFallbackResponse(
	agentId: RuntimeTerminalAgentModelSelectionAgentId,
	warning?: string,
): RuntimeTerminalAgentModelSelectionOptionsResponse {
	if (agentId === "cursor") {
		return {
			agentId,
			defaultModelId: KANBAN_CURSOR_AGENT_DEFAULT_MODEL_ID,
			defaultLabel: "Default · Composer 2.5",
			options: [
				{ modelId: "auto", label: "Auto" },
				{ modelId: "composer-2.5-fast", label: "Composer 2.5 Fast" },
			],
			...(warning ? { warning } : {}),
		};
	}
	return {
		agentId,
		defaultModelId: null,
		defaultLabel: "Default",
		options: [],
		...(warning ? { warning } : {}),
	};
}

async function loadCodexModelOptions(): Promise<RuntimeTerminalAgentModelSelectionOption[]> {
	const result = await execFileAsync("codex", ["debug", "models"], { timeout: 10_000, maxBuffer: 1024 * 1024 });
	return parseCodexModelCatalog(result.stdout);
}

async function loadClaudeModelOptions(): Promise<RuntimeTerminalAgentModelSelectionOption[]> {
	const result = await execFileAsync("claude", ["--help"], { timeout: 10_000, maxBuffer: 512 * 1024 });
	return parseClaudeHelpModelAliases(result.stdout);
}

async function loadCursorModelOptions(): Promise<RuntimeTerminalAgentModelSelectionOption[]> {
	const result = await execFileAsync("cursor-agent", ["--list-models"], { timeout: 15_000, maxBuffer: 1024 * 1024 });
	return parseCursorModelList(result.stdout);
}

export async function getTerminalAgentModelSelectionOptions(
	agentId: RuntimeTerminalAgentModelSelectionAgentId,
): Promise<RuntimeTerminalAgentModelSelectionOptionsResponse> {
	try {
		if (agentId === "codex") {
			return {
				agentId,
				defaultModelId: null,
				defaultLabel: "Default",
				options: await loadCodexModelOptions(),
			};
		}
		if (agentId === "claude") {
			return {
				agentId,
				defaultModelId: null,
				defaultLabel: "Default",
				options: await loadClaudeModelOptions(),
			};
		}
		const options = await loadCursorModelOptions();
		return {
			agentId,
			defaultModelId: KANBAN_CURSOR_AGENT_DEFAULT_MODEL_ID,
			defaultLabel: "Default · Composer 2.5",
			options,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return buildFallbackResponse(agentId, message);
	}
}
