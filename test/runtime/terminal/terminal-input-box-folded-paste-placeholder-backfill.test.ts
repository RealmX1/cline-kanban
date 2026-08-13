import { describe, expect, it } from "vitest";

import { backfillFoldedPastePlaceholdersFromPasteLedger } from "../../../src/terminal/terminal-input-box-folded-paste-placeholder-backfill";
import type { TerminalInputBoxPasteLedgerEntry } from "../../../src/terminal/terminal-input-box-occupancy";

function createLedgerEntry(
	overrides: Partial<TerminalInputBoxPasteLedgerEntry> & Pick<TerminalInputBoxPasteLedgerEntry, "payloadText">,
): TerminalInputBoxPasteLedgerEntry {
	const payloadText = overrides.payloadText;
	return {
		pasteOrdinalWithinCurrentComposition: 1,
		lineCount: payloadText === null ? 0 : payloadText.split(/\r\n?|\n/u).length,
		characterCount: payloadText === null ? 0 : payloadText.length,
		...overrides,
	};
}

describe("backfillFoldedPastePlaceholdersFromPasteLedger", () => {
	describe("配对成功", () => {
		it("没有占位符时原样返回，不动一个字符", () => {
			const result = backfillFoldedPastePlaceholdersFromPasteLedger({
				inputBoxText: "普通的一段手打输入",
				pasteLedger: [createLedgerEntry({ payloadText: "无关的粘贴" })],
			});
			expect(result.text).toBe("普通的一段手打输入");
			expect(result.foldedPastePlaceholderCount).toBe(0);
			expect(result.backfilledPlaceholderCount).toBe(0);
		});

		it("按 `+M lines` == lineCount - 1 配对，占位符换回原文", () => {
			const result = backfillFoldedPastePlaceholdersFromPasteLedger({
				inputBoxText: "请看 [Pasted text #3 +3 lines] 这段",
				pasteLedger: [createLedgerEntry({ payloadText: "one\ntwo\nthree\nfour" })],
			});
			expect(result.text).toBe("请看 one\ntwo\nthree\nfour 这段");
			expect(result.backfilledPlaceholderCount).toBe(1);
			expect(result.placeholdersLeftUnbackfilledBecauseNoLedgerEntryMatched).toBe(0);
		});

		it("多个占位符按出现顺序内联替换，手打文字留在原位", () => {
			const result = backfillFoldedPastePlaceholdersFromPasteLedger({
				inputBoxText: "BEFORE [Pasted text #5 +3 lines] MIDDLE [Pasted text #6 +4 lines] AFTER",
				pasteLedger: [
					createLedgerEntry({ payloadText: "a\nb\nc\nd" }),
					createLedgerEntry({ payloadText: "e\nf\ng\nh\ni", pasteOrdinalWithinCurrentComposition: 2 }),
				],
			});
			expect(result.text).toBe("BEFORE a\nb\nc\nd MIDDLE e\nf\ng\nh\ni AFTER");
			expect(result.backfilledPlaceholderCount).toBe(2);
		});

		it("账本里夹着未折叠的短粘贴时按序跳过，不把它错当成占位符的来源", () => {
			// 中间那条只有 2 行：TUI 不会折叠它，它的原文本就完整留在框里，绝不能被占位符认领。
			const result = backfillFoldedPastePlaceholdersFromPasteLedger({
				inputBoxText: "[Pasted text #9 +4 lines]",
				pasteLedger: [
					createLedgerEntry({ payloadText: "短\n粘贴" }),
					createLedgerEntry({ payloadText: "1\n2\n3\n4\n5", pasteOrdinalWithinCurrentComposition: 2 }),
				],
			});
			expect(result.text).toBe("1\n2\n3\n4\n5");
			expect(result.backfilledPlaceholderCount).toBe(1);
		});

		it("粘贴原文里的 CR 换行还原成 LF（账本存的是 PTY 传输形态，库里存的是给人看的文本）", () => {
			const result = backfillFoldedPastePlaceholdersFromPasteLedger({
				inputBoxText: "[Pasted text #1 +3 lines]",
				pasteLedger: [createLedgerEntry({ payloadText: "甲\r乙\r丙\r丁", lineCount: 4 })],
			});
			expect(result.text).toBe("甲\n乙\n丙\n丁");
		});

		it("无行数后缀的占位符配上「单行且长到确实会被折叠」的那条", () => {
			const longSingleLinePayload = "x".repeat(1_000);
			const result = backfillFoldedPastePlaceholdersFromPasteLedger({
				inputBoxText: "开头 [Pasted text #2] 结尾",
				pasteLedger: [createLedgerEntry({ payloadText: longSingleLinePayload, lineCount: 1 })],
			});
			expect(result.text).toBe(`开头 ${longSingleLinePayload} 结尾`);
			expect(result.backfilledPlaceholderCount).toBe(1);
		});
	});

	describe("校验不过就不猜（红线）", () => {
		it("行数对不上 → 保留占位符原文，计入「账本里没有配得上的条目」", () => {
			const result = backfillFoldedPastePlaceholdersFromPasteLedger({
				inputBoxText: "[Pasted text #4 +11 lines]",
				pasteLedger: [createLedgerEntry({ payloadText: "只有\n两行" })],
			});
			expect(result.text).toBe("[Pasted text #4 +11 lines]");
			expect(result.backfilledPlaceholderCount).toBe(0);
			expect(result.placeholdersLeftUnbackfilledBecauseNoLedgerEntryMatched).toBe(1);
			expect(result.placeholdersLeftUnbackfilledBecausePayloadWasDropped).toBe(0);
		});

		it("账本为空（经 tmux / 原生终端粘进同一 PTY，字节不过 writeInput）→ 全部保留并如实计数", () => {
			const result = backfillFoldedPastePlaceholdersFromPasteLedger({
				inputBoxText: "[Pasted text #1 +5 lines] 和 [Pasted text #2 +7 lines]",
				pasteLedger: [],
			});
			expect(result.text).toBe("[Pasted text #1 +5 lines] 和 [Pasted text #2 +7 lines]");
			expect(result.foldedPastePlaceholderCount).toBe(2);
			expect(result.placeholdersLeftUnbackfilledBecauseNoLedgerEntryMatched).toBe(2);
		});

		it("配到的条目只剩计量、正文已被丢（超留存上限）→ 保留占位符，且与「配不上」分开计数", () => {
			const result = backfillFoldedPastePlaceholdersFromPasteLedger({
				inputBoxText: "[Pasted text #8 +9 lines]",
				pasteLedger: [createLedgerEntry({ payloadText: null, lineCount: 10, characterCount: 9_000_000 })],
			});
			expect(result.text).toBe("[Pasted text #8 +9 lines]");
			expect(result.placeholdersLeftUnbackfilledBecausePayloadWasDropped).toBe(1);
			expect(result.placeholdersLeftUnbackfilledBecauseNoLedgerEntryMatched).toBe(0);
		});

		it("无行数后缀的占位符不认「实测确认不会被折叠」长度的单行粘贴", () => {
			// 实测：单行 420 字符不折叠。既然它不会折叠，就不可能是这个占位符的来源。
			const result = backfillFoldedPastePlaceholdersFromPasteLedger({
				inputBoxText: "[Pasted text #2]",
				pasteLedger: [createLedgerEntry({ payloadText: "y".repeat(420), lineCount: 1 })],
			});
			expect(result.text).toBe("[Pasted text #2]");
			expect(result.placeholdersLeftUnbackfilledBecauseNoLedgerEntryMatched).toBe(1);
		});

		it("前一个占位符配不上时不推进游标，后一个仍能配上它本该配的那条", () => {
			const result = backfillFoldedPastePlaceholdersFromPasteLedger({
				inputBoxText: "[Pasted text #1 +99 lines] 然后 [Pasted text #2 +3 lines]",
				pasteLedger: [createLedgerEntry({ payloadText: "甲\n乙\n丙\n丁" })],
			});
			expect(result.text).toBe("[Pasted text #1 +99 lines] 然后 甲\n乙\n丙\n丁");
			expect(result.backfilledPlaceholderCount).toBe(1);
			expect(result.placeholdersLeftUnbackfilledBecauseNoLedgerEntryMatched).toBe(1);
		});

		it("同一条账本记录不会被两个占位符重复认领", () => {
			const result = backfillFoldedPastePlaceholdersFromPasteLedger({
				inputBoxText: "[Pasted text #1 +3 lines] [Pasted text #2 +3 lines]",
				pasteLedger: [createLedgerEntry({ payloadText: "a\nb\nc\nd" })],
			});
			expect(result.text).toBe("a\nb\nc\nd [Pasted text #2 +3 lines]");
			expect(result.backfilledPlaceholderCount).toBe(1);
			expect(result.placeholdersLeftUnbackfilledBecauseNoLedgerEntryMatched).toBe(1);
		});
	});

	describe("整框自洽性校验没过就整框不猜（用户手打的同形字面量）", () => {
		it("手打字面量抢在真占位符前面时，绝不能把正文静默调换", () => {
			// 用户先手打了一段与占位符同形的字面量（`#99`），随后才真实粘贴出 4 行、被 TUI 折叠成 `#1`。
			// 只按顺序配对时，前面那段手打字面量会先抢走唯一的账本条目（lineCount 4 与 `+3 lines` 一致）
			// 被替换成粘贴原文，真正的占位符反而配不上——用户写的字被换成了另一段文字。
			// `#N` 序列 99、1 不是严格递增，足以证明其中混进了不是 TUI 折叠出来的东西。
			const result = backfillFoldedPastePlaceholdersFromPasteLedger({
				inputBoxText: "我手打的 [Pasted text #99 +3 lines] 然后真粘贴 [Pasted text #1 +3 lines]",
				pasteLedger: [createLedgerEntry({ payloadText: "甲\n乙\n丙\n丁" })],
			});
			expect(result.text).toBe("我手打的 [Pasted text #99 +3 lines] 然后真粘贴 [Pasted text #1 +3 lines]");
			expect(result.backfilledPlaceholderCount).toBe(0);
			expect(result.placeholdersLeftUnbackfilledBecausePlaceholderSelfConsistencyCheckFailed).toBe(2);
			expect(result.placeholdersLeftUnbackfilledBecauseNoLedgerEntryMatched).toBe(0);
			expect(result.placeholdersLeftUnbackfilledBecausePayloadWasDropped).toBe(0);
		});

		it("`+M lines` 的 M < 3 不可能是折叠出来的，不认它、也不让它认走未折叠的短粘贴", () => {
			// TUI 不折叠 ≤3 行的粘贴，所以真占位符的 M 恒 >= 3。这里框里只有一段手打字面量（`+1 lines`），
			// 账本里那条 2 行粘贴的原文本就完整留在框里；没有这条形态校验，它会被字面量整段认领，
			// 而且两个 unbackfilled 计数都是 0——一次零告警的静默调换。
			const result = backfillFoldedPastePlaceholdersFromPasteLedger({
				inputBoxText: "手打的 [Pasted text #7 +1 lines] 就是普通正文",
				pasteLedger: [createLedgerEntry({ payloadText: "短\n粘贴" })],
			});
			expect(result.text).toBe("手打的 [Pasted text #7 +1 lines] 就是普通正文");
			expect(result.backfilledPlaceholderCount).toBe(0);
			expect(result.placeholdersLeftUnbackfilledBecausePlaceholderSelfConsistencyCheckFailed).toBe(1);
			expect(result.placeholdersLeftUnbackfilledBecauseNoLedgerEntryMatched).toBe(0);
		});

		it("`#N` 在框里倒序（用户把光标移回前面又粘了一次）时不互换两段载荷，整框放弃", () => {
			// 框内顺序 == 账本顺序 是顺序配对的前提。序号倒序说明后粘的那段插在了前面，前提已经不成立，
			// 继续按顺序配就是把两段粘贴原文互换位置。
			const result = backfillFoldedPastePlaceholdersFromPasteLedger({
				inputBoxText: "[Pasted text #6 +3 lines] 和 [Pasted text #5 +4 lines]",
				pasteLedger: [
					createLedgerEntry({ payloadText: "a\nb\nc\nd" }),
					createLedgerEntry({ payloadText: "e\nf\ng\nh\ni", pasteOrdinalWithinCurrentComposition: 2 }),
				],
			});
			expect(result.text).toBe("[Pasted text #6 +3 lines] 和 [Pasted text #5 +4 lines]");
			expect(result.backfilledPlaceholderCount).toBe(0);
			expect(result.placeholdersLeftUnbackfilledBecausePlaceholderSelfConsistencyCheckFailed).toBe(2);
		});

		it("序号严格递增、形态也说得通时照常回填（校验不该误伤正常路径）", () => {
			const result = backfillFoldedPastePlaceholdersFromPasteLedger({
				inputBoxText: "[Pasted text #5 +3 lines] 和 [Pasted text #6 +4 lines]",
				pasteLedger: [
					createLedgerEntry({ payloadText: "a\nb\nc\nd" }),
					createLedgerEntry({ payloadText: "e\nf\ng\nh\ni", pasteOrdinalWithinCurrentComposition: 2 }),
				],
			});
			expect(result.text).toBe("a\nb\nc\nd 和 e\nf\ng\nh\ni");
			expect(result.backfilledPlaceholderCount).toBe(2);
			expect(result.placeholdersLeftUnbackfilledBecausePlaceholderSelfConsistencyCheckFailed).toBe(0);
		});
	});

	it("多次调用之间不残留正则游标（模块级 /g 正则的经典陷阱）", () => {
		const args = {
			inputBoxText: "[Pasted text #1 +3 lines]",
			pasteLedger: [createLedgerEntry({ payloadText: "a\nb\nc\nd" })],
		};
		expect(backfillFoldedPastePlaceholdersFromPasteLedger(args).backfilledPlaceholderCount).toBe(1);
		expect(backfillFoldedPastePlaceholdersFromPasteLedger(args).backfilledPlaceholderCount).toBe(1);
	});
});
