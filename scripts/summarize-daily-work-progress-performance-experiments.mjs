// 只读取持久原始结果，保留每一对；事实、覆盖或执行失败时拒绝给出保留优化的结论。
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
	"recorder-directory": { type: "string" }, "comparison-directory": { type: "string", multiple: true },
	"output-file": { type: "string" },
} });
if (!values["recorder-directory"] || !values["output-file"]) throw new Error("必须指定 recorder-directory 与 output-file");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const canonicalize = (value) => Array.isArray(value) ? value.map(canonicalize) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key,child]) => [key,canonicalize(child)])) : value;
const cpu = (sample) => sample.user + sample.system;
function historyWindowCount(result) {
	if (result.historyWindowCount !== undefined) return result.historyWindowCount;
	const explicitIndex = result.windows.findIndex((window) => window.flushReason === "explicit");
	if (explicitIndex < 0) throw new Error("无法确认历史与稳态窗口边界");
	return explicitIndex + 1;
}
function sumStage(windows, stage, field) {
	if (windows === null) return null;
	return windows.reduce((total, window) => total + (window.stages[stage]?.[field] ?? 0), 0);
}
function validateAndSplitExperimentCostWindows(result, { comparison, variant, requestedSteadyDurationMs, samplePath }) {
	const invalidEvidence = (reason) => {
		throw new Error(`成本窗口证据不完整：${samplePath}（${reason}）`);
	};
	// 分期采样保留小数毫秒，容许 1 ms 边界误差；原始时长和候选的 60 秒门槛保持原值。
	const experimentPhaseTimingBoundaryToleranceMs = 1;
	const expectedCostRecording = comparison === "recorder" && variant === "A" ? "disabled" : "enabled";
	if (result.options?.["cost-recording"] !== expectedCostRecording || !Array.isArray(result.windows))
		invalidEvidence("刻度开关与实验分组不符，或缺少窗口数组");
	if (
		Number(result.options["steady-duration-ms"]) !== requestedSteadyDurationMs ||
		!Number.isFinite(result.steady.durationMs) || result.steady.durationMs < 0 ||
		result.steady.durationMs + experimentPhaseTimingBoundaryToleranceMs < requestedSteadyDurationMs
	) invalidEvidence("样本稳态时长与执行请求不符");
	if (expectedCostRecording === "disabled") {
		if (result.windows.length !== 0 || (result.historyWindowCount !== undefined && result.historyWindowCount !== 0))
			invalidEvidence("关闭刻度的校准样本仍声明了成本窗口");
		// 只有刻度校准 A 可以缺少成本观测；未知成本不能表示为零。
		return { history: null, steady: null };
	}
	const boundary = historyWindowCount(result);
	if (!Number.isInteger(boundary) || boundary < 1 || boundary >= result.windows.length)
		invalidEvidence("历史分期边界不是有效窗口下标");
	for (const [index, window] of result.windows.entries()) {
		const expectedFlushReason = index === boundary - 1
			? "explicit" : index === result.windows.length - 1 ? "closed" : "interval";
		if (
			window.flushReason !== expectedFlushReason || !Number.isFinite(window.windowDurationMs) ||
			window.windowDurationMs < 0 || !window.stages || !window.counters
		) invalidEvidence("窗口分期、时长或聚合字段非法");
		for (const stage of Object.values(window.stages)) {
			if (["calls", "wallTimeMs", "readBytes", "writeOperations"].some(
				(field) => !Number.isFinite(stage[field]) || stage[field] < 0,
			)) invalidEvidence("阶段成本缺少有效计量");
		}
	}
	const history = result.windows.slice(0, boundary);
	const steady = result.windows.slice(boundary);
	if (sumStage(history, "refresh", "calls") <= 0 || sumStage(history, "refresh", "wallTimeMs") <= 0)
		invalidEvidence("缺少历史 refresh 观测");
	if (
		steady.reduce((total, window) => total + window.windowDurationMs, 0) +
			experimentPhaseTimingBoundaryToleranceMs < requestedSteadyDurationMs
	)
		invalidEvidence("稳态成本窗口未覆盖请求时长");
	if (
		requestedSteadyDurationMs >= 60_000 &&
		(sumStage(steady, "refresh", "calls") <= 0 || sumStage(steady, "refresh", "wallTimeMs") <= 0)
	) invalidEvidence("完整稳态窗口缺少 refresh 观测");
	return { history, steady };
}
function summarize(result, observationRequirements) {
	const { history, steady } = validateAndSplitExperimentCostWindows(result, observationRequirements);
	return {
		costRecordingEnabled: history !== null,
		historyWallTimeMs: result.history.wallTimeMs,
		historyCpuMicroseconds: cpu(result.history.cpuMicroseconds),
		historyEffectiveCollectionMs: sumStage(history, "refresh", "wallTimeMs"),
		historyReceiptMatchMs: sumStage(history, "receipt_match", "wallTimeMs"),
		historyReceiptLedgerReadMs: sumStage(history, "injection_ledger_read", "wallTimeMs"),
		historyCodexValidationAndDiscoveryMs: history === null ? null
			: sumStage(history, "codex_prefix_validation", "wallTimeMs") + sumStage(history, "codex_directory_discovery", "wallTimeMs"),
		historyStatisticsStringifyMs: sumStage(history, "statistics_stringify", "wallTimeMs"),
		steadyDurationMs: result.steady.durationMs,
		steadyCpuMicroseconds: cpu(result.steady.cpuMicroseconds),
		steadyHistoryReadBytes: steady === null ? null
			: sumStage(steady, "transcript_body_read", "readBytes") + sumStage(steady, "codex_prefix_validation", "readBytes"),
		steadyStatisticsWriteOperations: sumStage(steady, "statistics_write", "writeOperations"),
		steadyCodexDirectoryEnumerations: steady === null ? null
			: steady.reduce((sum, window) => sum + (window.counters.codex_directory_enumerations ?? 0), 0),
		steadyEventLoopP95Ms: result.steady.eventLoopP95Ms,
		steadyEventLoopP99Ms: result.steady.eventLoopP99Ms,
		steadyReadOnlyRequestP99Ms: result.steady.readOnlyRequestP99Ms,
		facts: result.history.facts,
		factsPerSecond: result.history.factsPerSecond,
	};
}
async function readCohort(directory, comparison) {
	directory = resolve(directory);
	const executions = await readJson(join(directory, "executions.json"));
	const requestedSteadyDurationMs = Number(executions.options?.["steady-duration-ms"]);
	if (
		executions.options?.comparison !== comparison ||
		!Number.isFinite(requestedSteadyDurationMs) || requestedSteadyDurationMs < 0
	) throw new Error(`实验分组或稳态请求非法：${directory}`);
	if (executions.receipts.length !== 10 || executions.receipts.some((receipt) => receipt.exitCode !== 0 || receipt.moduleChangedDuringRun === true || receipt.hardDeadlineExceeded === true)) throw new Error(`对照存在失败或缺失执行：${directory}`);
	const pairs = [];
	for (let pair = 1; pair <= 5; pair++) {
		const A = await readJson(join(directory, `pair-${pair}-A`, "result.json"));
		const B = await readJson(join(directory, `pair-${pair}-B`, "result.json"));
		if (A.corpusManifestSha256 !== B.corpusManifestSha256 || A.factsHash !== B.factsHash || A.history.facts !== B.history.facts) throw new Error(`事实或语料不等价：${directory} pair ${pair}`);
		const stateA = await readJson(join(directory, `pair-${pair}-A`, "semantic-state.json"));
		const stateB = await readJson(join(directory, `pair-${pair}-B`, "semantic-state.json"));
		if (JSON.stringify(canonicalize(stateA)) !== JSON.stringify(canonicalize(stateB))) throw new Error(`游标、覆盖、告警或事实不等价：${directory} pair ${pair}`);
		pairs.push({ pair,
			A: summarize(A, { comparison, variant: "A", requestedSteadyDurationMs, samplePath: join(directory, `pair-${pair}-A`) }),
			B: summarize(B, { comparison, variant: "B", requestedSteadyDurationMs, samplePath: join(directory, `pair-${pair}-B`) }),
		});
	}
	return { directory, options: executions.options, pairs };
}
const recorder = await readCohort(values["recorder-directory"], "recorder");
const perturbations = recorder.pairs.map(({ pair, A, B }) => ({ pair,
	historyWallPercent: (B.historyWallTimeMs / A.historyWallTimeMs - 1) * 100,
	historyCpuPercent: (B.historyCpuMicroseconds / A.historyCpuMicroseconds - 1) * 100,
}));
const recorderPerturbationThresholdPercent = Math.max(...perturbations.flatMap((pair) => [Math.abs(pair.historyWallPercent), Math.abs(pair.historyCpuPercent)]));
const comparisons = [];
for (const directory of values["comparison-directory"] ?? []) {
	const cohort = await readCohort(directory, "optimizations");
	const effectiveGains = cohort.pairs.map(({ A, B }) => (1 - B.historyEffectiveCollectionMs / A.historyEffectiveCollectionMs) * 100);
	const wallGains = cohort.pairs.map(({ A, B }) => (1 - B.historyWallTimeMs / A.historyWallTimeMs) * 100);
	const cpuGains = cohort.pairs.map(({ A, B }) => (1 - B.historyCpuMicroseconds / A.historyCpuMicroseconds) * 100);
	const rollbackFeature = cohort.options["disable-feature-in-variant-a"] ?? "none";
	const relevantStage = { "receipt-index": "historyReceiptMatchMs", "receipt-ledger-cache": "historyReceiptLedgerReadMs", "codex-history-cache": "historyCodexValidationAndDiscoveryMs" }[rollbackFeature];
	const stageSharePercent = relevantStage ? median(cohort.pairs.map(({ A }) => A[relevantStage] / A.historyEffectiveCollectionMs * 100)) : null;
	const sameDirectionPairCount = effectiveGains.filter((gain) => gain > 0).length;
	const medianEffectiveGainPercent = median(effectiveGains);
	const fullSteadyWindow = Number(cohort.options["steady-duration-ms"]) >= 60_000;
	if (fullSteadyWindow && cohort.pairs.some(({ B }) => B.steadyDurationMs < 60_000 || B.steadyHistoryReadBytes !== 0 || B.steadyStatisticsWriteOperations !== 0 || B.steadyCodexDirectoryEnumerations !== 0)) throw new Error(`稳态 I/O 验收未通过：${directory}`);
	comparisons.push({ ...cohort, effectiveGains, wallGains, cpuGains, stageSharePercent, sameDirectionPairCount,
		medianEffectiveGainPercent, medianWallGainPercent: median(wallGains), medianCpuGainPercent: median(cpuGains),
		retentionGatePassed: sameDirectionPairCount >= 4 && medianEffectiveGainPercent > recorderPerturbationThresholdPercent && (stageSharePercent === null || stageSharePercent >= 10), fullSteadyWindow,
	});
}
await writeFile(resolve(values["output-file"]), JSON.stringify({ recorder: { ...recorder, perturbations, recorderPerturbationThresholdPercent }, comparisons }, null, 2), { flag: "wx" });
process.stdout.write(`${JSON.stringify({ conclusion: "原始对照已核验并汇总", recorderPerturbationThresholdPercent, comparisons: comparisons.map(({ directory, retentionGatePassed, sameDirectionPairCount, medianEffectiveGainPercent, stageSharePercent }) => ({ directory, retentionGatePassed, sameDirectionPairCount, medianEffectiveGainPercent, stageSharePercent })) }, null, 2)}\n`);
