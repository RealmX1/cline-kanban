// Claude TUI 输入框语法的**真机**漂移哨兵。
//
//   npx tsx scripts/claude-terminal-input-box-grammar-drift-probe.ts
//
// ## 为什么必须是真机、且必须固化进仓
//
// W1（终端投递诚实化）与 W2（Ctrl+S 暂存入库）的正确性整个压在一个仓库自己无法验证的假设上：
// 「Claude 的输入框长这样、粘贴按这些阈值折叠」。仓内单测全部喂的是手工构造的屏幕快照——它们钉住的是
// `terminal-input-box-reader.ts` 对**我们以为的**语法的解析，一旦 Claude 换了渲染，单测照样全绿，而
// 线上会静默退化成：读框读不到 → 抢占读不出正文 → 投递永远挂起（那正是 2026-08-08 那次 49 分钟事故的
// 形态）。这个探针是唯一能发现「假设本身过期了」的东西。
//
// 上一轮调查用的四个探针只写在临时目录里，随之丢失。这份是它们的合并与入仓版本。
//
// ## 零 API 调用
//
// 探针**从不提交任何消息**：只启动 claude、观察空框渲染、灌 bracketed paste 看折叠、然后 Ctrl+C 清框。
// 全程不按回车，因此不产生任何一次模型调用。（也正因为不提交，paste-cache 那一项才测得出来——见下。）
//
// ## 不进 CI
//
// 它要求本机装有 claude 且已登录，且依赖真实 TUI 的渲染时序。手动跑：改动读框语法之后、或 Claude 大版本
// 升级之后。任何一项 FAIL 都意味着 `CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR` 或折叠阈值的知识已经过期。

import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import * as pty from "node-pty";

import {
	CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR,
	locateTerminalInputBox,
	readTerminalInputBox,
} from "../src/terminal/terminal-input-box-reader";
import { TerminalStateMirror } from "../src/terminal/terminal-state-mirror";

const TERMINAL_COLUMN_COUNT = 100;
const TERMINAL_ROW_COUNT = 30;
const BRACKETED_PASTE_START = "[200~";
const BRACKETED_PASTE_END = "[201~";
const CLEAR_INPUT_BOX_KEY = ""; // Ctrl+C：Ctrl+U 是 kill-line，清不掉整框。
const PASTE_CACHE_DIRECTORY = join(homedir(), ".claude", "paste-cache");

interface ProbeCheck {
	name: string;
	expectation: string;
	observed: string;
	passed: boolean;
}

const checks: ProbeCheck[] = [];

function recordCheck(name: string, expectation: string, observed: string, passed: boolean): void {
	checks.push({ name, expectation, observed, passed });
	process.stdout.write(`${passed ? "  ok  " : " FAIL "} ${name}\n`);
	if (!passed) {
		process.stdout.write(`        期望：${expectation}\n        实测：${observed}\n`);
	}
}

function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function countPasteCacheFiles(): number {
	return existsSync(PASTE_CACHE_DIRECTORY) ? readdirSync(PASTE_CACHE_DIRECTORY).length : 0;
}

async function main(): Promise<void> {
	// 在空的临时目录里跑：避免 claude 读到用户真实项目的 CLAUDE.md / 历史会话，那会改变首屏渲染。
	const probeWorkingDirectory = mkdtempSync(join(tmpdir(), "kanban-claude-tui-drift-probe-"));
	const mirror = new TerminalStateMirror(TERMINAL_COLUMN_COUNT, TERMINAL_ROW_COUNT);
	const session = pty.spawn("claude", [], {
		name: "xterm-256color",
		cols: TERMINAL_COLUMN_COUNT,
		rows: TERMINAL_ROW_COUNT,
		cwd: probeWorkingDirectory,
		env: { ...process.env },
	});
	session.onData((data) => {
		mirror.applyOutput(Buffer.from(data, "utf8"));
	});

	const readInputBoxAfterSettling = async (settleMilliseconds = 1_200): Promise<string | null> => {
		await sleep(settleMilliseconds);
		const snapshot = await mirror.getScreenSnapshot();
		return readTerminalInputBox(snapshot, CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR)?.text ?? null;
	};

	// 首屏不是输入框：全新目录里 claude 先弹一页「Quick safety check … trust this folder」，选完才进 TUI。
	// 这一页本身也是 U+2500 边界 + `❯` 选项行，只是没有输入框，所以 locateTerminalInputBox 恒不命中——
	// 探针必须先把它答掉，否则报出来的会是一句假的「语法已漂移」。
	//
	// 只在真的认出这一页时才发回车，不盲发：万一哪天它不再出现，一次盲发回车就是**提交**（空框提交虽是
	// no-op，但探针的零 API 调用承诺不该建立在「碰巧框是空的」上）。
	const answerWorkspaceTrustPromptIfPresent = async (): Promise<boolean> => {
		const snapshot = await mirror.getScreenSnapshot();
		const screenText = snapshot.lines.map((line) => line.text).join("\n");
		if (!/trust this folder/iu.test(screenText)) {
			return false;
		}
		session.write("\r");
		return true;
	};

	// 等到输入框真的出现为止，而不是赌一个固定的 sleep：claude 首屏耗时受更新检查、信任页、机器负载
	// 影响，写死等待会让探针在慢机器上报出假漂移。
	const waitForInputBoxToRender = async (timeoutMilliseconds: number): Promise<boolean> => {
		const deadline = Date.now() + timeoutMilliseconds;
		let hasAnsweredTrustPrompt = false;
		while (Date.now() < deadline) {
			const snapshot = await mirror.getScreenSnapshot();
			if (locateTerminalInputBox(snapshot, CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR)) {
				return true;
			}
			if (!hasAnsweredTrustPrompt) {
				hasAnsweredTrustPrompt = await answerWorkspaceTrustPromptIfPresent();
			}
			await sleep(500);
		}
		return false;
	};

	const pasteAndReadBack = async (payload: string): Promise<string | null> => {
		session.write(CLEAR_INPUT_BOX_KEY);
		await sleep(400);
		session.write(`${BRACKETED_PASTE_START}${payload}${BRACKETED_PASTE_END}`);
		return await readInputBoxAfterSettling();
	};

	try {
		// ── 1. 输入框渲染本身 ────────────────────────────────────────────────
		// 这一项是所有其余项的前提：定位不到框，读框、抢占让路判据、W2 暂存全部当场失效。
		await waitForInputBoxToRender(60_000);
		const startupSnapshot = await mirror.getScreenSnapshot();
		const startupLocation = locateTerminalInputBox(startupSnapshot, CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR);
		recordCheck(
			"输入框可被现行语法定位",
			"locateTerminalInputBox 命中一对边界行、且中间夹着提示符行",
			startupLocation
				? `命中 lines[${startupLocation.topBoundaryLineIndex}..${startupLocation.bottomBoundaryLineIndex}]`
				: "未命中（语法已漂移：读框、W1 让路判据、W2 暂存全部会静默失效）",
			startupLocation !== null,
		);
		if (startupLocation) {
			const promptLine = startupSnapshot.lines[startupLocation.topBoundaryLineIndex + 1]?.text ?? "";
			recordCheck(
				"提示符仍是 U+276F + U+00A0",
				"框内首行以 ❯(U+276F) 开头，紧跟一个 U+00A0（**不是**普通空格）",
				`首行前两个码点：${[...promptLine.slice(0, 2)].map((c) => `U+${c.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0")}`).join(" ")}`,
				/^❯ /u.test(promptLine),
			);
			const boundaryLine = startupSnapshot.lines[startupLocation.topBoundaryLineIndex]?.text.trim() ?? "";
			recordCheck(
				"边界行仍是整行 U+2500、无 ╭╰ 框线",
				"边界行只由 ─(U+2500) 构成",
				`边界行样本：${JSON.stringify(boundaryLine.slice(0, 12))}`,
				boundaryLine.length > 0 && [...boundaryLine].every((character) => character === "─"),
			);
		}

		// ── 2. 粘贴折叠阈值 ────────────────────────────────────────────────
		// W2 的占位符回填整个建立在「什么时候会折叠」上：阈值一变，回填要么白做，要么把不该配对的
		// 占位符配上账本条目。
		const threeLinePaste = ["折叠阈值探针 A1", "折叠阈值探针 A2", "折叠阈值探针 A3"].join("\n");
		const threeLineReadBack = await pasteAndReadBack(threeLinePaste);
		recordCheck(
			"粘贴 3 行不折叠",
			"框内出现原文（≤3 行不折叠）",
			threeLineReadBack === null ? "读框失败" : JSON.stringify(threeLineReadBack.slice(0, 60)),
			threeLineReadBack !== null && threeLineReadBack.includes("折叠阈值探针 A3"),
		);

		const fiveLinePaste = ["B1", "B2", "B3", "B4", "B5"].join("\n");
		const fiveLineReadBack = await pasteAndReadBack(fiveLinePaste);
		recordCheck(
			"粘贴 5 行折叠成 [Pasted text #N +4 lines]",
			"占位符形如 [Pasted text #N +M lines]，且 M = 行数 − 1 = 4",
			fiveLineReadBack === null ? "读框失败" : JSON.stringify(fiveLineReadBack.slice(0, 60)),
			fiveLineReadBack !== null && /\[Pasted text #\d+ \+4 lines\]/u.test(fiveLineReadBack),
		);

		const shortSingleLineReadBack = await pasteAndReadBack("C".repeat(420));
		recordCheck(
			"粘贴单行 420 字符不折叠",
			"框内出现原文（单行 ≤420 字符不折叠）",
			shortSingleLineReadBack === null ? "读框失败" : `读回 ${shortSingleLineReadBack.length} 字符`,
			shortSingleLineReadBack !== null && shortSingleLineReadBack.includes("C".repeat(200)),
		);

		const longSingleLineReadBack = await pasteAndReadBack("D".repeat(900));
		recordCheck(
			"粘贴单行 900 字符折叠成 [Pasted text #N]（无 lines 后缀）",
			"占位符形如 [Pasted text #N]，不带 +M lines",
			longSingleLineReadBack === null ? "读框失败" : JSON.stringify(longSingleLineReadBack.slice(0, 60)),
			longSingleLineReadBack !== null && /\[Pasted text #\d+\]/u.test(longSingleLineReadBack),
		);

		// ── 3. paste-cache 写盘时机 ────────────────────────────────────────
		// 这是一条**否定结论**的哨兵：`~/.claude/paste-cache/` 只在消息被提交时才写盘，未提交的粘贴
		// 在磁盘上根本不存在。它一旦变成「粘贴即落盘」，就出现了一条比读屏零失真得多的取回路线，
		// W2 的整个占位符回填机制都该重做——所以这一项「失败」是好消息，不是坏消息。
		const pasteCacheFileCountBefore = countPasteCacheFiles();
		await pasteAndReadBack(["E1", "E2", "E3", "E4", "E5", "E6"].join("\n"));
		const pasteCacheFileCountAfter = countPasteCacheFiles();
		recordCheck(
			"未提交的粘贴不落 paste-cache",
			"粘贴后 ~/.claude/paste-cache/ 文件数不变（只在提交时才写盘）",
			`${pasteCacheFileCountBefore} → ${pasteCacheFileCountAfter}`,
			pasteCacheFileCountAfter === pasteCacheFileCountBefore,
		);

		session.write(CLEAR_INPUT_BOX_KEY);
		await sleep(300);
	} finally {
		session.kill();
	}

	const failedChecks = checks.filter((check) => !check.passed);
	process.stdout.write(`\n${checks.length - failedChecks.length}/${checks.length} 项符合现行语法假设\n`);
	if (failedChecks.length > 0) {
		process.stdout.write(
			"\n有项目漂移了。先确认 CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR\n" +
				"（src/terminal/terminal-input-box-reader.ts）与折叠阈值的注释是否还成立，再改代码——\n" +
				"仓内单测喂的是手工构造的快照，它们全绿并不代表线上还能读到框。\n",
		);
		process.exitCode = 1;
	}
}

await main();
