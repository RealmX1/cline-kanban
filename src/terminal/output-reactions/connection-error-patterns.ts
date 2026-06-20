// 终端 agent 输出里的「连接错误」分类。
//
// 所有正则都跑在**归一化后**（stripAnsiAndControl + 小写 + 折叠空白）的文本上，
// 这样 Claude / Codex 用 `\r` 原地重绘的错误行也能稳定匹配。
//
// 分两类，且**永远先判 permanent**：
//   - PERMANENT_ERROR_PATTERNS：鉴权 / 配额 / 400 / 上下文超限等——这类自动续跑
//     无意义甚至有害（会反复撞同一堵墙），命中即短路，绝不自动续跑。
//   - CONNECTION_ERROR_PATTERNS：瞬时连接错误（VPN 抖动、连接被掐断、网关 5xx、
//     超时、DNS 解析失败等）——这类才触发自动续跑。
//
// TODO（第一序列 · Cursor Agent）：Cursor 当前不是 Kanban 可选 agent
//   （agent-catalog.ts / runtimeAgentIdSchema 里都没有 cursor）。一旦把 Cursor
//   接入为可选 agent，请在此补充其连接错误文案（Cursor Agent 的瞬时错误措辞），
//   并在 connection-drop-auto-continue.ts 的 appliesTo 里放行 cursor。
// TODO（第二序列 · droid / kiro 等）：用户主动使用这些终端 agent 时，按需在这里
//   追加它们特有的连接错误文案即可——多数错误词条（econnreset / fetch failed /
//   5xx 等）已经是通用的，通常无需改动。

export type ConnectionErrorClassification = "permanent" | "transient" | null;

export interface ConnectionErrorMatch {
	classification: ConnectionErrorClassification;
	// 命中的错误片段（截断后），用于日志与同错误去重。
	signature: string | null;
}

// 鉴权 / 配额 / 请求非法 / 上下文超限：永远不自动续跑。
const PERMANENT_ERROR_PATTERNS: readonly RegExp[] = [
	/invalid api key|invalid x-api-key|authentication_error|authentication failed|unauthorized|401|403 forbidden|permission denied|oauth token has expired|please run \/login/u,
	/quota|insufficient_quota|billing|payment required|402/u,
	/usage limit reached|reached your usage limit|usage limit/u,
	/rate limit|rate_limit|429/u,
	/400 bad request|invalid_request_error|invalid request error/u,
	/context length|context window|maximum context|context_length_exceeded|prompt is too long|input is too long|too many tokens|exceeds the maximum/u,
];

// 瞬时连接错误：触发自动续跑。
const CONNECTION_ERROR_PATTERNS: readonly RegExp[] = [
	/connection closed mid-response|the response above may be incomplete/u,
	/connection (?:closed|error|reset|refused|aborted|timed out)/u,
	/econnreset|econnrefused|etimedout|eai_again|enetunreach|ehostunreach|enotfound|epipe/u,
	/fetch failed|socket hang up|network ?error|stream (?:disconnected|error|closed)|premature close/u,
	// 只匹配明确的「超时」短语，不再裸匹配 `timeout` / `timed out`（正常输出常含
	// setTimeout / timeout=30 / 测试输出里的 timeout 等，会误起伪 episode）。
	// `connection timed out` 已由上面的 connection(...) 正则覆盖，`ETIMEDOUT` 由 econnreset 行覆盖。
	/request timed out|read timed out|operation timed out|deadline exceeded/u,
	// 只匹配明确的 5xx 网关 / 过载短语，不再裸匹配 502/503/504/529/500 数字（正常输出常含
	// 「500 行」「discuss 500」等，会误起伪 episode）；保留 `http 5xx` 这类明确形式。
	/http 5\d\d|bad gateway|service unavailable|gateway timeout|internal server error|server overloaded|overloaded_error|overloaded/u,
	/getaddrinfo|tunneling socket could not be established|proxy connection/u,
];

function firstMatchSignature(text: string, patterns: readonly RegExp[]): string | null {
	for (const pattern of patterns) {
		const match = pattern.exec(text);
		if (match) {
			return match[0].slice(0, 80);
		}
	}
	return null;
}

// 对一段**已归一化**的文本分类。先判 permanent（命中即短路），再判 transient。
export function classifyConnectionError(normalizedText: string): ConnectionErrorMatch {
	const permanentSignature = firstMatchSignature(normalizedText, PERMANENT_ERROR_PATTERNS);
	if (permanentSignature !== null) {
		return { classification: "permanent", signature: permanentSignature };
	}
	const transientSignature = firstMatchSignature(normalizedText, CONNECTION_ERROR_PATTERNS);
	if (transientSignature !== null) {
		return { classification: "transient", signature: transientSignature };
	}
	return { classification: null, signature: null };
}
