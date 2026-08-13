import { describe, expect, it } from "vitest";

import {
	createTerminalInputBoxOccupancyTrackerState,
	recordTerminalInputBytesIntoOccupancyTracker,
	resetTerminalInputBoxOccupancyTrackerComposition,
	resolveTerminalInputBoxOccupancy,
	type TerminalInputBoxOccupancyTrackerState,
} from "../../../src/terminal/terminal-input-box-occupancy";
import type { TerminalInputBoxReading } from "../../../src/terminal/terminal-input-box-reader";

// 输入字节语义（真机实测，Claude Code v2.1.227）。这些是**外部契约**：Claude 换键位就会漂移，
// 本套件的作用是让漂移在 CI 里炸出来，而不是在一次「投递插进人类打了一半的那一行」里被发现。
const CARRIAGE_RETURN = "\r"; // Enter：提交
const LINE_FEED = "\n"; // Shift+Enter：框内换行，**不**提交
const CTRL_C = "\u0003";
const CTRL_S = "\u0013";
const CURSOR_UP = "\u001b[A";
const BACKSPACE = "\u007f";
// 单独按下的 Escape 键：它自己就是一次完整输入，而不是某条序列的开头。
const ESCAPE = "\u001b";
const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

function feed(state: TerminalInputBoxOccupancyTrackerState, text: string): void {
	recordTerminalInputBytesIntoOccupancyTracker(state, Buffer.from(text, "utf8"));
}

// 把一段文本按字节切成若干块喂进去，模拟 WebSocket 二进制帧的任意分片（含把一个多字节字符
// 或一条转义序列拦腰截断）。
function feedInByteSlices(state: TerminalInputBoxOccupancyTrackerState, text: string, sliceLength: number): void {
	const bytes = Buffer.from(text, "utf8");
	for (let offset = 0; offset < bytes.length; offset += sliceLength) {
		recordTerminalInputBytesIntoOccupancyTracker(state, bytes.subarray(offset, offset + sliceLength));
	}
}

function reading(text: string): TerminalInputBoxReading {
	return {
		location: { topBoundaryLineIndex: 0, bottomBoundaryLineIndex: 2 },
		logicalLines: text.length > 0 ? text.split("\n") : [],
		text,
		softWrapJoinCount: 0,
	};
}

describe("terminal input box occupancy — 判空", () => {
	it("新会话的输入框判为空", () => {
		const state = createTerminalInputBoxOccupancyTrackerState();
		expect(state.hasUncommittedInputFromInputSideByteTracking).toBe(false);
	});

	it("敲可打印字符后判为非空，回车提交后归零", () => {
		const state = createTerminalInputBoxOccupancyTrackerState();
		feed(state, "hello");
		expect(state.hasUncommittedInputFromInputSideByteTracking).toBe(true);
		feed(state, CARRIAGE_RETURN);
		expect(state.hasUncommittedInputFromInputSideByteTracking).toBe(false);
	});

	// 这条是回归红线：把 `\n` 与 `\r` 一起当提交，会把「用户正按 Shift+Enter 写多行」
	// 误判成框已空，程序化投递于是插进人类写到一半的消息里。
	it("Shift+Enter 的 LF 是框内换行而非提交，内容仍算未提交", () => {
		const state = createTerminalInputBoxOccupancyTrackerState();
		feed(state, `first line${LINE_FEED}second line`);
		expect(state.hasUncommittedInputFromInputSideByteTracking).toBe(true);
		feed(state, LINE_FEED);
		expect(state.hasUncommittedInputFromInputSideByteTracking).toBe(true);
	});

	it("Ctrl+C 与 Ctrl+S 都清框，判空随之归零", () => {
		const clearedByCtrlC = createTerminalInputBoxOccupancyTrackerState();
		feed(clearedByCtrlC, `draft${CTRL_C}`);
		expect(clearedByCtrlC.hasUncommittedInputFromInputSideByteTracking).toBe(false);

		const clearedByCtrlS = createTerminalInputBoxOccupancyTrackerState();
		feed(clearedByCtrlS, `draft${CTRL_S}`);
		expect(clearedByCtrlS.hasUncommittedInputFromInputSideByteTracking).toBe(false);
	});

	it("方向键等 CSI 导航序列不算内容", () => {
		const state = createTerminalInputBoxOccupancyTrackerState();
		feed(state, `${CURSOR_UP}\u001b[3~\u001b[H\u001bOB`);
		expect(state.hasUncommittedInputFromInputSideByteTracking).toBe(false);
	});

	// 硬规则 1：删到底了没有无法从字节流单独判定，只能保守停在「有内容」。
	it("退格不清空判定——保守方向永远是有内容", () => {
		const state = createTerminalInputBoxOccupancyTrackerState();
		feed(state, `ab${BACKSPACE}${BACKSPACE}`);
		expect(state.hasUncommittedInputFromInputSideByteTracking).toBe(true);
	});

	// 硬规则 1：粘贴被切成多个 chunk 送达时，「起始标记已到、结束标记未到」是一个真实的中间窗口。
	// 争用判据若在此刻轮询读到「框是空的」，程序化投递就会插进人类正在进行中的粘贴。
	it("未闭合的 bracketed paste 期间即判为非空，不等结束标记", () => {
		const state = createTerminalInputBoxOccupancyTrackerState();
		feed(state, `${PASTE_START}粘到一半的正文`);
		expect(state.insideBracketedPaste).toBe(true);
		expect(state.hasUncommittedInputFromInputSideByteTracking).toBe(true);
		const occupancy = resolveTerminalInputBoxOccupancy({ trackerState: state, inputBoxReading: null });
		expect(occupancy.hasUncommittedInput).toBe(true);
	});

	// 起始标记本身就骑在 chunk 边界上：正文一个字节都还没到，判空同样必须已经偏向「有内容」。
	it("只到了起始标记（正文尚未到达）也判为非空", () => {
		const state = createTerminalInputBoxOccupancyTrackerState();
		feedInByteSlices(state, PASTE_START, 2);
		expect(state.insideBracketedPaste).toBe(true);
		expect(state.hasUncommittedInputFromInputSideByteTracking).toBe(true);
	});

	it("被 chunk 边界切开的转义序列不会被当成内容", () => {
		const state = createTerminalInputBoxOccupancyTrackerState();
		feed(state, "\u001b[");
		expect(state.hasUncommittedInputFromInputSideByteTracking).toBe(false);
		feed(state, "A");
		expect(state.hasUncommittedInputFromInputSideByteTracking).toBe(false);
	});

	// 一个永远等不到终止字节的 ESC 不能把解析器永久卡住：超过回车带上限即消费掉它继续扫描，
	// 后续字节按内容处理（方向仍偏「有内容」）。
	it("超长的不完整转义序列不会永久阻塞解析", () => {
		const state = createTerminalInputBoxOccupancyTrackerState();
		feed(state, `\u001b[${"1".repeat(80)}`);
		expect(state.hasUncommittedInputFromInputSideByteTracking).toBe(true);
	});

	// 真正的 Alt 组合键由终端在同一次 write 里原子发出，ESC 与那个字符之间不会骑上 chunk 边界。
	// 「上一 chunk 以孤立 ESC 结尾、下一 chunk 另起一个字符」因此是两次输入（先按 Escape、再敲字），
	// 把它们合成 Alt 序列吞掉会让这个字符不算内容——判空往「空」的方向撒谎。
	it("孤立 ESC 结转后不与下一 chunk 的字符合成 Alt 序列，那个字符仍算内容", () => {
		const state = createTerminalInputBoxOccupancyTrackerState();
		feed(state, ESCAPE);
		expect(state.hasUncommittedInputFromInputSideByteTracking).toBe(false);
		feed(state, "x");
		expect(state.hasUncommittedInputFromInputSideByteTracking).toBe(true);
	});

	// 同一次 write 里的 ESC + 字符仍按 Alt 组合键整体消费——它是编辑/导航命令而非内容。
	it("同一 chunk 内的 Alt 组合键仍不算内容", () => {
		const state = createTerminalInputBoxOccupancyTrackerState();
		feed(state, `${ESCAPE}b${ESCAPE}f`);
		expect(state.hasUncommittedInputFromInputSideByteTracking).toBe(false);
	});
});

describe("terminal input box occupancy — 粘贴账本", () => {
	it("单次粘贴入账，行数与字符数按占位符校验量口径记账", () => {
		const state = createTerminalInputBoxOccupancyTrackerState();
		feed(state, `${PASTE_START}alpha\rbeta\rgamma${PASTE_END}`);
		expect(state.pasteLedger).toEqual([
			{
				pasteOrdinalWithinCurrentComposition: 1,
				payloadText: "alpha\rbeta\rgamma",
				lineCount: 3,
				characterCount: 16,
			},
		]);
		// 占位符写的是 `+M lines`，M == lineCount - 1。
		expect(state.pasteLedger[0].lineCount - 1).toBe(2);
		expect(state.hasUncommittedInputFromInputSideByteTracking).toBe(true);
	});

	it("CRLF 只算一次换行，末尾那个换行不多算一行", () => {
		const state = createTerminalInputBoxOccupancyTrackerState();
		feed(state, `${PASTE_START}alpha\r\nbeta\r\n${PASTE_END}`);
		expect(state.pasteLedger[0].lineCount).toBe(2);
	});

	it("粘贴载荷里的 CR 是内容而不是提交", () => {
		const state = createTerminalInputBoxOccupancyTrackerState();
		feed(state, `${PASTE_START}line one\rline two${PASTE_END}`);
		expect(state.hasUncommittedInputFromInputSideByteTracking).toBe(true);
		expect(state.pasteLedger).toHaveLength(1);
	});

	it("粘贴与手打混排时按出现顺序给序号", () => {
		const state = createTerminalInputBoxOccupancyTrackerState();
		feed(state, "BEFORE-TYPED ");
		feed(state, `${PASTE_START}first\rpaste${PASTE_END}`);
		feed(state, " AFTER-TYPED ");
		feed(state, `${PASTE_START}second\rpaste\rhere${PASTE_END}`);
		expect(state.pasteLedger.map((entry) => [entry.pasteOrdinalWithinCurrentComposition, entry.lineCount])).toEqual([
			[1, 2],
			[2, 3],
		]);
	});

	it("提交后账本作废、序号重来", () => {
		const state = createTerminalInputBoxOccupancyTrackerState();
		feed(state, `${PASTE_START}first composition${PASTE_END}${CARRIAGE_RETURN}`);
		expect(state.pasteLedger).toHaveLength(0);
		feed(state, `${PASTE_START}second composition${PASTE_END}`);
		expect(state.pasteLedger[0].pasteOrdinalWithinCurrentComposition).toBe(1);
	});

	it("W2 暂存链路可显式作废当前组合（Ctrl+S 被前端拦截、不经 writeInput）", () => {
		const state = createTerminalInputBoxOccupancyTrackerState();
		feed(state, `${PASTE_START}stashed away${PASTE_END}typed too`);
		resetTerminalInputBoxOccupancyTrackerComposition(state);
		expect(state.hasUncommittedInputFromInputSideByteTracking).toBe(false);
		expect(state.pasteLedger).toHaveLength(0);
		expect(state.unrecoverablePasteCount).toBe(0);
	});

	it("跨多次 write 分片到达的粘贴能拼回原文（起止标记与多字节字符均被切断）", () => {
		const payloadText = `中文粘贴第一行\r中文粘贴第二行\rthird line`;
		for (const sliceLength of [1, 2, 3, 5, 7]) {
			const state = createTerminalInputBoxOccupancyTrackerState();
			feedInByteSlices(state, `${PASTE_START}${payloadText}${PASTE_END}`, sliceLength);
			expect(state.pasteLedger).toHaveLength(1);
			expect(state.pasteLedger[0].payloadText).toBe(payloadText);
			expect(state.pasteLedger[0].lineCount).toBe(3);
			expect(state.insideBracketedPaste).toBe(false);
		}
	});

	it("结束标记的真前缀骑在 chunk 边界上时不会被误当成结束", () => {
		const state = createTerminalInputBoxOccupancyTrackerState();
		// 第一块正好断在 `ESC[20` 上——它既是结束标记的真前缀，又是这段粘贴的正文。解析器必须
		// 把它留到下一块再判，而不是就地当成结束、也不是就地当成正文吞掉。
		feed(state, `${PASTE_START}prefix \u001b[20`);
		expect(state.insideBracketedPaste).toBe(true);
		feed(state, `x tail${PASTE_END}`);
		expect(state.pasteLedger[0].payloadText).toBe("prefix \u001b[20x tail");
	});

	it("未闭合的粘贴保持开启，结束标记到达前不入账", () => {
		const state = createTerminalInputBoxOccupancyTrackerState();
		feed(state, `${PASTE_START}still typing`);
		expect(state.insideBracketedPaste).toBe(true);
		expect(state.pasteLedger).toHaveLength(0);
		feed(state, PASTE_END);
		expect(state.pasteLedger).toHaveLength(1);
	});

	// 硬规则 2 的回归红线：上一 chunk 结转的孤立 ESC 若与粘贴起始标记的首字节合成 Alt 序列被吞掉，
	// 起始标记就识别不出来，整段粘贴的正文会被当成一串普通字符——原文既不入账，也不会计入
	// unrecoverablePasteCount，回填侧连「这里还原不了」都不知道。
	it("先按 Escape 再粘贴，粘贴仍完整入账", () => {
		const state = createTerminalInputBoxOccupancyTrackerState();
		feed(state, ESCAPE);
		feed(state, `${PASTE_START}first line${CARRIAGE_RETURN}second line${PASTE_END}`);
		expect(state.pasteLedger).toEqual([
			{
				pasteOrdinalWithinCurrentComposition: 1,
				payloadText: `first line${CARRIAGE_RETURN}second line`,
				lineCount: 2,
				characterCount: 22,
			},
		]);
		expect(state.unrecoverablePasteCount).toBe(0);
	});

	// carry 存在的正当理由不能被上一条修复掉：起始标记本身被切在 ESC 之后时，两块必须仍能拼回。
	it("起始标记被 chunk 边界切在 ESC 之后仍能拼回", () => {
		const state = createTerminalInputBoxOccupancyTrackerState();
		feed(state, ESCAPE);
		feed(state, `[200~payload${PASTE_END}`);
		expect(state.pasteLedger).toHaveLength(1);
		expect(state.pasteLedger[0].payloadText).toBe("payload");
	});

	// 硬规则 2：宁可明说「这段还原不了」，也不给回填侧一段被腰斩的正文——用户看不出少了什么。
	it("载荷超出留存上限时只留计量、丢正文，并计入 unrecoverablePasteCount", () => {
		const state = createTerminalInputBoxOccupancyTrackerState();
		const oversizedPayload = "x".repeat(1_048_577);
		feed(state, `${PASTE_START}${oversizedPayload}${PASTE_END}`);
		expect(state.pasteLedger).toEqual([
			{
				pasteOrdinalWithinCurrentComposition: 1,
				payloadText: null,
				lineCount: 1,
				characterCount: 1_048_577,
			},
		]);
		expect(state.unrecoverablePasteCount).toBe(1);
		// 正文没了，但「框里有东西」这个结论不受影响。
		expect(state.hasUncommittedInputFromInputSideByteTracking).toBe(true);
	});

	// 条目数上限同时是账本数组的硬上限：超出的粘贴不再各留一个只剩计量的空壳对象（它们的
	// payloadText 本来就已经是 null），但 unrecoverablePasteCount 照常累加——回填侧仍然知道
	// 「这次组合里有还原不了的粘贴」而拒绝猜测。
	it("单次组合内粘贴条数超上限后，多出来的不入账、只累计 unrecoverablePasteCount", () => {
		const state = createTerminalInputBoxOccupancyTrackerState();
		for (let index = 0; index < 34; index += 1) {
			feed(state, `${PASTE_START}paste ${index}${PASTE_END}`);
		}
		expect(state.pasteLedger).toHaveLength(32);
		expect(state.pasteLedger.filter((entry) => entry.payloadText === null)).toHaveLength(0);
		expect(state.pasteLedger[31].pasteOrdinalWithinCurrentComposition).toBe(32);
		expect(state.unrecoverablePasteCount).toBe(2);
	});

	// 内存红线：账本条目对象曾经是无条件 push 的，两个既有上限都只决定「留不留正文」，拦不住
	// 数组本身增长——一次长时间未提交的组合里连续小粘贴会让它涨到与粘贴次数等长。
	it("一次组合内连续大量小粘贴不会让账本数组无界增长", () => {
		const state = createTerminalInputBoxOccupancyTrackerState();
		for (let index = 0; index < 10_000; index += 1) {
			feed(state, `${PASTE_START}p${index}${PASTE_END}`);
		}
		expect(state.pasteLedger).toHaveLength(32);
		expect(state.unrecoverablePasteCount).toBe(9_968);
		// 上限管的是「一次组合」：提交后整本作废，下一次组合又能重新留满 32 条。
		feed(state, CARRIAGE_RETURN);
		expect(state.pasteLedger).toHaveLength(0);
		feed(state, `${PASTE_START}next composition${PASTE_END}`);
		expect(state.pasteLedger).toHaveLength(1);
		expect(state.pasteLedger[0].payloadText).toBe("next composition");
	});
});

describe("resolveTerminalInputBoxOccupancy — 两路保守的并", () => {
	it("两路都说空才判空", () => {
		const state = createTerminalInputBoxOccupancyTrackerState();
		const occupancy = resolveTerminalInputBoxOccupancy({ trackerState: state, inputBoxReading: reading("") });
		expect(occupancy).toEqual({
			hasUncommittedInput: false,
			inputSideByteTrackingSaysNonEmpty: false,
			screenReadingSaysNonEmpty: false,
			unrecoverablePasteCount: 0,
		});
	});

	it("输入侧说非空即让路，哪怕读屏看不到（框正被全屏输出盖住）", () => {
		const state = createTerminalInputBoxOccupancyTrackerState();
		feed(state, "half-typed");
		const occupancy = resolveTerminalInputBoxOccupancy({ trackerState: state, inputBoxReading: null });
		expect(occupancy.hasUncommittedInput).toBe(true);
		expect(occupancy.screenReadingSaysNonEmpty).toBeNull();
	});

	// 输入侧的盲区：经 tmux / 原生终端直连同一 PTY 敲进去的字不过 writeInput，只有读屏看得见。
	it("读屏说非空即让路，哪怕输入侧没见过这些字节", () => {
		const state = createTerminalInputBoxOccupancyTrackerState();
		const occupancy = resolveTerminalInputBoxOccupancy({
			trackerState: state,
			inputBoxReading: reading("typed through tmux"),
		});
		expect(occupancy.hasUncommittedInput).toBe(true);
		expect(occupancy.inputSideByteTrackingSaysNonEmpty).toBe(false);
		expect(occupancy.screenReadingSaysNonEmpty).toBe(true);
	});

	it("还原不了的粘贴条数透传给争用策略（>0 时禁止抢占暂存）", () => {
		const state = createTerminalInputBoxOccupancyTrackerState();
		feed(state, `${PASTE_START}${"x".repeat(1_048_577)}${PASTE_END}`);
		const occupancy = resolveTerminalInputBoxOccupancy({ trackerState: state, inputBoxReading: null });
		expect(occupancy.unrecoverablePasteCount).toBe(1);
	});
});
