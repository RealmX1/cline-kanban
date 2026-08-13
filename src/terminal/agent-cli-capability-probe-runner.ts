import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ANSI_STYLE_ESCAPE_SEQUENCE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/**
 * 探测失败结果的缓存窗口，刻意远短于成功结果的 TTL。
 *
 * 失败也要缓存，否则「二进制没装」这类必然失败会让每次请求都真 spawn 一遍（模型选择器 + 会话启动路径
 * 会在同一秒内各打一次）；但失败缓存久了又会把「用户刚装好 CLI」的恢复拖到 TTL 结束，所以只压住一阵突发。
 */
const AGENT_CLI_CAPABILITY_PROBE_FAILURE_CACHE_TIME_TO_LIVE_MS = 5_000;

const AGENT_CLI_CAPABILITY_PROBE_DEFAULT_CACHE_TIME_TO_LIVE_MS = 60_000;

/**
 * 一次「跑某个 agent CLI 的只读子命令、把 stdout 解析成结构化能力信息」的声明式契约。
 *
 * 表驱动的意义在于：binary / args / timeout / maxBuffer 这些**纯数据**逐 agent 列成一张表，而
 * `parseStdout` 这个**必须写代码**的部分作为函数字段嵌在同一行里——比纯数据表有表达力，比给每个 agent
 * 实现一个接口轻。新增一类探测（如订阅 / 登录态）只需再写一张平行契约表复用同一个 driver。
 *
 * 契约里**不含**任何降级策略：失败一律由 driver 统一收敛成 `{ ok: false, warning }`。
 */
export type AgentCliCapabilityProbeContract<TProbeResultValue> = {
	/** 缓存键。同一条契约的多次调用共享结果，故必须逐探测唯一且稳定。 */
	readonly probeId: string;
	readonly binary: string;
	readonly args: readonly string[];
	readonly timeoutMs: number;
	readonly maxBufferBytes: number;
	/** 探测的是刮 TUI 输出的子命令时置 true：driver 在交给 `parseStdout` 之前剥掉 ANSI 颜色序列。 */
	readonly stripAnsiStyleEscapeSequencesFromStdout?: boolean;
	/** 成功结果的缓存时长；省略时用 60s。 */
	readonly successCacheTimeToLiveMs?: number;
	/** 解析器抛错等同于探测失败——契约实现方不必自己处理异常。 */
	readonly parseStdout: (stdout: string) => TProbeResultValue;
};

export type AgentCliCapabilityProbeOutcome<TProbeResultValue> =
	| { readonly ok: true; readonly value: TProbeResultValue }
	| { readonly ok: false; readonly warning: string };

type CachedAgentCliCapabilityProbeOutcome = {
	readonly expiresAtEpochMs: number;
	readonly outcome: AgentCliCapabilityProbeOutcome<unknown>;
};

const cachedProbeOutcomesByProbeId = new Map<string, CachedAgentCliCapabilityProbeOutcome>();
const inFlightProbeRunsByProbeId = new Map<string, Promise<AgentCliCapabilityProbeOutcome<unknown>>>();

async function executeAgentCliCapabilityProbe<TProbeResultValue>(
	contract: AgentCliCapabilityProbeContract<TProbeResultValue>,
): Promise<AgentCliCapabilityProbeOutcome<TProbeResultValue>> {
	try {
		const result = await execFileAsync(contract.binary, [...contract.args], {
			timeout: contract.timeoutMs,
			maxBuffer: contract.maxBufferBytes,
		});
		const stdout = contract.stripAnsiStyleEscapeSequencesFromStdout
			? result.stdout.replace(ANSI_STYLE_ESCAPE_SEQUENCE_PATTERN, "")
			: result.stdout;
		return { ok: true, value: contract.parseStdout(stdout) };
	} catch (error) {
		// 解析器抛错与子进程失败在这里刻意同等对待：调用方只关心「这次探测拿不到可信目录」，
		// 而两者都要走同一条「降级成 warning 而非 reject」的路径——上层据此返回可用的兜底响应。
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, warning: message };
	}
}

/**
 * 跑一条 CLI 能力探测契约。**永不 reject**：失败降级成 `{ ok: false, warning }`。
 *
 * 这条「不 reject」的语义是前端已依赖的既有行为——模型选择器靠响应里的 `warning` 判定「这是降级结果、
 * 不要写回 localStorage」，若改成抛异常，一次 CLI 抖动就会把好端端的模型列表污染成单条 Default 并持久化。
 *
 * 并发调用同一条契约只 spawn 一次（in-flight 去重），结果按 TTL 缓存。
 */
export async function runAgentCliCapabilityProbe<TProbeResultValue>(
	contract: AgentCliCapabilityProbeContract<TProbeResultValue>,
): Promise<AgentCliCapabilityProbeOutcome<TProbeResultValue>> {
	const nowEpochMs = Date.now();
	const cached = cachedProbeOutcomesByProbeId.get(contract.probeId);
	if (cached && cached.expiresAtEpochMs > nowEpochMs) {
		return cached.outcome as AgentCliCapabilityProbeOutcome<TProbeResultValue>;
	}
	const inFlight = inFlightProbeRunsByProbeId.get(contract.probeId);
	if (inFlight) {
		return (await inFlight) as AgentCliCapabilityProbeOutcome<TProbeResultValue>;
	}
	const probeRun = executeAgentCliCapabilityProbe(contract)
		.then((outcome) => {
			const cacheTimeToLiveMs = outcome.ok
				? (contract.successCacheTimeToLiveMs ?? AGENT_CLI_CAPABILITY_PROBE_DEFAULT_CACHE_TIME_TO_LIVE_MS)
				: AGENT_CLI_CAPABILITY_PROBE_FAILURE_CACHE_TIME_TO_LIVE_MS;
			cachedProbeOutcomesByProbeId.set(contract.probeId, {
				expiresAtEpochMs: Date.now() + cacheTimeToLiveMs,
				outcome,
			});
			return outcome as AgentCliCapabilityProbeOutcome<unknown>;
		})
		.finally(() => {
			inFlightProbeRunsByProbeId.delete(contract.probeId);
		});
	inFlightProbeRunsByProbeId.set(contract.probeId, probeRun);
	return (await probeRun) as AgentCliCapabilityProbeOutcome<TProbeResultValue>;
}

/** 丢弃已缓存的探测结果，让下一次调用真正重新 spawn。测试与「用户刚装好 CLI」的显式刷新用。 */
export function clearCachedAgentCliCapabilityProbeOutcomes(probeId?: string): void {
	if (probeId === undefined) {
		cachedProbeOutcomesByProbeId.clear();
		return;
	}
	cachedProbeOutcomesByProbeId.delete(probeId);
}
