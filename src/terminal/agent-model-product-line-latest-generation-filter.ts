import type {
	RuntimeTerminalAgentModelSelectionAgentId,
	RuntimeTerminalAgentModelSelectionOption,
} from "../core/api-contract";

/**
 * 一条产品线的识别规则：把「这个 option 属于哪条产品线、是第几代」这一判断显式写死。
 *
 * 刻意**不**用一条试图通吃的万能正则——三个 CLI 的命名范式互不相同
 * （`cursor-grok-4.6-high` / `gpt-5.6-sol` / id `kimi-code/k3` 而版本号在 label `K3` 里），
 * 通吃正则必然在某一家上误伤。
 */
type TerminalAgentModelProductLineRule = {
	/** 产品线标识，仅用于把同线 option 归到一组比较代次；不出现在 UI 上。 */
	readonly productLineKey: string;
	/** 抽出该 option 在本产品线里的代次版本号（点分数字串）；不属于本产品线时返回 null。 */
	readonly extractGenerationVersion: (option: RuntimeTerminalAgentModelSelectionOption) => string | null;
};

function extractGenerationVersionFromModelId(
	pattern: RegExp,
): (option: RuntimeTerminalAgentModelSelectionOption) => string | null {
	return (option) => option.modelId.trim().match(pattern)?.[1] ?? null;
}

function extractGenerationVersionFromLabel(
	pattern: RegExp,
): (option: RuntimeTerminalAgentModelSelectionOption) => string | null {
	return (option) => option.label.trim().match(pattern)?.[1] ?? null;
}

/**
 * 每 agent 一张产品线规则表。没有条目的 agent（如 claude）整表跳过、原样返回——
 * claude 的选项来自策展表，别名档天然就是「每产品线最新」，钉版本档的存在意义恰恰是刻意钉旧版本。
 */
const TERMINAL_AGENT_MODEL_PRODUCT_LINE_RULES: Partial<
	Record<RuntimeTerminalAgentModelSelectionAgentId, readonly TerminalAgentModelProductLineRule[]>
> = {
	// `auto` 不匹配任何规则 ⇒ 由 fail-open 保留，无需特例。
	cursor: [
		// 上游后来给 grok 的 model id 加了 `cursor-` 前缀（`grok-4.5-high` → `cursor-grok-4.6-high`），
		// 两种写法都要认，否则改名当天整条产品线会被判成「无版本」而全部逃过收敛。
		// 前缀分隔符连 `/` 一并认（`xai/grok-5-high`），与 `isKanbanCursorAgentModelId` 的家族判定保持同一套边界。
		{
			productLineKey: "grok",
			extractGenerationVersion: extractGenerationVersionFromModelId(/(?:^|[-/])grok-(\d+(?:\.\d+)*)/),
		},
		{
			productLineKey: "composer",
			extractGenerationVersion: extractGenerationVersionFromModelId(/(?:^|[-/])composer-(\d+(?:\.\d+)*)/),
		},
	],
	// GPT-5.6 起命名范式改成「代次 + 代号」（sol / terra / luna），5.5 及更早是同一条产品线的旧代次，
	// `gpt-5.4-mini`、`gpt-5.3-codex-spark` 同理——一并按代次收敛掉，不各自成线。
	codex: [
		{ productLineKey: "gpt", extractGenerationVersion: extractGenerationVersionFromModelId(/^gpt-(\d+(?:\.\d+)*)/) },
	],
	// Kimi 的 model id 里没有版本号（`kimi-code/k3` vs `kimi-code/kimi-for-coding`），
	// 版本号只在 displayName 里（`K3` / `K2.7 Coding`），所以这条规则读 label。
	kimi: [
		{ productLineKey: "kimi", extractGenerationVersion: extractGenerationVersionFromLabel(/\bK(\d+(?:\.\d+)*)\b/) },
	],
};

function compareGenerationVersions(left: string, right: string): number {
	const leftSegments = left.split(".");
	const rightSegments = right.split(".");
	const segmentCount = Math.max(leftSegments.length, rightSegments.length);
	for (let index = 0; index < segmentCount; index += 1) {
		const leftSegment = Number.parseInt(leftSegments[index] ?? "0", 10);
		const rightSegment = Number.parseInt(rightSegments[index] ?? "0", 10);
		if (leftSegment !== rightSegment) {
			return leftSegment < rightSegment ? -1 : 1;
		}
	}
	return 0;
}

/**
 * 每条产品线只保留最新一代，代内所有分体（low/medium/high/xhigh、fast、256k…）全留。
 *
 * **fail-open**：匹配不到任何规则的 option 一律保留。这正是本模块要防的那个 bug 的教训——
 * 写死版本号的白名单在上游改名当天把 14 个 grok 条目静默吞光。宁可多显示一个过时选项，
 * 绝不因为规则没跟上就让新模型消失。
 */
export function filterTerminalAgentModelOptionsToLatestProductLineGeneration(
	agentId: RuntimeTerminalAgentModelSelectionAgentId,
	options: readonly RuntimeTerminalAgentModelSelectionOption[],
): RuntimeTerminalAgentModelSelectionOption[] {
	const rules = TERMINAL_AGENT_MODEL_PRODUCT_LINE_RULES[agentId];
	if (!rules || rules.length === 0) {
		return [...options];
	}
	const classifiedProductLineByOptionIndex = new Map<number, { productLineKey: string; generationVersion: string }>();
	const latestGenerationVersionByProductLineKey = new Map<string, string>();
	options.forEach((option, optionIndex) => {
		for (const rule of rules) {
			const generationVersion = rule.extractGenerationVersion(option);
			if (!generationVersion) {
				continue;
			}
			classifiedProductLineByOptionIndex.set(optionIndex, {
				productLineKey: rule.productLineKey,
				generationVersion,
			});
			const latestGenerationVersion = latestGenerationVersionByProductLineKey.get(rule.productLineKey);
			if (!latestGenerationVersion || compareGenerationVersions(generationVersion, latestGenerationVersion) > 0) {
				latestGenerationVersionByProductLineKey.set(rule.productLineKey, generationVersion);
			}
			return;
		}
	});
	return options.filter((_option, optionIndex) => {
		const classifiedProductLine = classifiedProductLineByOptionIndex.get(optionIndex);
		if (!classifiedProductLine) {
			return true;
		}
		return (
			latestGenerationVersionByProductLineKey.get(classifiedProductLine.productLineKey) ===
			classifiedProductLine.generationVersion
		);
	});
}
