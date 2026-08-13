// 「这条 agent 会话该用哪种通话方式」的域逻辑：哪些 agent 支持在通道之间切换、以及
// 「卡片固化值 → 全局默认 → catalog 默认」的解析优先级。形状与 task-agent-permission-mode.ts
// 一致（能力集合 + resolve 返回 effective/requested/degraded 三元组），理由也一样：
// 不能表达请求的 agent 必须**如实报告降级**，绝不假装生效。
//
// 与 agent-catalog 的分工：catalog 的 `sessionTransport` 是该 agent 的**默认**通道（也是绝大多数
// agent 的唯一通道）；本模块表达的是「哪些 agent 还有第二条通道，以及本次该走哪条」。
// 与「活会话实际在用哪条通道」的分工：那是 RuntimeTaskSessionSummary.sessionTransport，
// 由三条通道各自盖章，读点走 agent-catalog 的 resolveRuntimeAgentSessionTransportFromSummary。
// 本模块只回答 spawn 那一刻的问题，绝不用来判断一条已经跑起来的会话。
import { getRuntimeAgentSessionTransport } from "./agent-catalog";
import type { RuntimeAgentId, RuntimeAgentSessionTransport } from "./api-contract";

// 每个「有第二条通道」的 agent 的可选通道全集（含它的 catalog 默认）。
// omp 是目前唯一一个：TUI（PTY）与 ACP 两条通道共用同一份磁盘会话存储（omp 的 SessionManager
// 按 cwd 建库，ACP 的 session/new 与 TUI 走的是同一条路径），所以「同一段对话」在两条通道上
// 都读得到，切换才有意义。别的 agent 加进来之前必须先确认这一点，否则切换只是换个空会话。
const SWITCHABLE_AGENT_SESSION_TRANSPORTS: ReadonlyMap<RuntimeAgentId, readonly RuntimeAgentSessionTransport[]> =
	new Map<RuntimeAgentId, readonly RuntimeAgentSessionTransport[]>([
		["omp", ["pty_terminal", "acp_stdio_subprocess"]],
	]);

export function getSwitchableAgentSessionTransportsForAgent(
	agentId: RuntimeAgentId | null,
): readonly RuntimeAgentSessionTransport[] {
	if (agentId === null) {
		return [];
	}
	return SWITCHABLE_AGENT_SESSION_TRANSPORTS.get(agentId) ?? [];
}

// 该 agent 的会话是否可以在通道之间切换（= UI 是否渲染那个切换开关）。
export function canAgentSessionTransportBeSwitched(agentId: RuntimeAgentId | null): boolean {
	return getSwitchableAgentSessionTransportsForAgent(agentId).length > 1;
}

export function doesAgentSupportSessionTransport(
	agentId: RuntimeAgentId,
	transport: RuntimeAgentSessionTransport,
): boolean {
	const switchable = getSwitchableAgentSessionTransportsForAgent(agentId);
	if (switchable.length > 0) {
		return switchable.includes(transport);
	}
	return getRuntimeAgentSessionTransport(agentId) === transport;
}

// 一个可切换 agent 的「另一条通道」。两条通道的 agent 上它是完全确定的；
// 将来若有三条通道的 agent，调用方必须改成显式指定目标通道而不是调这个函数。
export function getOppositeAgentSessionTransport(
	agentId: RuntimeAgentId,
	currentTransport: RuntimeAgentSessionTransport,
): RuntimeAgentSessionTransport | null {
	const switchable = getSwitchableAgentSessionTransportsForAgent(agentId);
	if (switchable.length !== 2) {
		return null;
	}
	return switchable.find((transport) => transport !== currentTransport) ?? null;
}

export interface ResolvedAgentSessionTransportForLaunch {
	// 本次 spawn 实际要走的通道。
	effectiveSessionTransport: RuntimeAgentSessionTransport;
	// 调用链上层请求的通道（卡片固化值 / 全局默认 / 显式传入）。与 effective 不同即表示发生了降级。
	requestedSessionTransport: RuntimeAgentSessionTransport;
	degradedBecauseAgentCannotUseRequestedTransport: boolean;
}

// 解析优先级（高→低）：显式请求 → 卡片建卡时固化值 → 全局「新任务默认」 → catalog 默认。
//
// 为什么卡片值优先于全局：全局开关的语义是**严格的「新任务默认值」**，建卡那一刻就固化到卡上，
// 之后改全局不追溯已有卡片（「活的全局回退」是另一件事，不在本轮）。
// 为什么老卡片（无固化值）落到全局默认而不是 catalog 默认：这正是「现存 omp 卡片从 ACP 翻到 TUI」
// 这一次有意为之的默认切换的实现点——见 runtimeBoardCardSchema.ompAgentSessionTransport 的注释。
//
// 不支持请求通道的 agent 一律回落到它的 catalog 默认并如实标记 degraded：这里没有「保守方向」
// 可言（两条通道无强弱之分），故不做静默兜底，由调用方决定是报错还是继续。
export function resolveAgentSessionTransportForLaunch(input: {
	agentId: RuntimeAgentId;
	explicitlyRequestedSessionTransport?: RuntimeAgentSessionTransport | null;
	cardPinnedSessionTransport?: RuntimeAgentSessionTransport | null;
	globalDefaultSessionTransportForNewTasks?: RuntimeAgentSessionTransport | null;
}): ResolvedAgentSessionTransportForLaunch {
	const catalogDefault = getRuntimeAgentSessionTransport(input.agentId);
	const requested =
		input.explicitlyRequestedSessionTransport ??
		input.cardPinnedSessionTransport ??
		input.globalDefaultSessionTransportForNewTasks ??
		catalogDefault;
	if (doesAgentSupportSessionTransport(input.agentId, requested)) {
		return {
			effectiveSessionTransport: requested,
			requestedSessionTransport: requested,
			degradedBecauseAgentCannotUseRequestedTransport: false,
		};
	}
	return {
		effectiveSessionTransport: catalogDefault,
		requestedSessionTransport: requested,
		degradedBecauseAgentCannotUseRequestedTransport: true,
	};
}

// 建卡时要固化到卡上的值。只对「可切换」的 agent 落值——给不可切换的 agent 落一个字段
// 纯属噪声，而且日后若某个 agent 的 catalog 默认变了，落死的值会悄悄把它钉在旧通道上。
// globalDefaultSessionTransportForNewTasks 缺省（老调用点 / 测试没接全局配置）时落 catalog 默认。
//
// 参数刻意叫 agentIdTheNewTaskWillRunWith 而不是 agentId：卡片上的 `agentId` 是**override**，
// 用户用工作区默认 agent 建卡时它是空的。这里要的是「这张卡实际会跑哪个 agent」（override 缺省
// 时即工作区默认 agent）。两者混淆过一次：默认 agent 是 omp 时建出来的卡漏掉固化值，
// 之后改全局默认就会反向改变这些已存在卡片的启动通道，正好违背「建卡时固化」的契约。
// 传 null/undefined = 调用方确实不知道会跑哪个 agent，此时不落值是唯一诚实的行为。
export function resolveAgentSessionTransportPinnedAtTaskCreation(input: {
	agentIdTheNewTaskWillRunWith: RuntimeAgentId | null | undefined;
	globalDefaultSessionTransportForNewTasks?: RuntimeAgentSessionTransport | null;
}): RuntimeAgentSessionTransport | undefined {
	const agentId = input.agentIdTheNewTaskWillRunWith;
	if (!agentId || !canAgentSessionTransportBeSwitched(agentId)) {
		return undefined;
	}
	const catalogDefault = getRuntimeAgentSessionTransport(agentId);
	const globalDefault = input.globalDefaultSessionTransportForNewTasks ?? catalogDefault;
	if (!doesAgentSupportSessionTransport(agentId, globalDefault)) {
		return catalogDefault;
	}
	return globalDefault;
}

const AGENT_SESSION_TRANSPORT_LABELS: Record<RuntimeAgentSessionTransport, string> = {
	pty_terminal: "Terminal (TUI)",
	in_process_cline_sdk: "Cline SDK",
	acp_stdio_subprocess: "ACP",
};

export function getAgentSessionTransportLabel(transport: RuntimeAgentSessionTransport): string {
	return AGENT_SESSION_TRANSPORT_LABELS[transport];
}
