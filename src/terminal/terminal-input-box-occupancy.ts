// 终端输入框「占用」跟踪：从**输入侧字节流**推断「框里此刻有没有用户尚未提交的内容」，
// 并为被 TUI 折叠成 `[Pasted text #N +M lines]` 的粘贴留一份原文账本。
//
// 与 terminal-input-box-reader.ts 的分工（两个模块合起来才是完整判据）：
//
//   terminal-input-box-reader    读**屏幕**：框在哪、框里渲染出来的文本是什么。
//   terminal-input-box-occupancy 读**键盘**：用户敲进去了什么、提交了没有、粘贴原文是什么。
//
// 为什么判空必须由输入侧负责、而不能读屏：Claude 有时在空框里渲染占位提示
// （`❯ Try "edit session-manager.ts to..."`），出现与否不确定（同一命令同一 cwd，一次探针拍到、
// 随后 6 次连拍 12 秒都没有）；用户按 Home 后的光标位置与空框也完全相同（都是 cursorX=2）。
// 读屏因此**无法**区分空与非空。而键盘字节流里「敲了可打印字符」「按了回车提交」是确定的事件，
// 不受 TUI 画法影响。
//
// 为什么粘贴账本必须在输入侧：TUI 把 ≥4 行（或超长单行）的粘贴折叠成占位符后，
// **视口里不留任何原文**；`~/.claude/paste-cache/` 又只在消息被提交时才落盘（实测：粘贴后 0
// 新增、Ctrl+S 后 0 新增、进程退出后 0 新增）。未提交的粘贴原文在世界上只剩一处能拿到：
// 它流过服务端 writeInput 的那一刻。
//
// ## 两条硬规则
//
// 1. **保守方向永远是「有内容」。** 判据不确定时（未知转义序列、退格、Ctrl+U 杀行）一律
//    维持既有状态而不清空。误判成「有内容」的后果是程序化投递让路、最终以诚实的
//    `human_terminal_contention_timeout` 失败并可重投；误判成「空」的后果是把 paste 插进
//    人类打了一半的那一行。两者不对称，只能往前者偏。
// 2. **绝不静默丢内容。** 载荷超出留存上限时保留计量、丢弃正文并计入
//    `unrecoverablePasteCount`，让回填侧知道「这里还原不了」而拒绝猜测。
//
// ## 只看得见人类输入，这正是想要的
//
// 程序化投递（task-chat / RVF followup / 自动续跑）走 `active.session.write` 直写 PTY，
// **不过** writeInput，因此不进这本账、也不会把自己记成「用户正在打字」。

import { StringDecoder } from "node:string_decoder";

import type { TerminalInputBoxReading } from "./terminal-input-box-reader";

// ── 输入字节语义（真机实测，Claude Code v2.1.227）────────────────────────────────
//
// 提交与换行是**两个不同的字节**，不能混为一谈：
//   - 回车（Enter）→ CR，提交当前消息，框被清空。
//   - Shift+Enter → LF（web-ui 的 SHIFT_ENTER_SEQUENCE 就是 "\n"），在框内插入换行，内容仍未提交。
// 把 `\n` 与 `\r` 一起当提交处理，会把「用户正按 Shift+Enter 写多行」误判成「框已空」。
//
// 控制字符一律写成 \u 转义：它们在编辑器里不可见，字面量形式极易在复制粘贴中被悄悄弄丢。
const CARRIAGE_RETURN_SUBMITS_CURRENT_COMPOSITION = "\u000d";
const LINE_FEED_INSERTS_NEWLINE_WITHOUT_SUBMITTING = "\u000a";
// Ctrl+C：实测是唯一能整框清空的控制键（Ctrl+U 只是杀行，清不掉整框）。
const END_OF_TEXT_CLEARS_INPUT_BOX = "\u0003";
// Ctrl+S：Claude 的 stash——清空输入框并在状态栏显示 `› stashed`。W2 把它改写成「存进
// Prompt Library」之后仍会把这个字节转发给 Claude，所以两条路径下框最终都会被清空。
const DEVICE_CONTROL_3_STASHES_AND_CLEARS_INPUT_BOX = "\u0013";
const ESCAPE = "\u001b";
const BELL = "\u0007";
// bracketed paste 的起止标记。浏览器 xterm 在 bracketed paste 模式下把它们原样交给 onData，
// 于是原封不动地流到服务端 writeInput（sendIoData → tRPC / WebSocket → writeInput）。
const BRACKETED_PASTE_START_MARKER = "\u001b[200~";
const BRACKETED_PASTE_END_MARKER = "\u001b[201~";

// ── 留存上限 ────────────────────────────────────────────────────────────────────
//
// 账本按「当前这次未提交组合」存活：一提交 / 一清空就整本作废，所以上限管的是「一次组合里
// 粘了多少东西」，而不是会话累计量。

// 账本条目数上限。它同时是**数组长度**的硬上限：超出后的粘贴连只剩计量的空壳条目都不再留，
// 只累加 unrecoverablePasteCount。
const MAX_RETAINED_PASTE_LEDGER_ENTRY_COUNT = 32;
// 全账本载荷字符上限（1 MiB）。超出后新粘贴仍然入账，但只留计量、不留正文。
const MAX_RETAINED_PASTE_LEDGER_TOTAL_CHARACTER_COUNT = 1_048_576;
// 未闭合粘贴（起始标记已到、结束标记未到）的缓冲上限。超出即判定这段粘贴不可还原并停止留正文，
// 避免一个畸形 / 被截断的粘贴把整个会话的内存吃掉。
const MAX_OPEN_PASTE_PAYLOAD_CHARACTER_COUNT = MAX_RETAINED_PASTE_LEDGER_TOTAL_CHARACTER_COUNT;
// 尾部「疑似不完整转义序列」最多留多长的回车带。超过即认定它不是一条能补全的序列（键盘不会发出
// 这么长的序列），消费掉那个 ESC 继续扫描，免得一个孤立 ESC 把解析器永久卡住。
const MAX_INCOMPLETE_ESCAPE_SEQUENCE_CARRY_LENGTH = 64;

// 账本里的一条粘贴。
export interface TerminalInputBoxPasteLedgerEntry {
	// 在「当前这次未提交组合」里的出现序号，从 1 起。占位符回填靠的是顺序而不是 Claude 的全局
	// `#N`——后者只有被折叠的粘贴才占号、且跨组合单调递增，与本账本对不上。
	pasteOrdinalWithinCurrentComposition: number;
	// 粘贴原文。null = 载荷超出留存上限被丢弃，只剩计量；回填侧见到 null 必须拒绝猜测。
	payloadText: string | null;
	// 载荷行数（末尾那个换行不额外算一行）。占位符 `+M lines` 里的 M == lineCount - 1，
	// 是回填配对的校验量。空载荷为 0。
	lineCount: number;
	// 载荷字符数（UTF-16 码元数）。无 lines 后缀的超长单行占位符靠它校验。
	characterCount: number;
}

// 跟踪器状态。可变，一个 active PTY 会话一份，随会话创建 / 销毁。
export interface TerminalInputBoxOccupancyTrackerState {
	// 输入侧字节跟踪给出的结论：当前组合里有没有尚未提交的内容。
	hasUncommittedInputFromInputSideByteTracking: boolean;
	pasteLedger: TerminalInputBoxPasteLedgerEntry[];
	// 本次组合里载荷已被丢弃（超上限）的粘贴条数。>0 意味着「无损暂存」的前提不成立——
	// W1 争用抢占必须据此降级为挂起可见、不抢占，绝不为投递成功率去赌一段还原不了的人类输入。
	unrecoverablePasteCount: number;
	// 当前是否处于 bracketed paste 之中（起始标记已到、结束标记未到）。
	insideBracketedPaste: boolean;
	// 未闭合粘贴已留下的载荷正文（超上限后停止增长）。
	openPastePayloadText: string;
	// 未闭合粘贴的真实字符数（**含**已被丢弃的部分），入账时作为 characterCount。
	openPastePayloadCharacterCount: number;
	// 未闭合粘贴里已见到的换行分隔符数（`\r\n` 只算一次）。
	openPastePayloadNewlineSeparatorCount: number;
	// 上一个字符是不是 CR：`\r\n` 可能被 chunk 边界切开，跨 chunk 也要只算一次换行。
	openPastePayloadPreviousCharacterWasCarriageReturn: boolean;
	// 上一个字符是不是换行分隔符：用于在封账时把「以换行结尾」的载荷少算一行。
	openPastePayloadPreviousCharacterWasNewlineSeparator: boolean;
	// 未闭合粘贴是否已因超上限停止留正文。
	openPastePayloadExceededRetentionLimit: boolean;
	// 已入账载荷的总字符数（只数真正留了正文的那些）。
	retainedPasteLedgerTotalCharacterCount: number;
	// 本次组合累计出现过的粘贴条数（含只留计量的），用于给序号。
	pasteCountWithinCurrentComposition: number;
	// 尚未解析完的尾巴：被 chunk 边界切断的转义序列 / 粘贴标记。
	pendingUnparsedText: string;
	// UTF-8 流式解码器。WebSocket 二进制帧可能把一个多字节字符切成两半，逐 chunk 各自
	// `toString("utf8")` 会把中文粘贴解成乱码；StringDecoder 负责把半个字符留到下一 chunk。
	utf8StreamDecoder: StringDecoder;
}

export function createTerminalInputBoxOccupancyTrackerState(): TerminalInputBoxOccupancyTrackerState {
	return {
		hasUncommittedInputFromInputSideByteTracking: false,
		pasteLedger: [],
		unrecoverablePasteCount: 0,
		insideBracketedPaste: false,
		openPastePayloadText: "",
		openPastePayloadCharacterCount: 0,
		openPastePayloadNewlineSeparatorCount: 0,
		openPastePayloadPreviousCharacterWasCarriageReturn: false,
		openPastePayloadPreviousCharacterWasNewlineSeparator: false,
		openPastePayloadExceededRetentionLimit: false,
		retainedPasteLedgerTotalCharacterCount: 0,
		pasteCountWithinCurrentComposition: 0,
		pendingUnparsedText: "",
		utf8StreamDecoder: new StringDecoder("utf8"),
	};
}

// 一次组合结束（提交 / 整框清空）：账本与判空一起归零。粘贴序号也随之重来，因为占位符配对
// 只在同一次组合内有意义。
//
// 供 W2 的暂存 procedure 在「读框 → 回填 → 写库 → 转发 Ctrl+S 字节清框」这条原子链路末尾显式调用：
// 前端拦截 Ctrl+S 后不会再把该字节交给 onData，服务端转发的那一份也走 session.write 直写 PTY，
// 两条路都不经过 writeInput，跟踪器只能靠调用方通知。
export function resetTerminalInputBoxOccupancyTrackerComposition(state: TerminalInputBoxOccupancyTrackerState): void {
	state.hasUncommittedInputFromInputSideByteTracking = false;
	state.pasteLedger = [];
	state.unrecoverablePasteCount = 0;
	state.insideBracketedPaste = false;
	state.openPastePayloadText = "";
	state.openPastePayloadCharacterCount = 0;
	state.openPastePayloadNewlineSeparatorCount = 0;
	state.openPastePayloadPreviousCharacterWasCarriageReturn = false;
	state.openPastePayloadPreviousCharacterWasNewlineSeparator = false;
	state.openPastePayloadExceededRetentionLimit = false;
	state.retainedPasteLedgerTotalCharacterCount = 0;
	state.pasteCountWithinCurrentComposition = 0;
	// pendingUnparsedText 与解码器**不**清：它们装的是「被 chunk 边界切断的半个字符 / 半条序列」，
	// 属于传输层残留而非组合内容，清掉等于主动制造乱码。
}

// 一条转义序列有多长。返回 "incomplete" 表示当前文本还不足以判断——调用方应把它整段留到下一 chunk。
//
// escapeCharacterWasCarriedOverFromPreviousChunk：这个 ESC 是上一 chunk 结转过来的（它到达时，那一
// chunk 就在它后面断掉了）。此时不能再把它与本 chunk 的下一个字符合成 Alt 组合键——见下方注释。
function measureEscapeSequenceLength(
	text: string,
	startIndex: number,
	escapeCharacterWasCarriedOverFromPreviousChunk: boolean,
): number | "incomplete" {
	const nextCharacter = text[startIndex + 1];
	if (nextCharacter === undefined) {
		return "incomplete";
	}
	if (nextCharacter === "[") {
		// CSI：参数字节 0x30–0x3F、中间字节 0x20–0x2F，终止于 0x40–0x7E。方向键、Home/End 之类
		// 都走这里——它们是导航而非内容，绝不能被记成「用户打了字」。
		for (let index = startIndex + 2; index < text.length; index += 1) {
			const codeUnit = text.charCodeAt(index);
			if (codeUnit >= 0x40 && codeUnit <= 0x7e) {
				return index - startIndex + 1;
			}
		}
		return "incomplete";
	}
	if (nextCharacter === "]") {
		// OSC：以 BEL 或 ST（ESC \）收尾。
		for (let index = startIndex + 2; index < text.length; index += 1) {
			if (text[index] === BELL) {
				return index - startIndex + 1;
			}
			if (text[index] === ESCAPE && text[index + 1] === "\\") {
				return index - startIndex + 2;
			}
		}
		return "incomplete";
	}
	if (nextCharacter === "O") {
		// SS3：应用光标键模式下的方向键（ESC O A 等），固定 3 字符。
		return text[startIndex + 2] === undefined ? "incomplete" : 3;
	}
	if (escapeCharacterWasCarriedOverFromPreviousChunk) {
		// 真正的 Alt 组合键由终端在同一次 onData 里原子发出，ESC 与那个字符之间不会骑上 chunk 边界。
		// 所以「上一 chunk 以孤立 ESC 结尾、本 chunk 另起一个非 [ / ] / O 的字符」只可能是**两次**输入：
		// 用户先按了 Escape，随后又敲了字符 / 粘了东西。把它们合成 Alt 序列整体吞掉有两个后果：
		//   ① 那个字符不被记成内容，判空往「空」的方向撒谎（违反硬规则 1）；
		//   ② 若后面紧跟的是粘贴，被吞掉的正是粘贴起始标记的首字节 ESC，起始标记识别不出来，
		//      整段粘贴的原文既进不了账本、也不会计入 unrecoverablePasteCount（违反硬规则 2）。
		// 只消费 ESC 自身，让后面的字节按自己的语义继续扫描。注意 [ / ] / O 三种续接仍照旧粘合——
		// 那正是 carry 存在的理由（起始标记 `ESC[200~` 被切在 ESC 之后必须能拼回）。
		return 1;
	}
	// ESC + 单字符：Alt 组合键等。按 2 字符消费，且**不**改判空状态——Alt+Backspace 删词之类
	// 会让框变空，但我们宁可继续认为「有内容」（硬规则 1）。
	return 2;
}

// text 末尾有多长的一段是 marker 的真前缀（即「标记被 chunk 边界切开了」）。返回这段的起点下标；
// 没有则返回 text.length。只需检查最后 marker.length - 1 个字符。
function locateTrailingPartialMarkerStartIndex(text: string, searchFromIndex: number, marker: string): number {
	const maximumPartialLength = Math.min(marker.length - 1, text.length - searchFromIndex);
	for (let partialLength = maximumPartialLength; partialLength >= 1; partialLength -= 1) {
		if (text.endsWith(marker.slice(0, partialLength))) {
			return text.length - partialLength;
		}
	}
	return text.length;
}

function appendToOpenBracketedPastePayload(state: TerminalInputBoxOccupancyTrackerState, segment: string): void {
	for (let index = 0; index < segment.length; index += 1) {
		const character = segment[index];
		if (character === CARRIAGE_RETURN_SUBMITS_CURRENT_COMPOSITION) {
			state.openPastePayloadNewlineSeparatorCount += 1;
			state.openPastePayloadPreviousCharacterWasCarriageReturn = true;
			state.openPastePayloadPreviousCharacterWasNewlineSeparator = true;
			continue;
		}
		if (character === LINE_FEED_INSERTS_NEWLINE_WITHOUT_SUBMITTING) {
			// CRLF 只算一次换行；CR 与 LF 可能落在不同 chunk，故这个「上一字符是 CR」的标记是跨 chunk 的。
			if (!state.openPastePayloadPreviousCharacterWasCarriageReturn) {
				state.openPastePayloadNewlineSeparatorCount += 1;
			}
			state.openPastePayloadPreviousCharacterWasCarriageReturn = false;
			state.openPastePayloadPreviousCharacterWasNewlineSeparator = true;
			continue;
		}
		state.openPastePayloadPreviousCharacterWasCarriageReturn = false;
		state.openPastePayloadPreviousCharacterWasNewlineSeparator = false;
	}
	state.openPastePayloadCharacterCount += segment.length;
	if (state.openPastePayloadExceededRetentionLimit) {
		return;
	}
	if (state.openPastePayloadText.length + segment.length > MAX_OPEN_PASTE_PAYLOAD_CHARACTER_COUNT) {
		// 只留计量、丢正文。半截正文比没有正文更危险：回填侧会拿一段被腰斩的文本去替换占位符，
		// 用户看不出少了什么。要么完整，要么明说还原不了。
		state.openPastePayloadExceededRetentionLimit = true;
		state.openPastePayloadText = "";
		return;
	}
	state.openPastePayloadText += segment;
}

function openBracketedPaste(state: TerminalInputBoxOccupancyTrackerState): void {
	state.insideBracketedPaste = true;
	// 起始标记一到就置位，不等结束标记（硬规则 1）。粘贴被切成多个 chunk 送达时，「起始标记与部分
	// 正文已到、结束标记未到」是一个真实存在的中间窗口；若判空要等到 closeOpenBracketedPaste 才置位，
	// 争用判据在这个窗口里会读到「框是空的」，程序化投递被放行、插进人类正在进行中的粘贴。
	state.hasUncommittedInputFromInputSideByteTracking = true;
	state.openPastePayloadText = "";
	state.openPastePayloadCharacterCount = 0;
	state.openPastePayloadNewlineSeparatorCount = 0;
	state.openPastePayloadPreviousCharacterWasCarriageReturn = false;
	state.openPastePayloadPreviousCharacterWasNewlineSeparator = false;
	state.openPastePayloadExceededRetentionLimit = false;
}

function closeOpenBracketedPaste(state: TerminalInputBoxOccupancyTrackerState): void {
	const payloadCharacterCount = state.openPastePayloadCharacterCount;
	// 以换行结尾的载荷不额外算出一个空行：粘 3 行文本时用户与 TUI 都认为它是 3 行。
	const lineCount =
		payloadCharacterCount === 0
			? 0
			: state.openPastePayloadNewlineSeparatorCount +
				1 -
				(state.openPastePayloadPreviousCharacterWasNewlineSeparator ? 1 : 0);
	const retainPayload =
		!state.openPastePayloadExceededRetentionLimit &&
		state.pasteLedger.length < MAX_RETAINED_PASTE_LEDGER_ENTRY_COUNT &&
		state.retainedPasteLedgerTotalCharacterCount + state.openPastePayloadText.length <=
			MAX_RETAINED_PASTE_LEDGER_TOTAL_CHARACTER_COUNT;
	state.pasteCountWithinCurrentComposition += 1;
	if (retainPayload) {
		state.retainedPasteLedgerTotalCharacterCount += state.openPastePayloadText.length;
	} else {
		state.unrecoverablePasteCount += 1;
	}
	// 条目数硬上限。既有的两个上限都只决定「要不要留正文」，条目对象本身仍是无条件 push 的——
	// 一次长时间未提交的组合里连续小粘贴，账本数组会一直涨（实测 10000 次小粘贴 = 10000 个对象），
	// 而其中超出第 32 条的那些 payloadText 本来就已经是 null、只剩计量。既然它们还原不了，就不必
	// 为每一条各留一个对象：不入账，但 pasteCountWithinCurrentComposition 与 unrecoverablePasteCount
	// 照常累加——「这次组合里有还原不了的粘贴」这个结论仍然到得了回填侧（硬规则 2 要的是不静默丢，
	// 而不是每条都留壳）。
	if (state.pasteLedger.length < MAX_RETAINED_PASTE_LEDGER_ENTRY_COUNT) {
		state.pasteLedger.push({
			pasteOrdinalWithinCurrentComposition: state.pasteCountWithinCurrentComposition,
			payloadText: retainPayload ? state.openPastePayloadText : null,
			lineCount: Math.max(lineCount, payloadCharacterCount === 0 ? 0 : 1),
			characterCount: payloadCharacterCount,
		});
	}
	state.insideBracketedPaste = false;
	state.openPastePayloadText = "";
	state.openPastePayloadCharacterCount = 0;
	state.openPastePayloadNewlineSeparatorCount = 0;
	state.openPastePayloadPreviousCharacterWasCarriageReturn = false;
	state.openPastePayloadPreviousCharacterWasNewlineSeparator = false;
	state.openPastePayloadExceededRetentionLimit = false;
	// 粘贴本身就是往框里放内容，无论是否留得住正文。
	state.hasUncommittedInputFromInputSideByteTracking = true;
}

// 摄入一段流向 PTY 的人类输入字节。writeInput 每次调用一次；同一段粘贴被切成多个 chunk 送达也能拼回。
export function recordTerminalInputBytesIntoOccupancyTracker(
	state: TerminalInputBoxOccupancyTrackerState,
	data: Buffer,
): void {
	// 上一 chunk 结转过来的那截未解析尾巴总是以 ESC 开头（它就是「疑似被切断的转义序列 / 粘贴标记」），
	// 且总是坐在拼接后文本的最前面。记下它的长度，就能认出「哪个 ESC 跨过了 chunk 边界」。
	const carriedOverUnparsedTextLength = state.pendingUnparsedText.length;
	const text = state.pendingUnparsedText + state.utf8StreamDecoder.write(data);
	let index = 0;
	while (index < text.length) {
		if (state.insideBracketedPaste) {
			const endMarkerIndex = text.indexOf(BRACKETED_PASTE_END_MARKER, index);
			if (endMarkerIndex === -1) {
				// 结束标记可能正被 chunk 边界切开，尾部那截真前缀必须留到下一 chunk 再判，
				// 否则它会被当成粘贴正文吃进载荷。
				const carryStartIndex = locateTrailingPartialMarkerStartIndex(text, index, BRACKETED_PASTE_END_MARKER);
				appendToOpenBracketedPastePayload(state, text.slice(index, carryStartIndex));
				index = carryStartIndex;
				break;
			}
			appendToOpenBracketedPastePayload(state, text.slice(index, endMarkerIndex));
			closeOpenBracketedPaste(state);
			index = endMarkerIndex + BRACKETED_PASTE_END_MARKER.length;
			continue;
		}
		const character = text[index];
		if (character === ESCAPE) {
			if (text.startsWith(BRACKETED_PASTE_START_MARKER, index)) {
				openBracketedPaste(state);
				index += BRACKETED_PASTE_START_MARKER.length;
				continue;
			}
			const escapeSequenceLength = measureEscapeSequenceLength(text, index, index < carriedOverUnparsedTextLength);
			if (escapeSequenceLength === "incomplete") {
				if (text.length - index <= MAX_INCOMPLETE_ESCAPE_SEQUENCE_CARRY_LENGTH) {
					break;
				}
				// 等不到终止字节了：只消费掉这个 ESC，让后面的字节按普通内容继续扫描。方向偏向
				// 「有内容」，符合硬规则 1。
				index += 1;
				continue;
			}
			// 未闭合的粘贴结束标记（无起始标记）也会落在这里被当成一条普通 CSI 消费掉，正确。
			index += escapeSequenceLength;
			continue;
		}
		if (
			character === CARRIAGE_RETURN_SUBMITS_CURRENT_COMPOSITION ||
			character === END_OF_TEXT_CLEARS_INPUT_BOX ||
			character === DEVICE_CONTROL_3_STASHES_AND_CLEARS_INPUT_BOX
		) {
			resetTerminalInputBoxOccupancyTrackerComposition(state);
			index += 1;
			continue;
		}
		if (character === LINE_FEED_INSERTS_NEWLINE_WITHOUT_SUBMITTING) {
			state.hasUncommittedInputFromInputSideByteTracking = true;
			index += 1;
			continue;
		}
		const codeUnit = text.charCodeAt(index);
		// 其余 C0 控制字符与 DEL（退格 0x08 / macOS 退格 0x7F / Tab / Ctrl+U 杀行）一律**不改状态**：
		// 它们可能把框删空，但「删到空了没有」无法从字节流单独判定，只能保守留在「有内容」。
		if (codeUnit >= 0x20 && codeUnit !== 0x7f) {
			state.hasUncommittedInputFromInputSideByteTracking = true;
		}
		index += 1;
	}
	state.pendingUnparsedText = text.slice(index);
}

// 输入侧字节跟踪与读屏两路汇合后的占用结论。
export interface TerminalInputBoxOccupancy {
	// **保守的并**：任一路说「有内容」即为 true，程序化投递据此让路。
	hasUncommittedInput: boolean;
	// 输入侧字节跟踪这一路的结论。看不见经 tmux / 原生终端直连同一 PTY 的输入，也看不见
	// runtime 重启前敲下的内容——这正是需要读屏那一路补位的地方。
	inputSideByteTrackingSaysNonEmpty: boolean;
	// 读屏那一路的结论；null = 当前屏上定位不到输入框（TUI 尚未渲染或正被全屏输出覆盖）。
	//
	// ⚠️ 已知假阳性：Claude 偶发在空框里渲染占位提示（`Try "..."`），此时读屏会报「非空」。
	// 它进入保守的并之后会让投递持续让路——这不会退化成 2026-08-08 那种静默挂起，因为争用挂起
	// 有预算，耗尽即转 `delivery_failed{human_terminal_contention_timeout}`，调用方可择机重投。
	// 两路结论分开暴露，就是为了让争用策略能按场景决定要不要采信这一路，而不是被并死。
	screenReadingSaysNonEmpty: boolean | null;
	// 本次组合里还原不了正文的粘贴条数（见 unrecoverablePasteCount）。
	unrecoverablePasteCount: number;
}

export function resolveTerminalInputBoxOccupancy(args: {
	trackerState: TerminalInputBoxOccupancyTrackerState;
	inputBoxReading: TerminalInputBoxReading | null;
}): TerminalInputBoxOccupancy {
	const inputSideByteTrackingSaysNonEmpty = args.trackerState.hasUncommittedInputFromInputSideByteTracking;
	const screenReadingSaysNonEmpty = args.inputBoxReading ? args.inputBoxReading.text.trim().length > 0 : null;
	return {
		hasUncommittedInput: inputSideByteTrackingSaysNonEmpty || screenReadingSaysNonEmpty === true,
		inputSideByteTrackingSaysNonEmpty,
		screenReadingSaysNonEmpty,
		unrecoverablePasteCount: args.trackerState.unrecoverablePasteCount,
	};
}
