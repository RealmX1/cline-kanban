import { describe, expect, it } from "vitest";

import {
	CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR,
	locateTerminalInputBox,
	measureTerminalDisplayColumnWidth,
	readTerminalInputBox,
	type TerminalScreenSnapshot,
} from "../../../src/terminal/terminal-input-box-reader";

// 真机实测语法（Claude Code v2.1.227，2026-08-11，cols=100；v2.1.289 上边框可嵌 agent 名，见对应 describe）。
// 这些常数是**外部契约**，会随 Claude 版本漂移——本套件的作用是让漂移在 CI 里炸出来，
// 而不是在一次「投递躺了 49 分钟」的事故里被发现。
const COLUMN_COUNT = 100;
const BOUNDARY_LINE = "─".repeat(COLUMN_COUNT);
const PROMPT_PREFIX = "❯ "; // ❯ + NBSP（**不是**普通空格）
const CONTINUATION_INDENT = "  ";
// TUI 自折宽度 = cols - 左缩进 2 - 右留白 2。实测 392 字符单行拆成 96×4 + 8。
const CONTENT_WIDTH = COLUMN_COUNT - 4;

function screen(lines: string[], columnCount = COLUMN_COUNT): TerminalScreenSnapshot {
	return {
		lines: lines.map((text) => ({ text, isWrapped: false })),
		columnCount,
	};
}

// 真机上框外还有启动横幅与状态行，读框必须在这些噪声里正确定位。
function withSurroundingChrome(boxLines: string[]): string[] {
	return [
		" ▐▛███▜▌   Claude Code v2.1.227",
		"▝▜█████▛▘  Opus 5 (1M context)",
		"",
		...boxLines,
		"  ⚠ Transcript saving is off",
		"  ⏸ manual mode on",
	];
}

describe("locateTerminalInputBox", () => {
	it("在启动横幅与状态行之间定位到输入框", () => {
		const snapshot = screen(withSurroundingChrome([BOUNDARY_LINE, `${PROMPT_PREFIX}hello`, BOUNDARY_LINE]));

		const location = locateTerminalInputBox(snapshot, CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR);

		expect(location).not.toBeNull();
		expect(snapshot.lines[(location?.topBoundaryLineIndex ?? 0) + 1].text).toBe(`${PROMPT_PREFIX}hello`);
	});

	it("忽略 agent 输出里的装饰性横线对——只有夹着提示符行的那一对才算输入框", () => {
		const snapshot = screen([
			BOUNDARY_LINE,
			"  这是 agent 打印的表格，不是输入框",
			BOUNDARY_LINE,
			"",
			BOUNDARY_LINE,
			`${PROMPT_PREFIX}真正的输入框`,
			BOUNDARY_LINE,
		]);

		const location = locateTerminalInputBox(snapshot, CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR);

		expect(location?.topBoundaryLineIndex).toBe(4);
		expect(location?.bottomBoundaryLineIndex).toBe(6);
	});

	it("屏上没有输入框时返回 null（TUI 尚未渲染 / 被全屏输出覆盖）", () => {
		const snapshot = screen(["agent 正在输出", "还没有画出输入框"]);

		expect(locateTerminalInputBox(snapshot, CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR)).toBeNull();
	});
});

// 真机实测（Claude Code v2.1.289，2026-10-05）：会话有 agent 名时，Claude 把它嵌进输入框上边框、
// 贴右，右侧只留 1 个横线；下边框仍是整行横线。旧判据认不出这种上边框，面板答案投递因此硬失败
// （task df9d8，`terminal_input_box_still_not_visible_after_escape_key`）。
describe("上边框嵌入 agent 名的输入框（Claude Code v2.1.289）", () => {
	const LABELED_SCREEN_COLUMN_COUNT = 120;
	const LABELED_SCREEN_BOUNDARY_LINE = "─".repeat(LABELED_SCREEN_COLUMN_COUNT);

	function labeledTopBoundaryLine(agentName: string): string {
		// 两个空格 + 右侧 1 个横线占 3 列，其余都给左侧横线。
		const leadingRunLength = LABELED_SCREEN_COLUMN_COUNT - measureTerminalDisplayColumnWidth(agentName) - 3;
		return `${"─".repeat(leadingRunLength)} ${agentName} ─`;
	}

	it("df9d8 实测屏幕：定位到输入框并读出空文本", () => {
		// 逐行抄自 3484 上 df9d8 的只读快照（cols=120）。行尾的空白是 translateToString(false) 保留下来的。
		const snapshot = screen(
			[
				"  ⎿  Stop says: === REVIEW-VALIDATE-FIX HOOK ===",
				"     status=skipped",
				"",
				"✻ Worked for 1m 29s · done 1:03 PM",
				"",
				`${"─".repeat(87)} fix-load-sensitive-flaky-tests ─`,
				`❯ ${" ".repeat(LABELED_SCREEN_COLUMN_COUNT - 2)}`,
				LABELED_SCREEN_BOUNDARY_LINE,
				"  Ctx: 101.3k | ⎇ no git | Opus 5.5 xhigh | [PONYTAIL:LITE]",
				"  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents",
			],
			LABELED_SCREEN_COLUMN_COUNT,
		);

		const reading = readTerminalInputBox(snapshot, CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR);

		expect(reading?.location).toEqual({ topBoundaryLineIndex: 5, bottomBoundaryLineIndex: 7 });
		expect(reading?.text).toBe("");
	});

	it("中文 agent 名同样识别，框内文字照常读出", () => {
		const snapshot = screen(
			[labeledTopBoundaryLine("修复负载敏感的计时测试"), `${PROMPT_PREFIX}继续落地`, LABELED_SCREEN_BOUNDARY_LINE],
			LABELED_SCREEN_COLUMN_COUNT,
		);

		expect(readTerminalInputBox(snapshot, CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR)?.text).toBe("继续落地");
	});

	it("带标签的横线后面不是提示符行时不算输入框（agent 打印的小节标题）", () => {
		const snapshot = screen(
			[labeledTopBoundaryLine("小节标题"), "  agent 打印的正文", LABELED_SCREEN_BOUNDARY_LINE],
			LABELED_SCREEN_COLUMN_COUNT,
		);

		expect(locateTerminalInputBox(snapshot, CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR)).toBeNull();
	});

	// 用户在框里敲出的一行 `──── 小节标题 ─`，续行缩进剥掉后正好长成带标签的上边框。它若被当成边界
	// 候选，就会夹在真实上下边框之间、挡住相邻配对，整个框读不到（加入带标签判据后的回归）。
	// 中间与紧贴下边框两个位置各放一行，两种挡法都覆盖到。
	const CONTINUATION_CONTENT_SHAPED_LIKE_LABELED_TOP_BOUNDARY = `${"─".repeat(20)} section title ─`;
	it.each([
		["整行横线的上边框", LABELED_SCREEN_BOUNDARY_LINE],
		["嵌着 agent 名的上边框", labeledTopBoundaryLine("fix-load-sensitive-flaky-tests")],
	])("%s：框内续行长成 `── 标题 ─` 时不挡住真实边框，读出含该续行的完整文本", (_title, topBoundaryLine) => {
		const snapshot = screen(
			[
				topBoundaryLine,
				`${PROMPT_PREFIX}first`,
				`${CONTINUATION_INDENT}${CONTINUATION_CONTENT_SHAPED_LIKE_LABELED_TOP_BOUNDARY}`,
				`${CONTINUATION_INDENT}middle`,
				`${CONTINUATION_INDENT}${CONTINUATION_CONTENT_SHAPED_LIKE_LABELED_TOP_BOUNDARY}`,
				LABELED_SCREEN_BOUNDARY_LINE,
			],
			LABELED_SCREEN_COLUMN_COUNT,
		);

		const reading = readTerminalInputBox(snapshot, CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR);

		expect(reading?.location).toEqual({ topBoundaryLineIndex: 0, bottomBoundaryLineIndex: 5 });
		expect(reading?.text).toBe(
			[
				"first",
				CONTINUATION_CONTENT_SHAPED_LIKE_LABELED_TOP_BOUNDARY,
				"middle",
				CONTINUATION_CONTENT_SHAPED_LIKE_LABELED_TOP_BOUNDARY,
			].join("\n"),
		);
	});

	// 下面三条钉住「放宽面越窄越好」：误判输入框已出现，会让面板投递在提问选择器还在屏上时
	// 粘贴 + 回车，替用户选中高亮项。
	it("AskUserQuestion 选择器仍在屏上、带标签上边框留在屏底且其下无内容时不算输入框", () => {
		// 抄自隔离实例真机快照（Claude Code v2.1.289，cols=120，2026-10-05，会话经 `/rename` 起名）的屏幕下半段，
		// 选项说明行略去了尾部的 ⚖️ 立场。选择器自己有两条整行横线（顶部一条、3 与 4 之间一条）；
		// 高亮项 `❯ 1. 红色` 本身就匹配提示符前缀，所以这块屏上确实有「像提示符的行」，只是它不紧贴在
		// 任何边界行下面。输入框那条带标签的上边框此时仍留在屏幕最后一行。
		const snapshot = screen(
			[
				LABELED_SCREEN_BOUNDARY_LINE,
				" ☐ 颜色",
				"",
				"探针选哪个颜色？（本问权衡维度：醒目度 · 视觉冷暖）",
				"",
				"❯ 1. 红色",
				"     把探针的颜色设为红色，属于暖色调、警示感较强的颜色。",
				"  2. 蓝色",
				"     把探针的颜色设为蓝色，属于冷色调、观感较沉稳的颜色。",
				"  3. Type something.",
				LABELED_SCREEN_BOUNDARY_LINE,
				"  4. Chat about this",
				"",
				"Enter to select · ↑/↓ to navigate · Esc to cancel",
				labeledTopBoundaryLine("labeled-box-probe"),
			],
			LABELED_SCREEN_COLUMN_COUNT,
		);
		expect(CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR.promptPrefixPattern.test(snapshot.lines[5].text)).toBe(true);

		expect(locateTerminalInputBox(snapshot, CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR)).toBeNull();
	});

	it("只放宽上边框：下边框带标签时不算输入框", () => {
		const snapshot = screen(
			[LABELED_SCREEN_BOUNDARY_LINE, `${PROMPT_PREFIX}hello`, labeledTopBoundaryLine("some-agent-name")],
			LABELED_SCREEN_COLUMN_COUNT,
		);

		expect(locateTerminalInputBox(snapshot, CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR)).toBeNull();
	});

	it("标签两侧只认 U+2500：`╭─── 标题 ───╮` 式的对话框标题边不算上边框", () => {
		const snapshot = screen(
			[`╭${"─".repeat(20)} 对话框标题 ${"─".repeat(20)}╮`, `${PROMPT_PREFIX}hello`, LABELED_SCREEN_BOUNDARY_LINE],
			LABELED_SCREEN_COLUMN_COUNT,
		);

		expect(locateTerminalInputBox(snapshot, CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR)).toBeNull();
	});
});

describe("readTerminalInputBox", () => {
	it("空框读成空文本——提示符后是 U+00A0，不能先去尾空白把它一起吃掉", () => {
		const snapshot = screen(withSurroundingChrome([BOUNDARY_LINE, PROMPT_PREFIX, BOUNDARY_LINE]));

		const reading = readTerminalInputBox(snapshot, CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR);

		expect(reading?.text).toBe("");
		expect(reading?.logicalLines).toEqual([]);
	});

	it("剥掉首行提示符前缀与续行的 2 空格缩进", () => {
		const snapshot = screen(
			withSurroundingChrome([
				BOUNDARY_LINE,
				`${PROMPT_PREFIX}INDENTPROBE-line-1`,
				`${CONTINUATION_INDENT}INDENTPROBE-line-2`,
				`${CONTINUATION_INDENT}INDENTPROBE-line-3`,
				BOUNDARY_LINE,
			]),
		);

		const reading = readTerminalInputBox(snapshot, CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR);

		expect(reading?.logicalLines).toEqual(["INDENTPROBE-line-1", "INDENTPROBE-line-2", "INDENTPROBE-line-3"]);
		// 三行都没写满 ⇒ 全部是硬换行，一次合并都不该发生。
		expect(reading?.softWrapJoinCount).toBe(0);
	});

	it("把 TUI 自折的长行合并回一条逻辑行（isWrapped 恒 false，只能靠宽度判据）", () => {
		// 复刻真机：392 字符单行被 Claude 拆成 96/96/96/96/8 共 5 个 buffer 行。
		const original = `WRAPPROBE${"abcdefghij".repeat(38)}END`;
		expect(original).toHaveLength(392);
		const rows: string[] = [];
		for (let offset = 0; offset < original.length; offset += CONTENT_WIDTH) {
			const chunk = original.slice(offset, offset + CONTENT_WIDTH);
			rows.push(rows.length === 0 ? `${PROMPT_PREFIX}${chunk}` : `${CONTINUATION_INDENT}${chunk}`);
		}
		expect(rows).toHaveLength(5);

		const reading = readTerminalInputBox(
			screen(withSurroundingChrome([BOUNDARY_LINE, ...rows, BOUNDARY_LINE])),
			CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR,
		);

		expect(reading?.logicalLines).toEqual([original]);
		expect(reading?.softWrapJoinCount).toBe(4);
	});

	it("软折行与硬换行混排时各自归位", () => {
		const wrappedLine = "W".repeat(CONTENT_WIDTH);
		const snapshot = screen(
			withSurroundingChrome([
				BOUNDARY_LINE,
				`${PROMPT_PREFIX}${wrappedLine}`,
				`${CONTINUATION_INDENT}tail`,
				`${CONTINUATION_INDENT}second-hard-line`,
				BOUNDARY_LINE,
			]),
		);

		const reading = readTerminalInputBox(snapshot, CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR);

		expect(reading?.logicalLines).toEqual([`${wrappedLine}tail`, "second-hard-line"]);
		expect(reading?.softWrapJoinCount).toBe(1);
	});

	it("框尾预留的空行不算用户敲出来的空行", () => {
		const snapshot = screen(
			withSurroundingChrome([BOUNDARY_LINE, `${PROMPT_PREFIX}only-line`, "", "", BOUNDARY_LINE]),
		);

		expect(readTerminalInputBox(snapshot, CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR)?.logicalLines).toEqual(["only-line"]);
	});

	it("保留用户内容中间的空行", () => {
		const snapshot = screen(
			withSurroundingChrome([
				BOUNDARY_LINE,
				`${PROMPT_PREFIX}first`,
				CONTINUATION_INDENT,
				`${CONTINUATION_INDENT}third`,
				BOUNDARY_LINE,
			]),
		);

		expect(readTerminalInputBox(snapshot, CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR)?.logicalLines).toEqual([
			"first",
			"",
			"third",
		]);
	});

	it("续行缩进不符时原样收下，绝不切掉用户的字", () => {
		const snapshot = screen(
			withSurroundingChrome([BOUNDARY_LINE, `${PROMPT_PREFIX}first`, "no-indent-line", BOUNDARY_LINE]),
		);

		expect(readTerminalInputBox(snapshot, CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR)?.logicalLines).toEqual([
			"first",
			"no-indent-line",
		]);
	});

	it("提示符后是普通空格时同样识别（容忍 TUI 换掉 NBSP）", () => {
		const snapshot = screen(withSurroundingChrome([BOUNDARY_LINE, "❯ hello", BOUNDARY_LINE]));

		expect(readTerminalInputBox(snapshot, CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR)?.text).toBe("hello");
	});

	// 宽字符是这套宽度判据最容易被 ASCII 用例掩盖的盲区：本仓用户以中文为主，
	// 一个被插入假换行的暂存内容是静默的数据损坏，故单独成组守住。
	describe("宽字符（CJK / 全角）的折行判据", () => {
		it("整行中文写满内容区时合并回一条逻辑行——判据必须是显示列宽而不是 String.length", () => {
			// 48 个中文字 == 96 显示列 == 内容宽度，正好写满并触发 TUI 自折；
			// 但 String.length 只有 48，按码元数判「写满」会漏判、凭空多出一个换行。
			const chineseFullRow = "中".repeat(48);
			expect(chineseFullRow).toHaveLength(CONTENT_WIDTH / 2);
			expect(measureTerminalDisplayColumnWidth(chineseFullRow)).toBe(CONTENT_WIDTH);

			const reading = readTerminalInputBox(
				screen(
					withSurroundingChrome([
						BOUNDARY_LINE,
						`${PROMPT_PREFIX}${chineseFullRow}`,
						`${CONTINUATION_INDENT}尾巴`,
						BOUNDARY_LINE,
					]),
				),
				CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR,
			);

			expect(reading?.logicalLines).toEqual([`${chineseFullRow}尾巴`]);
			expect(reading?.softWrapJoinCount).toBe(1);
		});

		it("中英混排把行尾卡在 95 列时同样算写满——下一个中文字要 2 列，那 1 列空隙塞不下它", () => {
			const mixedFullRow = `${"中".repeat(47)}a`;
			expect(measureTerminalDisplayColumnWidth(mixedFullRow)).toBe(CONTENT_WIDTH - 1);

			const reading = readTerminalInputBox(
				screen(
					withSurroundingChrome([
						BOUNDARY_LINE,
						`${PROMPT_PREFIX}${mixedFullRow}`,
						`${CONTINUATION_INDENT}续上的中文`,
						BOUNDARY_LINE,
					]),
				),
				CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR,
			);

			expect(reading?.logicalLines).toEqual([`${mixedFullRow}续上的中文`]);
			expect(reading?.softWrapJoinCount).toBe(1);
		});

		it("中文硬换行不该被合并：短行与「还塞得下一个中文字」的行都判为硬换行", () => {
			// 94 列，右边还剩 2 列、正好还能再放一个中文字 ⇒ TUI 不会在这里自折。
			const nearlyFullChineseRow = "中".repeat(47);
			expect(measureTerminalDisplayColumnWidth(nearlyFullChineseRow)).toBe(CONTENT_WIDTH - 2);

			const reading = readTerminalInputBox(
				screen(
					withSurroundingChrome([
						BOUNDARY_LINE,
						`${PROMPT_PREFIX}第一段中文`,
						`${CONTINUATION_INDENT}${nearlyFullChineseRow}`,
						`${CONTINUATION_INDENT}第三段中文`,
						BOUNDARY_LINE,
					]),
				),
				CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR,
			);

			expect(reading?.logicalLines).toEqual(["第一段中文", nearlyFullChineseRow, "第三段中文"]);
			expect(reading?.softWrapJoinCount).toBe(0);
		});
	});

	it("终端宽度变化时折行宽度随之变化", () => {
		const narrowColumnCount = 40;
		const narrowContentWidth = narrowColumnCount - 4;
		const original = `${"N".repeat(narrowContentWidth)}tail`;

		const reading = readTerminalInputBox(
			screen(
				[
					BOUNDARY_LINE.slice(0, narrowColumnCount),
					`${PROMPT_PREFIX}${original.slice(0, narrowContentWidth)}`,
					`${CONTINUATION_INDENT}${original.slice(narrowContentWidth)}`,
					BOUNDARY_LINE.slice(0, narrowColumnCount),
				],
				narrowColumnCount,
			),
			CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR,
		);

		expect(reading?.logicalLines).toEqual([original]);
	});
});

describe("measureTerminalDisplayColumnWidth", () => {
	it.each([
		["ASCII 逐字符 1 列", "abc", 3],
		["中文一字 2 列", "中文", 4],
		["全角 ASCII 一字 2 列", "ＦＵＬＬ", 8],
		["日文假名一字 2 列", "かなカナ", 8],
		["谚文音节一字 2 列", "한글", 4],
		["中英混排按各自宽度累加", "中a文b", 6],
		["组合记号不占列（e + U+0301 显示成一个 é）", "e\u0301", 1],
		["零宽空格不占列", "a\u200Bb", 2],
		["emoji 2 列（String.length 是 2，恰好蒙对，不能因此退回按码元数）", "🚀", 2],
		["变体选择符把文字形态符号提升为 emoji 形态、宽度随之 2 列", "❤\uFE0F", 2],
		["ZWJ 拼出的 emoji 序列整串算 2 列", "👨\u200D👩\u200D👧", 2],
	])("%s", (_title, text, expectedColumnWidth) => {
		expect(measureTerminalDisplayColumnWidth(text)).toBe(expectedColumnWidth);
	});

	it("宽字符的显示列宽是 String.length 的两倍——这正是旧判据漏判「写满」的根因", () => {
		const chineseFullRow = "中".repeat(48);

		expect(chineseFullRow.length).toBe(48);
		expect(measureTerminalDisplayColumnWidth(chineseFullRow)).toBe(96);
	});
});
