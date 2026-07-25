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
			// 逐字段重建，所以每个新增字段都必须在这里显式透传，否则会被静默吃掉。
			// 分档缺省补 `latest_tracking_alias`（codex / cursor 的解析本来就不产出该字段），
			// 让「本模块产出的每个 option 都带分档」成为一条不变量：前端据此把「有 option 却无一条
			// 带分档」判定为本字段引入前写下的旧 localStorage 缓存，从而跨 agent 通用地把它当作
			// cache miss，而不会误伤 codex / cursor。
			modelSelectionGroup: option.modelSelectionGroup ?? "latest_tracking_alias",
		});
	}
	return deduplicated;
}

export function parseCodexModelCatalog(stdout: string): RuntimeTerminalAgentModelSelectionOption[] {
	const parsed = JSON.parse(stdout) as {
		models?: Array<{ slug?: unknown; display_name?: unknown; visibility?: unknown }>;
	};
	const models = Array.isArray(parsed.models) ? parsed.models : [];
	return deduplicateModelOptions(
		models.flatMap((model): RuntimeTerminalAgentModelSelectionOption[] => {
			const modelId = typeof model.slug === "string" ? model.slug.trim() : "";
			const visibility = typeof model.visibility === "string" ? model.visibility.trim() : "";
			if (!modelId || visibility === "hide") {
				return [];
			}
			const displayName = typeof model.display_name === "string" ? model.display_name.trim() : "";
			const label = displayName || modelId;
			return [{ modelId, label }];
		}),
	);
}

// ponytail: Claude Code CLI 没有可编程的模型目录（没有 `claude models` 子命令，`--help` 的
// `--model` 行只举三个示例别名），所以策展表必须保留。它按语义分成两档，以根除上一版
// 「把 latest 别名标成某个具体版本号」造成的错标（`opus` 一路解析到最新 Opus，标签却停在 4.8）：
//
//   1. 别名档：label / description 都不写版本号。上游发布新模型时**无需改动这里**，也不可能标错。
//   2. 钉版本档：用 `--help` 明文支持的完整模型名（"or a model's full name"）钉死到具体版本。
//      新版本发布后漏补，后果只是少一个选项，不会有按钮跑到与标签不符的模型上。
//
// 两档的条目取自 `claude` 二进制内嵌的 `/model` 选择器表，并逐条用
// `claude --model <id> -p … --output-format json` 回读 `modelUsage` 实测过解析结果与上下文窗口。
const CLAUDE_CODE_LATEST_TRACKING_ALIAS_OPTIONS: RuntimeTerminalAgentModelSelectionOption[] = (
	[
		{ modelId: "opus", label: "Opus", description: "--model opus · latest Opus" },
		{ modelId: "opus[1m]", label: "Opus · 1M", description: "--model opus[1m] · latest Opus, 1M context" },
		{ modelId: "sonnet", label: "Sonnet", description: "--model sonnet · latest Sonnet" },
		{ modelId: "sonnet[1m]", label: "Sonnet · 1M", description: "--model sonnet[1m] · latest Sonnet, 1M context" },
		{ modelId: "haiku", label: "Haiku", description: "--model haiku · latest Haiku" },
		{ modelId: "fable", label: "Fable", description: "--model fable · latest Fable" },
		{ modelId: "fable[1m]", label: "Fable · 1M", description: "--model fable[1m] · latest Fable, 1M context" },
		{ modelId: "opusplan", label: "Opus Plan", description: "--model opusplan · Opus while planning, else Sonnet" },
	] satisfies Omit<RuntimeTerminalAgentModelSelectionOption, "modelSelectionGroup">[]
).map((option) => ({ ...option, modelSelectionGroup: "latest_tracking_alias" as const }));

const CLAUDE_CODE_PINNED_VERSION_OPTIONS: RuntimeTerminalAgentModelSelectionOption[] = (
	[
		{ modelId: "claude-opus-5", label: "Opus 5", description: "claude-opus-5" },
		{ modelId: "claude-opus-5[1m]", label: "Opus 5 · 1M", description: "claude-opus-5[1m] · 1M context" },
		{ modelId: "claude-opus-4-8", label: "Opus 4.8", description: "claude-opus-4-8 · previous Opus version" },
		{ modelId: "claude-opus-4-8[1m]", label: "Opus 4.8 · 1M", description: "claude-opus-4-8[1m] · 1M context" },
		{ modelId: "claude-opus-4-7", label: "Opus 4.7", description: "claude-opus-4-7 · legacy" },
		{ modelId: "claude-opus-4-7[1m]", label: "Opus 4.7 · 1M", description: "claude-opus-4-7[1m] · 1M context" },
		{ modelId: "claude-opus-4-6", label: "Opus 4.6", description: "claude-opus-4-6 · legacy" },
		{ modelId: "claude-opus-4-6[1m]", label: "Opus 4.6 · 1M", description: "claude-opus-4-6[1m] · 1M context" },
		{ modelId: "claude-sonnet-5", label: "Sonnet 5", description: "claude-sonnet-5" },
		{ modelId: "claude-sonnet-5[1m]", label: "Sonnet 5 · 1M", description: "claude-sonnet-5[1m] · 1M context" },
		{
			modelId: "claude-sonnet-4-6",
			label: "Sonnet 4.6",
			description: "claude-sonnet-4-6 · previous Sonnet version",
		},
		{ modelId: "claude-haiku-4-5", label: "Haiku 4.5", description: "claude-haiku-4-5" },
		{ modelId: "claude-fable-5", label: "Fable 5", description: "claude-fable-5" },
		{ modelId: "claude-fable-5[1m]", label: "Fable 5 · 1M", description: "claude-fable-5[1m] · 1M context" },
	] satisfies Omit<RuntimeTerminalAgentModelSelectionOption, "modelSelectionGroup">[]
).map((option) => ({ ...option, modelSelectionGroup: "pinned_version" as const }));

// 实测被 CLI 拒绝或悄悄改写、因而**故意不列**的候选（列出来就会重演本次「按钮标签与实跑模型不符」的 bug）：
//   claude-opus-4-1  → 已退役，被 legacy remap 改写成 claude-opus-5（标签会说谎）
//   claude-3-5-haiku → 404 不可用
//   mythos / claude-mythos-5 → 404，二进制 catalog 里有但当前账号取不到
//   claude-sonnet-4-6[1m] → 二进制 picker 表里有，但连续 5 次实测都拿到上游 503（不是 404），
//                            无法证实解析结果，故本轮不列；上游恢复后按下方方式复核再补。
// 复核方式：`claude --model <id> -p 1 --output-format json --tools ""`，读 modelUsage 的键与 contextWindow。

export function parseClaudeHelpModelAliases(stdout: string): RuntimeTerminalAgentModelSelectionOption[] {
	const helpAliases: string[] = [];
	const aliasMatch = stdout.match(/e\.g\.\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*or\s*'([^']+)'/);
	if (aliasMatch) {
		for (const alias of aliasMatch.slice(1)) {
			const trimmed = alias?.trim();
			if (trimmed) {
				helpAliases.push(trimmed);
			}
		}
	}
	// 策展条目在前（别名档 → 钉版本档），`--help` 自动发现的其余别名垫底。dedup 保留首次出现，
	// 所以已知条目用策展 label，只有策展表未覆盖的新别名才退回「首字母大写」占位。
	const curatedOptions = [...CLAUDE_CODE_LATEST_TRACKING_ALIAS_OPTIONS, ...CLAUDE_CODE_PINNED_VERSION_OPTIONS];
	const curatedByModelId = new Map(curatedOptions.map((option) => [option.modelId, option]));
	return deduplicateModelOptions([
		...curatedOptions,
		...helpAliases
			.filter((modelId) => !curatedByModelId.has(modelId))
			.map((modelId) => ({
				modelId,
				label: modelId.charAt(0).toUpperCase() + modelId.slice(1),
				modelSelectionGroup: "latest_tracking_alias" as const,
			})),
	]);
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
			defaultLabel: "Default · Cursor Grok 4.5 High",
			// 也走 dedupe 是为了守住「本模块产出的每个 option 都带分档」这条不变量：降级响应通常带
			// warning 因而不会被前端缓存，但 `error.message` 为空时 warning 字段会被省略、响应看起来
			// 「成功」并落盘，届时缺分档就会被误判成旧缓存。
			options: deduplicateModelOptions([
				{ modelId: "auto", label: "Auto" },
				{ modelId: "grok-4.5-fast-high", label: "Cursor Grok 4.5 High Fast" },
			]),
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
			defaultLabel: "Default · Cursor Grok 4.5 High",
			options,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return buildFallbackResponse(agentId, message);
	}
}
