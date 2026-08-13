import {
	isKanbanCursorAgentGrokModelId,
	isKanbanCursorAgentModelId,
	KANBAN_CURSOR_AGENT_PROBE_FAILURE_FALLBACK_MODEL_ID,
} from "../core/agent-catalog";
import type {
	RuntimeTerminalAgentModelSelectionAgentId,
	RuntimeTerminalAgentModelSelectionOption,
	RuntimeTerminalAgentModelSelectionOptionsResponse,
} from "../core/api-contract";
import { type AgentCliCapabilityProbeContract, runAgentCliCapabilityProbe } from "./agent-cli-capability-probe-runner";
import { filterTerminalAgentModelOptionsToLatestProductLineGeneration } from "./agent-model-product-line-latest-generation-filter";

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

const CLAUDE_CODE_CURATED_MODEL_IDS: ReadonlySet<string> = new Set(
	[...CLAUDE_CODE_LATEST_TRACKING_ALIAS_OPTIONS, ...CLAUDE_CODE_PINNED_VERSION_OPTIONS].map(
		(option) => option.modelId,
	),
);
const CLAUDE_CODE_PINNED_VERSION_MODEL_IDS: ReadonlySet<string> = new Set(
	CLAUDE_CODE_PINNED_VERSION_OPTIONS.map((option) => option.modelId),
);
const CLAUDE_CODE_LATEST_TRACKING_ALIAS_MODEL_IDS: ReadonlySet<string> = new Set(
	CLAUDE_CODE_LATEST_TRACKING_ALIAS_OPTIONS.map((option) => option.modelId),
);
// 别名档里唯一「按阶段在多个模型间切换」的条目：opusplan = 计划期 Opus、其余阶段 Sonnet。
// 它是一条**策略**而不是一个模型，转录里只会留下某一阶段跑的具体 model id，因此「从转录读回的模型」
// 根本无法表达它——把它换成具体 id 就等于永久销毁用户选的策略。单独成集是为了让这条语义在调用点可判定。
const CLAUDE_CODE_PHASE_SWITCHING_COMPOSITE_MODEL_IDS: ReadonlySet<string> = new Set(["opusplan"]);

// 这个 model id 是不是策展表里的条目 ⇒ 模型选择器一定认得、能显示出选中态。
// 纯同步判断，刻意**不**走 getTerminalAgentModelSelectionOptions：那个要 spawn `claude --help`，
// 不该压在会话启动路径上；而策展表本来就是那个响应里恒定在前的那一段。
export function isClaudeCodeCuratedTerminalAgentModelSelectionOptionId(modelId: string): boolean {
	return CLAUDE_CODE_CURATED_MODEL_IDS.has(modelId.trim());
}

// 这个 model id 是不是「跟随最新版本」的别名档条目（opus / sonnet / fable / haiku / opusplan …）。
// 别名表达的是**策略**（永远跟最新那一代），钉版本 id 表达的是**具体版本**；把前者改写成后者，用户下次
// 上游发新模型时就再也跟不上了，且卡片上看不出发生过降级。恢复流程据此避免回写这类卡片。
export function isClaudeCodeLatestTrackingAliasModelSelectionOptionId(modelId: string): boolean {
	return CLAUDE_CODE_LATEST_TRACKING_ALIAS_MODEL_IDS.has(modelId.trim());
}

// 这个 model id 是不是「按阶段切换模型」的复合策略（当前只有 opusplan）。
// 这类选择连**本次启动**都不能用转录读回的具体模型顶替：一旦顶替，恢复出来的会话就被钉死在某一阶段的
// 模型上，此后进入计划态也不会再切回去。
export function isClaudeCodePhaseSwitchingCompositeModelSelectionOptionId(modelId: string): boolean {
	return CLAUDE_CODE_PHASE_SWITCHING_COMPOSITE_MODEL_IDS.has(modelId.trim());
}

// 把「转录里观测到的裸 model id」翻译成「能交给 CLI 的启动 id」。
//
// 转录物理上**从不记录 `[1m]` 后缀**（assistant 记录只有 `message.model: "claude-opus-5"`），所以拿裸 id
// 原样去启动，等于把一段本来跑在 1M 上的会话静默降到 200k——那正是当初要用 `--model default` 压过
// `--continue` 模型重建的原因。故这里在策展表里存在 1M 变体时一律取 1M 变体。
//
// 代价（已知且是刻意选的一侧）：用户若在 TUI 里主动选了 200k 变体，恢复时会被升成 1M。裸 id 里没有任何
// 能分辨这两者的信息，而「掉档」是本模块要修的那个方向的错，「升档」不是。
//
// 策展表里完全没有的 id（上游发了新模型、表还没补）返回裸 id 本身：保住**代次正确**优先于保住 1M，
// 总好过继续跑在一个完全不同的模型上。
export function resolveClaudeLaunchModelIdentityForObservedTranscriptModelIdentity(
	observedModelId: string,
): string | null {
	const observed = observedModelId.trim();
	if (!observed) {
		return null;
	}
	const oneMillionContextVariantModelId = `${observed}[1m]`;
	if (CLAUDE_CODE_PINNED_VERSION_MODEL_IDS.has(oneMillionContextVariantModelId)) {
		return oneMillionContextVariantModelId;
	}
	return observed;
}

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

// `cursor-agent --list-models` 打的是给人看的 TUI 表（带 ANSI 颜色，driver 已先剥掉）：
//   auto - Auto (current, default)
//   cursor-grok-4.6-high - Cursor Grok 4.6
//   composer-2.5-fast - Composer 2.5 Fast
// 上游没有 `--json`，两个子命令（`--list-models` / `models`）输出完全一致，所以只能按行刮。
export function parseCursorModelList(stdout: string): RuntimeTerminalAgentModelSelectionOption[] {
	const options: RuntimeTerminalAgentModelSelectionOption[] = [];
	for (const line of stdout.split(/\r?\n/)) {
		// id 的字符集里带上 `/`：上游若改用命名空间前缀（`xai/grok-…`），至少解析得出来、由下游谓词裁决，
		// 而不是在这一层就整行落地——本次的 bug 正是「上游改了 id 形状，某一层默默丢掉」。
		const match = line.match(/^\s*([A-Za-z0-9_./:-]+)\s+-\s+(.+?)\s*$/);
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
			// 实际输出是 `(current, default)`，不是 `(current)`——旧的整串包含判断永远匹配不到，
			// 于是「当前模型」标记从来没亮起过。
			...(/\(current\b[^)]*\)/i.test(label) ? { isCurrent: true } : {}),
		});
	}
	return deduplicateModelOptions(options);
}

// `kimi provider list --json` 是这几个 CLI 里唯一结构化的模型目录：`.models` 以 alias 为键，
// 值里的 `displayName` 才带版本号（`kimi-code/k3` → "K3"）。
// 注意只能用 `list --json`：同族的 `kimi provider catalog` 会**写**配置文件，绝不能进探测路径。
export function parseKimiProviderModelCatalog(stdout: string): RuntimeTerminalAgentModelSelectionOption[] {
	const parsed = JSON.parse(stdout) as { models?: Record<string, { displayName?: unknown }> };
	const models = parsed.models && typeof parsed.models === "object" ? parsed.models : {};
	return deduplicateModelOptions(
		Object.entries(models).flatMap(([modelAlias, model]): RuntimeTerminalAgentModelSelectionOption[] => {
			const modelId = modelAlias.trim();
			if (!modelId) {
				return [];
			}
			const displayName = typeof model?.displayName === "string" ? model.displayName.trim() : "";
			return [{ modelId, label: displayName || modelId }];
		}),
	);
}

type TerminalAgentModelCatalogProbeContract = AgentCliCapabilityProbeContract<
	RuntimeTerminalAgentModelSelectionOption[]
>;

// 每个有模型选择通道的 agent 一行契约。binary / args / timeout / maxBuffer 是纯数据，`parseStdout`
// 是必须写代码的那一半——把两者放进同一张表，就不必为「加一个 agent」再复制一遍执行、超时与降级逻辑。
// 表与解析器同文件，是因为表要引用解析器；执行器（driver）与产品线过滤器各自独立成文件。
const TERMINAL_AGENT_MODEL_CATALOG_PROBE_CONTRACTS: Record<
	RuntimeTerminalAgentModelSelectionAgentId,
	TerminalAgentModelCatalogProbeContract
> = {
	claude: {
		probeId: "claude-code-model-catalog",
		binary: "claude",
		args: ["--help"],
		timeoutMs: 10_000,
		maxBufferBytes: 512 * 1024,
		parseStdout: parseClaudeHelpModelAliases,
	},
	codex: {
		probeId: "codex-model-catalog",
		binary: "codex",
		args: ["debug", "models"],
		timeoutMs: 10_000,
		maxBufferBytes: 1024 * 1024,
		parseStdout: parseCodexModelCatalog,
	},
	cursor: {
		probeId: "cursor-agent-model-catalog",
		binary: "cursor-agent",
		args: ["--list-models"],
		timeoutMs: 15_000,
		maxBufferBytes: 1024 * 1024,
		stripAnsiStyleEscapeSequencesFromStdout: true,
		parseStdout: parseCursorModelList,
	},
	kimi: {
		probeId: "kimi-code-model-catalog",
		binary: "kimi",
		args: ["provider", "list", "--json"],
		timeoutMs: 15_000,
		maxBufferBytes: 1024 * 1024,
		parseStdout: parseKimiProviderModelCatalog,
	},
};

/**
 * 从（已收敛到最新一代的）Cursor 模型目录里挑出会话启动用的默认 model id。
 *
 * 取 grok 的 `-high` 档且非 `-fast`：`-fast` 是低延迟/低质量档，不该成为默认。
 *
 * 回退刻意分三级，而不是「精确 `-high` 找不到就取目录第一条 grok」：真实 `--list-models` 里第一条 grok
 * 恰恰是 `cursor-grok-4.6-high-fast`（`-low` / `-medium` / `-xhigh` 全排在它后面），所以一旦精确 `-high`
 * 档因上游改名或账号权限而缺席，「取第一条」就会静默把 fast 档钉成每一次 Cursor 会话的启动默认值——
 * 与上面这条约束正好相反。fast 档只在整代 grok 全是 fast 时才轮得到。
 */
export function selectCursorLaunchDefaultModelIdFromCatalog(
	options: readonly RuntimeTerminalAgentModelSelectionOption[],
): string | null {
	const grokOptions = options.filter((option) => isKanbanCursorAgentGrokModelId(option.modelId));
	const highTierOption = grokOptions.find((option) => option.modelId.trim().toLowerCase().endsWith("-high"));
	// 判 fast 用 includes 而非 endsWith：`[context=…,effort=…]` 参数化后缀是上游明文支持的写法，
	// 挂上之后 `-fast` 就不在结尾了，但那依然是 fast 档。
	const nonFastOption = grokOptions.find((option) => !option.modelId.trim().toLowerCase().includes("-fast"));
	return highTierOption?.modelId ?? nonFastOption?.modelId ?? grokOptions[0]?.modelId ?? null;
}

async function loadLatestGenerationTerminalAgentModelOptions(
	agentId: RuntimeTerminalAgentModelSelectionAgentId,
): Promise<{ options: RuntimeTerminalAgentModelSelectionOption[]; warning?: string }> {
	const outcome = await runAgentCliCapabilityProbe(TERMINAL_AGENT_MODEL_CATALOG_PROBE_CONTRACTS[agentId]);
	if (!outcome.ok) {
		return { options: [], warning: outcome.warning };
	}
	return { options: filterTerminalAgentModelOptionsToLatestProductLineGeneration(agentId, outcome.value) };
}

/**
 * Cursor 会话启动时要传的 `--model` 值。cursor 是唯一**无条件**注入 `--model` 的 adapter，所以这个值
 * 一旦落后于上游，每一次 Cursor 会话都会带着一个不存在的 model id 启动——上一版的 `grok-4.5-high`
 * 正是如此。因此这里从实际模型目录动态解析，写死的常量只在探测失败时兜底。
 */
export async function resolveCursorLaunchDefaultModelId(): Promise<string> {
	const { options } = await loadLatestGenerationTerminalAgentModelOptions("cursor");
	return selectCursorLaunchDefaultModelIdFromCatalog(options) ?? KANBAN_CURSOR_AGENT_PROBE_FAILURE_FALLBACK_MODEL_ID;
}

function buildCursorDefaultModelLabel(
	options: readonly RuntimeTerminalAgentModelSelectionOption[],
	defaultModelId: string,
): string {
	const defaultOption = options.find((option) => option.modelId === defaultModelId);
	return defaultOption ? `Default · ${defaultOption.label}` : "Default";
}

function buildFallbackResponse(
	agentId: RuntimeTerminalAgentModelSelectionAgentId,
	warning?: string,
): RuntimeTerminalAgentModelSelectionOptionsResponse {
	if (agentId === "cursor") {
		return {
			agentId,
			defaultModelId: KANBAN_CURSOR_AGENT_PROBE_FAILURE_FALLBACK_MODEL_ID,
			defaultLabel: "Default · Cursor Grok",
			// 也走 dedupe 是为了守住「本模块产出的每个 option 都带分档」这条不变量：降级响应通常带
			// warning 因而不会被前端缓存，但 `error.message` 为空时 warning 字段会被省略、响应看起来
			// 「成功」并落盘，届时缺分档就会被误判成旧缓存。
			options: deduplicateModelOptions([{ modelId: "auto", label: "Auto" }]),
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

export async function getTerminalAgentModelSelectionOptions(
	agentId: RuntimeTerminalAgentModelSelectionAgentId,
): Promise<RuntimeTerminalAgentModelSelectionOptionsResponse> {
	const { options, warning } = await loadLatestGenerationTerminalAgentModelOptions(agentId);
	if (warning !== undefined) {
		return buildFallbackResponse(agentId, warning);
	}
	if (agentId !== "cursor") {
		return { agentId, defaultModelId: null, defaultLabel: "Default", options };
	}
	const defaultModelId = selectCursorLaunchDefaultModelIdFromCatalog(options);
	if (!defaultModelId) {
		return buildFallbackResponse(agentId, "cursor-agent listed no grok models to use as the session default.");
	}
	return {
		agentId,
		defaultModelId,
		defaultLabel: buildCursorDefaultModelLabel(options, defaultModelId),
		options,
	};
}
