import { afterEach, describe, expect, it, vi } from "vitest";

import {
	CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR,
	measureTerminalDisplayColumnWidth,
	readTerminalInputBox,
} from "../../../src/terminal/terminal-input-box-reader";
import { TerminalStateMirror } from "../../../src/terminal/terminal-state-mirror";

const mirrors: TerminalStateMirror[] = [];

function createMirror(cols = 80, rows = 24): TerminalStateMirror {
	const mirror = new TerminalStateMirror(cols, rows);
	mirrors.push(mirror);
	return mirror;
}

afterEach(() => {
	while (mirrors.length > 0) {
		mirrors.pop()?.dispose();
	}
});

describe("TerminalStateMirror", () => {
	it("serializes inline terminal content and dimensions", async () => {
		const mirror = createMirror(100, 30);

		mirror.applyOutput(Buffer.from("hello\r\nworld", "utf8"));

		const snapshot = await mirror.getSnapshot();

		expect(snapshot.cols).toBe(100);
		expect(snapshot.rows).toBe(30);
		expect(snapshot.snapshot).toContain("hello");
		expect(snapshot.snapshot).toContain("world");
	});

	it("preserves more than the previous 10k-line scrollback limit", async () => {
		const mirror = createMirror(100, 30);
		const lines = Array.from({ length: 10_050 }, (_, index) => `line-${String(index + 1).padStart(5, "0")}`);

		mirror.applyOutput(Buffer.from(lines.join("\r\n"), "utf8"));

		const snapshot = await mirror.getSnapshot();

		expect(snapshot.snapshot).toContain("line-00001");
		expect(snapshot.snapshot).toContain("line-10050");
	});

	it("honors CSI 3 J (erase scrollback) so an inline clear+reprint replaces history instead of stacking it", async () => {
		// Codex (inline / --no-alt-screen) re-renders by erasing scrollback + screen and reprinting the
		// whole transcript. The mirror must honor CSI 3 J; otherwise its scrollback only grows and every
		// restore replays a stale, duplicated history. (session-manager stops suppressing 3 J for Codex.)
		const mirror = createMirror(80, 5);
		const esc = String.fromCharCode(0x1b);

		// Tall transcript: most of it scrolls off the 5-row viewport into scrollback.
		const oldLines = Array.from({ length: 30 }, (_, index) => `old-line-${String(index + 1).padStart(3, "0")}`);
		mirror.applyOutput(Buffer.from(oldLines.join("\r\n"), "utf8"));

		// Erase scrollback (3 J) + erase screen (2 J) + home, then reprint.
		mirror.applyOutput(Buffer.from(`${esc}[3J${esc}[2J${esc}[Hreprinted-transcript`, "utf8"));

		const snapshot = await mirror.getSnapshot();

		expect(snapshot.snapshot).toContain("reprinted-transcript");
		expect(snapshot.snapshot).not.toContain("old-line-001");
		expect(snapshot.snapshot).not.toContain("old-line-030");
	});

	it("preserves alternate-screen state when the active buffer is alternate", async () => {
		const mirror = createMirror();

		mirror.applyOutput(Buffer.from("\u001b[?1049h\u001b[Hfullscreen", "utf8"));

		const snapshot = await mirror.getSnapshot();

		expect(snapshot.snapshot).toContain("\u001b[?1049h");
		expect(snapshot.snapshot).toContain("fullscreen");
	});

	// 读框接缝：镜像交出的行 + 软折行标记，必须能被 terminal-input-box-reader 直接消费。
	// 这条路径替代了「serialize 出带 ANSI 的字符串再用正则猜 TUI 画法」，是 W1 就绪判定的新底座。
	it("exposes buffer lines that terminal-input-box-reader can parse into the input box content", async () => {
		const mirror = createMirror(100, 30);
		const boundary = "─".repeat(100);
		// 真机形态：横线 / `❯` + U+00A0 + 内容 / 横线，框下面还有状态行。
		mirror.applyOutput(
			Buffer.from(
				["banner", boundary, "❯ typed-but-not-submitted", boundary, "  ⏸ manual mode on"].join("\r\n"),
				"utf8",
			),
		);

		const screenSnapshot = await mirror.getScreenSnapshot();
		const reading = readTerminalInputBox(screenSnapshot, CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR);

		expect(screenSnapshot.columnCount).toBe(100);
		expect(reading?.text).toBe("typed-but-not-submitted");
	});

	// 宽字符走真 xterm buffer 才看得出问题：48 个中文字占满 96 列，但 translateToString 交出来的
	// 字符串只有 48 个码元（宽字符的第二个单元格宽度为 0、不产出字符）。按码元数判「写满」会漏判，
	// 于是自折出来的续行被误当作硬换行，还原出的文本凭空多出一个换行 —— 静默的数据损坏。
	it("还原被中文写满整行后自折的输入时不凭空多出换行", async () => {
		const mirror = createMirror(100, 30);
		const boundary = "─".repeat(100);
		const chineseFullRow = "中".repeat(48);

		mirror.applyOutput(
			Buffer.from(["banner", boundary, `❯ ${chineseFullRow}`, "  尾巴", boundary].join("\r\n"), "utf8"),
		);

		const screenSnapshot = await mirror.getScreenSnapshot();
		const reading = readTerminalInputBox(screenSnapshot, CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR);

		// 真 buffer 行确实只交出 48 个中文码元（宽字符的第二个单元格宽度为 0、不产出字符），
		// 而它占满了 96 列 —— 「码元数 ≠ 显示列宽」在此坐实。
		const rawContentRow = screenSnapshot.lines[2].text
			.replace(CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR.promptPrefixPattern, "")
			.replace(/\s+$/u, "");
		expect(rawContentRow).toHaveLength(48);
		expect(measureTerminalDisplayColumnWidth(rawContentRow)).toBe(96);
		expect(reading?.logicalLines).toEqual([`${chineseFullRow}尾巴`]);
		expect(reading?.text).not.toContain("\n");
	});

	it("reports an empty input box as empty text rather than a bare prompt glyph", async () => {
		const mirror = createMirror(100, 30);
		const boundary = "─".repeat(100);

		mirror.applyOutput(Buffer.from(["banner", boundary, "❯ ", boundary].join("\r\n"), "utf8"));

		const reading = readTerminalInputBox(await mirror.getScreenSnapshot(), CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR);

		expect(reading).not.toBeNull();
		expect(reading?.text).toBe("");
	});

	it("applies queued resizes before generating a snapshot", async () => {
		const mirror = createMirror(80, 24);

		mirror.applyOutput(Buffer.from("before resize", "utf8"));
		mirror.resize(120, 40);
		mirror.applyOutput(Buffer.from("\r\nafter resize", "utf8"));

		const snapshot = await mirror.getSnapshot();

		expect(snapshot.cols).toBe(120);
		expect(snapshot.rows).toBe(40);
		expect(snapshot.snapshot).toContain("after resize");
	});

	// dirty-flag 缓存：同一份 snapshot 对象被复用即证明未重跑同步序列化（返回同一引用 ⇔ 命中缓存）。
	it("reuses the cached snapshot object when no output arrived since the last snapshot", async () => {
		const mirror = createMirror(100, 30);

		mirror.applyOutput(Buffer.from("stable content", "utf8"));

		const first = await mirror.getSnapshot();
		const second = await mirror.getSnapshot();

		expect(second).toBe(first);
		expect(second.snapshot).toContain("stable content");
	});

	it("recomputes the snapshot after new output arrives", async () => {
		const mirror = createMirror(100, 30);

		mirror.applyOutput(Buffer.from("first line", "utf8"));
		const first = await mirror.getSnapshot();

		mirror.applyOutput(Buffer.from("\r\nsecond line", "utf8"));
		const second = await mirror.getSnapshot();

		expect(second).not.toBe(first);
		expect(second.snapshot).toContain("second line");
	});

	it("recomputes the snapshot after a resize changes dimensions", async () => {
		const mirror = createMirror(80, 24);

		mirror.applyOutput(Buffer.from("content", "utf8"));
		const first = await mirror.getSnapshot();

		mirror.resize(120, 40);
		const second = await mirror.getSnapshot();

		expect(second).not.toBe(first);
		expect(second.cols).toBe(120);
		expect(second.rows).toBe(40);
	});

	it("emits terminal query responses through the optional callback", async () => {
		const onInputResponse = vi.fn();
		const mirror = new TerminalStateMirror(80, 24, {
			onInputResponse,
		});
		mirrors.push(mirror);

		mirror.applyOutput(Buffer.from("\u001b[6n", "utf8"));
		await mirror.getSnapshot();

		expect(onInputResponse).toHaveBeenCalledWith("\u001b[1;1R");
	});

	describe("getViewportSnapshot（活动屏快照：就绪判定用，不付 2 万行 scrollback 序列化成本）", () => {
		it("only contains the active screen and excludes scrolled-off history", async () => {
			const mirror = createMirror(80, 5);
			// 30 行灌进 5 行视口：前 25 行进 scrollback，末尾若干行留在活动屏。
			const lines = Array.from({ length: 30 }, (_, index) => `history-line-${String(index + 1).padStart(3, "0")}`);
			mirror.applyOutput(Buffer.from(lines.join("\r\n"), "utf8"));

			const viewportSnapshot = await mirror.getViewportSnapshot();
			const fullSnapshot = await mirror.getSnapshot();

			// 活动屏尾行两者都有；滚出视口的历史只在全量快照里。
			expect(viewportSnapshot.snapshot).toContain("history-line-030");
			expect(viewportSnapshot.snapshot).not.toContain("history-line-001");
			expect(fullSnapshot.snapshot).toContain("history-line-001");
			expect(viewportSnapshot.cols).toBe(80);
			expect(viewportSnapshot.rows).toBe(5);
		});

		it("applies queued writes and resizes before generating a viewport snapshot", async () => {
			const mirror = createMirror(80, 24);

			mirror.applyOutput(Buffer.from("before resize", "utf8"));
			mirror.resize(120, 40);
			mirror.applyOutput(Buffer.from("\r\nviewport content after resize", "utf8"));

			const snapshot = await mirror.getViewportSnapshot();

			expect(snapshot.cols).toBe(120);
			expect(snapshot.rows).toBe(40);
			expect(snapshot.snapshot).toContain("viewport content after resize");
		});

		it("matches the tail of the full snapshot for prompt-readiness style consumers", async () => {
			// 就绪判定语义等价性：现状管线是「全量 serialize 后取最后 rows 行」，viewport 快照
			// 就是活动屏——两者对「最后一屏内容」的呈现应一致（此处用包含关系断言核心内容行，
			// 避免依赖 serialize 对空行/光标位置的边缘格式差）。
			const mirror = createMirror(80, 6);
			const promptFrame = "╭──────────────╮\r\n│ > │\r\n╰──────────────╯";
			mirror.applyOutput(Buffer.from(`some earlier output\r\n${promptFrame}`, "utf8"));

			const viewportSnapshot = await mirror.getViewportSnapshot();
			const fullSnapshot = await mirror.getSnapshot();

			for (const promptLine of ["│ > │", "╭──────────────╮", "╰──────────────╯"]) {
				expect(viewportSnapshot.snapshot).toContain(promptLine);
				expect(fullSnapshot.snapshot).toContain(promptLine);
			}
		});
	});
});
