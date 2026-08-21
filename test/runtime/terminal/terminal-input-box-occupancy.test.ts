import { describe, expect, it } from "vitest";

import {
	createTerminalInputBoxOccupancyTrackerState,
	reconcileInputSideOccupancyLatchAgainstConfirmedEmptyScreenReading,
	recordTerminalInputBytesIntoOccupancyTracker,
	resetTerminalInputBoxOccupancyTrackerComposition,
	resolveProgrammaticDeliveryInputBoxContention,
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

// nowEpochMs 默认 0：绝大多数用例不关心时间，让「未闭合粘贴挂了多久」恒为 0，永不触发强制封账。
// 只有钉封账上界的那两例显式喂时刻。
function feed(state: TerminalInputBoxOccupancyTrackerState, text: string, nowEpochMs = 0): void {
	recordTerminalInputBytesIntoOccupancyTracker(state, Buffer.from(text, "utf8"), nowEpochMs);
}

// 把一段文本按字节切成若干块喂进去，模拟 WebSocket 二进制帧的任意分片（含把一个多字节字符
// 或一条转义序列拦腰截断）。
function feedInByteSlices(
	state: TerminalInputBoxOccupancyTrackerState,
	text: string,
	sliceLength: number,
	nowEpochMs = 0,
): void {
	const bytes = Buffer.from(text, "utf8");
	for (let offset = 0; offset < bytes.length; offset += sliceLength) {
		recordTerminalInputBytesIntoOccupancyTracker(state, bytes.subarray(offset, offset + sliceLength), nowEpochMs);
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

// 程序化投递的争用判据：分歧时（输入侧说空、读屏说有）问的不是「信谁」，而是「输入侧此刻可不可信」。
describe("resolveProgrammaticDeliveryInputBoxContention — 争用判据", () => {
	function contentionOf(
		trackerState: ReturnType<typeof createTerminalInputBoxOccupancyTrackerState>,
		inputBoxReading: Parameters<typeof resolveTerminalInputBoxOccupancy>[0]["inputBoxReading"],
	) {
		return resolveProgrammaticDeliveryInputBoxContention({
			occupancy: resolveTerminalInputBoxOccupancy({ trackerState, inputBoxReading }),
			inputSideByteTrackingHasEverObservedHumanBytes: trackerState.hasEverObservedHumanInputBytesFromWriteInput,
		});
	}

	it("两路都说空 → 放行", () => {
		const state = createTerminalInputBoxOccupancyTrackerState();
		expect(contentionOf(state, reading(""))).toBe("input_box_clear_for_programmatic_delivery");
	});

	it("输入侧亲眼见到未提交内容 → 真争用", () => {
		const state = createTerminalInputBoxOccupancyTrackerState();
		feed(state, "half-typed");
		expect(contentionOf(state, reading("half-typed"))).toBe("human_uncommitted_input_present");
	});

	// Claude 偶发在空框里渲染 `Try "..."`，且恰好出现在 followup 的目标态（agent 完工、框空）。
	// 输入侧接得上人（这条 PTY 收到过人类字节）时，屏上这段字最可能就是它 —— 采信输入侧，放行。
	it("屏上有字但输入侧接得上人且说空 → 判为 agent 自绘，放行", () => {
		const state = createTerminalInputBoxOccupancyTrackerState();
		feed(state, "已经提交掉的一句\r");
		expect(state.hasUncommittedInputFromInputSideByteTracking).toBe(false);
		expect(contentionOf(state, reading('Try "edit session-manager.ts to..."'))).toBe(
			"input_box_clear_for_programmatic_delivery",
		);
	});

	// 反过来：输入侧一个字节都没见过（用户只经 tmux / 原生终端直连该 PTY）⇒ 它是瞎的，必须采信读屏。
	it("屏上有字且输入侧从未见过人类字节 → 存疑占用，既不写也不抢占", () => {
		const state = createTerminalInputBoxOccupancyTrackerState();
		expect(state.hasEverObservedHumanInputBytesFromWriteInput).toBe(false);
		expect(contentionOf(state, reading("有人从 tmux 里打了半句"))).toBe(
			"screen_text_uncorroborated_while_input_side_tracking_is_blind",
		);
	});

	it("提交 / 清空不会让输入侧重新变瞎：hasEverObserved 不随组合复位", () => {
		const state = createTerminalInputBoxOccupancyTrackerState();
		feed(state, "一句话\r");
		resetTerminalInputBoxOccupancyTrackerComposition(state);
		expect(state.hasEverObservedHumanInputBytesFromWriteInput).toBe(true);
	});
});

// ── 输入侧闩的确定性死局与两条自愈路径 ──────────────────────────────────────────
//
// 钉的是 2026-08-20 RVF 决策点横幅静默消失那次事故的根因：闩一旦被咬住而复位事件永远到不了，
// 这条 PTY 的**余生**所有程序化投递都被判成人类争用。两条自愈各覆盖一半：
//   A1 对账  —— 读屏连续多拍确证「框在屏上且是空的」且人不在场 ⇒ 复位。
//   A2 封账  —— 未闭合的 bracketed paste 挂过时长上界 ⇒ 强制封账，恢复 CR 的复位能力。判据是**挂了
//              多久**而不是**跨了几次 writeInput**：分片次数纯属传输层偶然，用它作界会把正常大粘贴腰斩。
describe("terminal-input-box-occupancy · 输入侧闩的自愈", () => {
	function contentionOf(
		trackerState: TerminalInputBoxOccupancyTrackerState,
		inputBoxReading: Parameters<typeof resolveTerminalInputBoxOccupancy>[0]["inputBoxReading"],
	) {
		return resolveProgrammaticDeliveryInputBoxContention({
			occupancy: resolveTerminalInputBoxOccupancy({ trackerState, inputBoxReading }),
			inputSideByteTrackingHasEverObservedHumanBytes: trackerState.hasEverObservedHumanInputBytesFromWriteInput,
		});
	}

	function reconcile(
		state: TerminalInputBoxOccupancyTrackerState,
		observation: {
			screenReadingLocatedInputBox?: boolean;
			screenReadingSaysInputBoxIsEmpty?: boolean;
			humanIsAbsentFromThisTerminal?: boolean;
		} = {},
	): boolean {
		return reconcileInputSideOccupancyLatchAgainstConfirmedEmptyScreenReading(state, {
			screenReadingLocatedInputBox: observation.screenReadingLocatedInputBox ?? true,
			screenReadingSaysInputBoxIsEmpty: observation.screenReadingSaysInputBoxIsEmpty ?? true,
			humanIsAbsentFromThisTerminal: observation.humanIsAbsentFromThisTerminal ?? true,
		});
	}

	// 事故形态本身：退格删光了，但退格按设计不复位闩（删到空没有无法从字节流单独判定），
	// 于是输入侧咬定非空、读屏看到空框，争用判据每一拍都返回 human_uncommitted_input_present。
	it("退格删光后闩仍咬住 → 读屏连续 3 拍确证空框且人不在场，第 3 拍复位", () => {
		const state = createTerminalInputBoxOccupancyTrackerState();
		feed(state, "半句话");
		feed(state, BACKSPACE.repeat(3));
		expect(state.hasUncommittedInputFromInputSideByteTracking).toBe(true);
		expect(contentionOf(state, reading(""))).toBe("human_uncommitted_input_present");

		expect(reconcile(state)).toBe(false);
		expect(reconcile(state)).toBe(false);
		expect(reconcile(state)).toBe(true);

		expect(state.hasUncommittedInputFromInputSideByteTracking).toBe(false);
		expect(contentionOf(state, reading(""))).toBe("input_box_clear_for_programmatic_delivery");
	});

	// 「读不到框」不是「框是空的」。TUI 正在重绘 / 框被全屏输出盖住 / 该 agent 的输入框语法没建模，
	// 都会让读屏定位不到框——拿它当空就是这条工作流要根除的那种反向撒谎。
	it("读屏定位不到框 → 永远不复位，攒多少拍都不算数", () => {
		const state = createTerminalInputBoxOccupancyTrackerState();
		feed(state, "半句话");
		for (let tick = 0; tick < 10; tick += 1) {
			expect(
				reconcile(state, { screenReadingLocatedInputBox: false, screenReadingSaysInputBoxIsEmpty: false }),
			).toBe(false);
		}
		expect(state.hasUncommittedInputFromInputSideByteTracking).toBe(true);
	});

	it("屏上还有字 → 不复位（框里真有东西，包括被折叠成占位符的粘贴）", () => {
		const state = createTerminalInputBoxOccupancyTrackerState();
		feed(state, "半句话");
		for (let tick = 0; tick < 10; tick += 1) {
			expect(reconcile(state, { screenReadingSaysInputBoxIsEmpty: false })).toBe(false);
		}
		expect(state.hasUncommittedInputFromInputSideByteTracking).toBe(true);
	});

	// 人正坐在终端前时，这一帧读到空框也可能只是他刚删完还没接着打。
	it("人在场 → 不复位", () => {
		const state = createTerminalInputBoxOccupancyTrackerState();
		feed(state, "半句话");
		for (let tick = 0; tick < 10; tick += 1) {
			expect(reconcile(state, { humanIsAbsentFromThisTerminal: false })).toBe(false);
		}
		expect(state.hasUncommittedInputFromInputSideByteTracking).toBe(true);
	});

	it("连拍中断即归零：攒到 2 拍后来一拍非空，要重新攒满 3 拍", () => {
		const state = createTerminalInputBoxOccupancyTrackerState();
		feed(state, "半句话");
		expect(reconcile(state)).toBe(false);
		expect(reconcile(state)).toBe(false);
		expect(reconcile(state, { screenReadingSaysInputBoxIsEmpty: false })).toBe(false);
		expect(reconcile(state)).toBe(false);
		expect(reconcile(state)).toBe(false);
		expect(reconcile(state)).toBe(true);
	});

	// hasEverObserved 衡量的是「输入侧这只眼睛接没接上人」，与「框里此刻有什么」正交，自愈不该动它。
	it("自愈不会让输入侧重新变瞎", () => {
		const state = createTerminalInputBoxOccupancyTrackerState();
		feed(state, "半句话");
		reconcile(state);
		reconcile(state);
		expect(reconcile(state)).toBe(true);
		expect(state.hasEverObservedHumanInputBytesFromWriteInput).toBe(true);
	});

	// 更硬的那条闩：未闭合粘贴里 CR 只被计成一次换行，永远走不到复位。若无上界，结束标记一丢，
	// 用户此后按多少次回车都清不掉这个闩。
	it("bracketed paste 结束标记丢失 → 期间的回车不复位闩（这是死局的成因）", () => {
		const state = createTerminalInputBoxOccupancyTrackerState();
		feed(state, `${PASTE_START}粘了一段`);
		feed(state, CARRIAGE_RETURN);
		expect(state.insideBracketedPaste).toBe(true);
		expect(state.hasUncommittedInputFromInputSideByteTracking).toBe(true);
	});

	it("未闭合 paste 挂过上界时长 → 强制封账，其后的回车重新能复位", () => {
		const state = createTerminalInputBoxOccupancyTrackerState();
		feed(state, `${PASTE_START}粘了一段`, 1_000);
		// 上界之内照旧当粘贴续传：这一拍的回车仍被吞成载荷里的换行。
		feed(state, CARRIAGE_RETURN, 1_000 + 9_999);
		expect(state.insideBracketedPaste).toBe(true);
		expect(state.hasUncommittedInputFromInputSideByteTracking).toBe(true);

		// 越过上界的这一次调用，先封账再解析——于是同一个回车这次真的复位了整条组合。
		feed(state, CARRIAGE_RETURN, 1_000 + 10_000);
		expect(state.insideBracketedPaste).toBe(false);
		expect(state.hasUncommittedInputFromInputSideByteTracking).toBe(false);
	});

	// 硬规则 2：强制封账不静默丢内容——条目照常入账、计量照常记，但**正文一律不留**并计入
	// unrecoverablePasteCount。手上这半截一定不完整（结束标记没来，后面可能还有真正的载荷尾部，
	// 延迟到达的分片就是这个形态），当成完整正文入账正是「回填侧拿腰斩文本替换占位符」那种静默丢字。
	it("强制封账只留计量、丢正文，并计入不可还原", () => {
		const state = createTerminalInputBoxOccupancyTrackerState();
		feed(state, `${PASTE_START}粘了一段`, 1_000);
		feed(state, "结束标记丢了之后人又敲的字", 1_000 + 10_000);
		expect(state.insideBracketedPaste).toBe(false);
		expect(state.pasteLedger).toHaveLength(1);
		expect(state.pasteLedger[0].payloadText).toBeNull();
		expect(state.pasteLedger[0].characterCount).toBe("粘了一段".length);
		expect(state.unrecoverablePasteCount).toBe(1);
		expect(state.hasUncommittedInputFromInputSideByteTracking).toBe(true);
	});

	// 正常封账（真的收到了结束标记）不受影响：正文照常留存、不计入不可还原。
	it("正常封账仍留正文，不被强制封账的严格化波及", () => {
		const state = createTerminalInputBoxOccupancyTrackerState();
		feed(state, `${PASTE_START}完整的一段${PASTE_END}`, 1_000);
		expect(state.pasteLedger[0].payloadText).toBe("完整的一段");
		expect(state.unrecoverablePasteCount).toBe(0);
	});

	// 上界按时长而不是调用次数，正是为了这一格：12 KB 的粘贴按 64 字节分片就是 192 次 writeInput，
	// 用次数作界会把这种完全正常的大粘贴中途腰斩。
	it("正常大粘贴被切成上百片仍不误封账：判据是挂了多久，不是切了几片", () => {
		const state = createTerminalInputBoxOccupancyTrackerState();
		const payload = "行".repeat(4_096);
		feedInByteSlices(state, `${PASTE_START}${payload}${PASTE_END}`, 64, 5_000);
		expect(state.insideBracketedPaste).toBe(false);
		expect(state.openBracketedPasteStartedAtEpochMs).toBeNull();
		expect(state.pasteLedger[0].payloadText).toBe(payload);
	});
});
