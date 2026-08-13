// 把输入框里被 TUI 折叠成 `[Pasted text #N +M lines]` 的占位符换回粘贴原文。
//
// 三个模块合起来才凑出「未提交输入的完整正文」：
//   terminal-input-box-reader     读屏 → 拿到框内**渲染出来**的文本（含占位符）
//   terminal-input-box-occupancy  读键盘 → 拿到被折叠掉的粘贴原文账本
//   本模块                        把两边按顺序配对，还原成用户眼里那段完整的输入
//
// ## 为什么必须配对而不能直接拼接
//
// 占位符是**内联**的，位置由用户决定：
//     ❯ BEFORE-TYPED [Pasted text #5 +11 lines] AFTER-TYPED [Pasted text #6 +14 lines]
// 手打文字与粘贴块交错出现，只有按占位符在文本里的位置逐个替换才能还原原貌。
//
// ## 配对判据：顺序 + 计量校验，**绝不猜**
//
// 不拿占位符里的 `#N` 当配对键：那是 Claude 的**全局**计数器，只有被折叠的粘贴才占号、且跨消息
// 单调递增，与本进程的账本（按「当前这次未提交组合」重新计数）根本对不上——把两个不同来源的序号
// 硬配是在制造「看起来对上了」的假象。（`#N` 唯一的用途是下面那道自洽性闸门里的证伪量。）
//
// 真正的判据是两条：
//   1. **顺序**：占位符在框里的先后 == 账本里被折叠粘贴的先后（TUI 按插入位置内联保序，实测确认）。
//   2. **计量校验**：`+M lines` 必须等于该条账本记录的 `lineCount - 1`；无行数后缀的（超长单行被折叠）
//      要求该条记录是单行、且长到确实会被折叠。
//
// 账本里同时躺着**没有**被折叠的粘贴（≤3 行、且不超长的那些——它们的原文本就完整留在框里）。
// 所以配对是「按序向前扫描、跳过计量对不上的条目」，而不是按下标一一对应。
//
// 校验不过、或配到的那条只剩计量没有正文（超出留存上限被丢），一律**保留占位符原文**并计数上报。
// 硬规则：绝不静默丢内容，也绝不拿一段猜出来的文本冒充用户写的东西——把一段还原错的文字存进
// Prompt Library，用户看不出哪里少了、哪里串了。
//
// ## 开工前的整框自洽性闸门：分不清哪个是真的，就整框不猜
//
// 占位符没有任何转义或标记，用户完全可以自己手打一段同形的字面量。只按顺序 + 计量配对时，
// 手打的那段会先抢走账本条目被换成粘贴原文，真正的占位符反倒配不上——**用户写的字被静默调换**，
// 这正是上面那条硬规则最不能破的一面。所以回填开始之前，先对**整框的占位符**做一次自洽性校验，
// 两条都必须成立：
//   1. `+M lines` 的 M >= 3。TUI 只折叠 ≥4 行的粘贴，真占位符的 M == 行数 - 1 恒 >= 3；
//      `+1 lines` 这种形态根本折不出来，只可能是人手打的。
//   2. `#N` 按框内出现顺序**严格递增**。`#N` 由 TUI 的全局计数器按折叠先后单调分配（重申：它
//      **不是**配对键，账本的序号与它对不上，这里只拿它当证伪用的一致性量）。不递增只有两种
//      解释：混进了手打的同形字面量，或者用户把光标移回前面又粘了一次——后者意味着「框内顺序
//      == 账本顺序」这个配对前提本身已经不成立，继续按序配只会把两段粘贴原文互换位置。
//
// 校验不过时**无从分辨哪个占位符是真的**，于是整框放弃回填：正文一个字不动，所有占位符原样保留，
// 全部计入 placeholdersLeftUnbackfilledBecausePlaceholderSelfConsistencyCheckFailed 如实上报。
//
// 挡不住什么（如实写在这里，别把它当成完备的防线）：
//   - 手打的字面量若在形态和序号上都与真占位符自洽，校验看不出来。例如用户先手打
//     `[Pasted text #1 +3 lines]`，再真实粘贴一段 4 行文本（TUI 分给它 `#2`）——序列 1、2 严格
//     递增、M 都 >= 3，那段手打字面量照样抢走账本条目、照样被静默调换。
//   - 框里只有一个占位符时第 2 条天然成立，能挡的只剩第 1 条形态校验。
//   - 真占位符被用户删掉、只剩手打字面量的情形同样自洽，挡不住。
// 要彻底根除得让 TUI 侧给折叠占位符带上不可伪造的标记，那不在本模块够得着的范围内。

import type { TerminalInputBoxPasteLedgerEntry } from "./terminal-input-box-occupancy";

// 折叠占位符的实测格式（Claude Code v2.1.227）：
//   [Pasted text #5 +11 lines]  —— ≥4 行的粘贴，M == 行数 - 1
//   [Pasted text #7]            —— 被折叠的超长单行，无行数后缀
// `lines?` 容忍将来可能出现的单数形态（当前 M >= 3 恒为复数，因为 ≤3 行的粘贴根本不折叠）。
const FOLDED_PASTE_PLACEHOLDER_PATTERN = /\[Pasted text #(\d+)(?: \+(\d+) lines?)?\]/gu;

// 实测：单行粘贴 420 字符**不**折叠、820 字符折叠，真实阈值落在这两者之间的某处。
// 无行数后缀的占位符只可能来自被折叠的单行粘贴，所以「字符数不超过已实测确认不会折叠的长度」
// 的账本条目一定不是它的来源。取实测确认的那一端做下界，宁可漏配（保留占位符、如实上报）
// 也不错配（把另一段粘贴的正文塞进这个位置）。
const MAX_SINGLE_LINE_PASTE_CHARACTER_COUNT_MEASURED_TO_STAY_UNFOLDED = 420;

// 真占位符的 `+M lines` 至少是 3：TUI 只折叠 ≥4 行的粘贴，而 M == 行数 - 1。
// 比它小的形态折不出来，见到即证明那段是人手打的同形字面量。
const MINIMUM_FOLDED_AWAY_LINE_COUNT_A_GENUINE_PLACEHOLDER_CAN_CLAIM = 3;

interface FoldedPastePlaceholderOccurrence {
	// 占位符在输入框文本里的原样片段，配对失败时原样留在结果里。
	matchedText: string;
	startIndex: number;
	endIndex: number;
	// 占位符里 `+M lines` 的 M；null = 无行数后缀（被折叠的超长单行）。
	foldedAwayLineCount: number | null;
	// 占位符里的 `#N`。**只用于**整框自洽性校验（严格递增），绝不拿它当配对键去索引账本。
	placeholderNumberAssignedByAgentTuiGlobalCounter: number;
}

export interface FoldedPastePlaceholderBackfillResult {
	// 回填后的完整正文。没有占位符时与输入原样相同。
	text: string;
	// 框里一共出现了几处**形如**折叠占位符的片段。整框自洽性校验没过时，这里面混着用户手打的
	// 同形字面量，无从分辨谁是谁——所以它是「见到几处」而不是「确认有几处是折叠出来的」。
	foldedPastePlaceholderCount: number;
	// 成功换回原文的个数。
	backfilledPlaceholderCount: number;
	// 配对到了账本条目、但那条只剩计量没有正文（超出留存上限被丢），占位符原样保留。
	placeholdersLeftUnbackfilledBecausePayloadWasDropped: number;
	// 在账本里找不到计量对得上的条目（经 tmux / 原生终端粘进同一 PTY，字节不过 writeInput；
	// 或 runtime 在这次组合中途重启过），占位符原样保留。
	placeholdersLeftUnbackfilledBecauseNoLedgerEntryMatched: number;
	// 整框自洽性校验没过（`+M lines` 的 M < 3，或 `#N` 不是严格递增）→ 框里混着手打的同形字面量、
	// 或粘贴不是按框内顺序发生的。分不清哪处是真占位符，于是整框放弃回填，所有占位符原样保留
	// 并全部计在这里（此时另外两个 unbackfilled 计数恒为 0：一次都没配过，谈不上配不上）。
	placeholdersLeftUnbackfilledBecausePlaceholderSelfConsistencyCheckFailed: number;
}

// 粘贴原文里的换行是**传输形态**：浏览器 xterm 在 bracketed paste 里把剪贴板换行一律规格化成 CR 交给
// PTY（在 PTY 这一侧 CR 才是「换行」的载体，LF 反而是 Shift+Enter 的插入符）。存进 Prompt Library 的却是
// 给人看、给人再编辑的文本，必须还原成 LF——否则条目在文本框里会挤成一行或留下游离的回车符。
//
// 账本自己刻意保留原始字节不做规格化：W1 争用抢占的「一键恢复」要把那段内容原样写回终端输入框，
// 那里 CR 与 LF 的语义天差地别（CR 提交、LF 换行）。规格化只发生在这条「给人看」的边界上。
function normalizePastePayloadNewlinesForHumanReadableText(payloadText: string): string {
	return payloadText.replace(/\r\n?/gu, "\n");
}

function locateFoldedPastePlaceholders(inputBoxText: string): FoldedPastePlaceholderOccurrence[] {
	const occurrences: FoldedPastePlaceholderOccurrence[] = [];
	// 每次调用重置游标：正则带 /g，模块级常量会在多次调用间残留 lastIndex。
	FOLDED_PASTE_PLACEHOLDER_PATTERN.lastIndex = 0;
	let match = FOLDED_PASTE_PLACEHOLDER_PATTERN.exec(inputBoxText);
	while (match !== null) {
		const foldedAwayLineCountText = match[2];
		occurrences.push({
			matchedText: match[0],
			startIndex: match.index,
			endIndex: match.index + match[0].length,
			foldedAwayLineCount: foldedAwayLineCountText === undefined ? null : Number(foldedAwayLineCountText),
			placeholderNumberAssignedByAgentTuiGlobalCounter: Number(match[1]),
		});
		match = FOLDED_PASTE_PLACEHOLDER_PATTERN.exec(inputBoxText);
	}
	return occurrences;
}

// 整框自洽性校验：这些片段**有没有可能**全都是 TUI 按它们出现的先后折叠出来的。
// 返回 false = 已经证伪（形态折不出来 / 序号不递增），此时哪处是真占位符无从分辨，
// 调用方必须整框放弃回填，而不是继续按序配——继续配就是拿猜出来的文本换掉用户写的字。
// 判据的适用边界（含挡不住的情形）写在文件头「开工前的整框自洽性闸门」一节。
function canAllPlaceholdersHaveBeenFoldedByAgentTuiInTheOrderTheyAppear(
	occurrences: readonly FoldedPastePlaceholderOccurrence[],
): boolean {
	let previousPlaceholderNumber: number | null = null;
	for (const occurrence of occurrences) {
		if (
			occurrence.foldedAwayLineCount !== null &&
			occurrence.foldedAwayLineCount < MINIMUM_FOLDED_AWAY_LINE_COUNT_A_GENUINE_PLACEHOLDER_CAN_CLAIM
		) {
			return false;
		}
		if (
			previousPlaceholderNumber !== null &&
			occurrence.placeholderNumberAssignedByAgentTuiGlobalCounter <= previousPlaceholderNumber
		) {
			return false;
		}
		previousPlaceholderNumber = occurrence.placeholderNumberAssignedByAgentTuiGlobalCounter;
	}
	return true;
}

// 这条账本记录的计量，与这个占位符声称的计量对得上吗。
function isLedgerEntryConsistentWithPlaceholder(
	entry: TerminalInputBoxPasteLedgerEntry,
	occurrence: FoldedPastePlaceholderOccurrence,
): boolean {
	if (occurrence.foldedAwayLineCount !== null) {
		// `+M lines` 里的 M 是「除首行外还有多少行」，故 M + 1 == 载荷行数。
		return entry.lineCount === occurrence.foldedAwayLineCount + 1;
	}
	return (
		entry.lineCount <= 1 && entry.characterCount > MAX_SINGLE_LINE_PASTE_CHARACTER_COUNT_MEASURED_TO_STAY_UNFOLDED
	);
}

export function backfillFoldedPastePlaceholdersFromPasteLedger(args: {
	inputBoxText: string;
	pasteLedger: readonly TerminalInputBoxPasteLedgerEntry[];
}): FoldedPastePlaceholderBackfillResult {
	const occurrences = locateFoldedPastePlaceholders(args.inputBoxText);
	if (occurrences.length === 0) {
		return {
			text: args.inputBoxText,
			foldedPastePlaceholderCount: 0,
			backfilledPlaceholderCount: 0,
			placeholdersLeftUnbackfilledBecausePayloadWasDropped: 0,
			placeholdersLeftUnbackfilledBecauseNoLedgerEntryMatched: 0,
			placeholdersLeftUnbackfilledBecausePlaceholderSelfConsistencyCheckFailed: 0,
		};
	}
	if (!canAllPlaceholdersHaveBeenFoldedByAgentTuiInTheOrderTheyAppear(occurrences)) {
		return {
			text: args.inputBoxText,
			foldedPastePlaceholderCount: occurrences.length,
			backfilledPlaceholderCount: 0,
			placeholdersLeftUnbackfilledBecausePayloadWasDropped: 0,
			placeholdersLeftUnbackfilledBecauseNoLedgerEntryMatched: 0,
			placeholdersLeftUnbackfilledBecausePlaceholderSelfConsistencyCheckFailed: occurrences.length,
		};
	}

	const textSegments: string[] = [];
	let copiedUpToIndex = 0;
	// 账本游标：只向前走，保证「占位符的先后 == 被折叠粘贴的先后」这条判据不被回头匹配破坏。
	let ledgerScanStartIndex = 0;
	let backfilledPlaceholderCount = 0;
	let placeholdersLeftUnbackfilledBecausePayloadWasDropped = 0;
	let placeholdersLeftUnbackfilledBecauseNoLedgerEntryMatched = 0;

	for (const occurrence of occurrences) {
		textSegments.push(args.inputBoxText.slice(copiedUpToIndex, occurrence.startIndex));
		copiedUpToIndex = occurrence.endIndex;

		let matchedLedgerEntryIndex = -1;
		for (let index = ledgerScanStartIndex; index < args.pasteLedger.length; index += 1) {
			if (isLedgerEntryConsistentWithPlaceholder(args.pasteLedger[index], occurrence)) {
				matchedLedgerEntryIndex = index;
				break;
			}
		}
		if (matchedLedgerEntryIndex === -1) {
			// 找不到就地停在原处：不推进游标——后面的占位符仍可能配上前面这些没被跳过的条目。
			textSegments.push(occurrence.matchedText);
			placeholdersLeftUnbackfilledBecauseNoLedgerEntryMatched += 1;
			continue;
		}
		// 被跳过的那些条目是「没有被折叠、原文本就完整留在框里」的粘贴，不该再被后面的占位符认领。
		ledgerScanStartIndex = matchedLedgerEntryIndex + 1;
		const payloadText = args.pasteLedger[matchedLedgerEntryIndex].payloadText;
		if (payloadText === null) {
			textSegments.push(occurrence.matchedText);
			placeholdersLeftUnbackfilledBecausePayloadWasDropped += 1;
			continue;
		}
		textSegments.push(normalizePastePayloadNewlinesForHumanReadableText(payloadText));
		backfilledPlaceholderCount += 1;
	}
	textSegments.push(args.inputBoxText.slice(copiedUpToIndex));

	return {
		text: textSegments.join(""),
		foldedPastePlaceholderCount: occurrences.length,
		backfilledPlaceholderCount,
		placeholdersLeftUnbackfilledBecausePayloadWasDropped,
		placeholdersLeftUnbackfilledBecauseNoLedgerEntryMatched,
		placeholdersLeftUnbackfilledBecausePlaceholderSelfConsistencyCheckFailed: 0,
	};
}
