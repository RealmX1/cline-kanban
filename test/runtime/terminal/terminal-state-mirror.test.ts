import { afterEach, describe, expect, it, vi } from "vitest";

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
