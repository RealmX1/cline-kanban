import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import { resolveSessionFacets } from "../core/session-activity";
import { normalizeTerminalText, stripAnsiAndControl } from "./terminal-output-normalization";

const MAX_CODEX_MODEL_CAPACITY_ERROR_SCAN_CHARS = 8_192;
const CODEX_MODEL_CAPACITY_ERROR_MESSAGE = "selected model is at capacity. please try a different model.";

export function buildCodexModelCapacityErrorDetectionTurnIdentity(
	summary: RuntimeTaskSessionSummary,
	suppressHistoricalOutputReplay: boolean,
	acceptedTurnEventId: string | null,
): string | null {
	if (
		summary.agentId !== "codex" ||
		suppressHistoricalOutputReplay ||
		resolveSessionFacets(summary).turnOwner !== "agent"
	)
		return null;
	return JSON.stringify([
		summary.runtimeSessionIncarnationId,
		summary.agentResponseGenerationTurnSequence,
		acceptedTurnEventId,
	]);
}

const CODE_FENCE_PATTERN = /(?:^|[\r\n])[ \t]*(?:```|~~~)/gu;

function stripCodexOutputForCapacityErrorDetection(input: string): string {
	// 只为回到首列或擦掉光标前缀的控制生成边界；默认 CSI K 与非首列定位仍保留引用前缀。
	const outputWithCursorLineBoundaries = input.replace(
		// biome-ignore lint/suspicious/noControlCharactersInRegex: 终端光标与擦行协议必须识别 ESC 控制字符。
		/\u001b\[(?:[01]?G|[0-9]*(?:;[01]?)?[Hf]|[0-9]*[EF]|[12]K)/gu,
		"\n",
	);
	return stripAnsiAndControl(outputWithCursorLineBoundaries);
}

function countCodeFences(input: string): number {
	return input.match(CODE_FENCE_PATTERN)?.length ?? 0;
}

// 原始尾巴保留 ANSI 分片；先跨批拼接再归一化，避免把半条 CSI 当成错误正文。
export function createCodexModelCapacityErrorDetector() {
	let previousTurnIdentity: string | null = null;
	let rawOutputTail = "";
	let codeFenceParityBeforeTail = 0;
	return (output: string, turnIdentity: string): boolean => {
		if (previousTurnIdentity !== turnIdentity) {
			rawOutputTail = "";
			codeFenceParityBeforeTail = 0;
		}
		previousTurnIdentity = turnIdentity;
		rawOutputTail += output;
		if (rawOutputTail.length > MAX_CODEX_MODEL_CAPACITY_ERROR_SCAN_CHARS) {
			const retainedTail = rawOutputTail
				.slice(-MAX_CODEX_MODEL_CAPACITY_ERROR_SCAN_CHARS)
				// 截断处不一定是行首，丢掉首行残片，防止引用正文被裁成独立错误横幅。
				.replace(/^[^\r\n]*(?:[\r\n]|$)/u, "");
			const discardedPrefix = rawOutputTail.slice(0, rawOutputTail.length - retainedTail.length);
			codeFenceParityBeforeTail =
				(codeFenceParityBeforeTail + countCodeFences(stripCodexOutputForCapacityErrorDetection(discardedPrefix))) %
				2;
			rawOutputTail = retainedTail;
		}
		if (!rawOutputTail.includes("■")) return false;
		const strippedOutput = stripCodexOutputForCapacityErrorDetection(rawOutputTail);
		for (const marker of strippedOutput.matchAll(/(?:^|[\r\n])[ \t]*■[ \t]+/gu)) {
			const precedingText = strippedOutput.slice(0, marker.index);
			if ((codeFenceParityBeforeTail + countCodeFences(precedingText)) % 2 !== 0) continue;
			const message = normalizeTerminalText(strippedOutput.slice(marker.index + marker[0].length));
			if (!message.startsWith(CODEX_MODEL_CAPACITY_ERROR_MESSAGE)) continue;
			rawOutputTail = "";
			codeFenceParityBeforeTail = 0;
			return true;
		}
		return false;
	};
}
