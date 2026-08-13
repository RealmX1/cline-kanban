// W2 Ctrl+S 暂存的**端到端**验证：真 PTY → 真 xterm-headless 镜像 → 真读框 → 真粘贴账本回填 →
// 真 Prompt Library 文件 → 真清框。这条链上只有「Claude 本体」是替身。
//
// 为什么值得单独跑真链路：判空、软折行合并、占位符回填这三件事各自都有纯函数单测，但它们真正的
// 风险在接缝上——bracketed paste 的字节要原样穿过 writeInput 进账本、同一段字节又要经 PTY 回到镜像
// 画成占位符、两边再按顺序配回去。任何一处的编码 / 时序假设错了，单测都照样绿。
//
// 替身是一个**合成 Claude TUI**：按实测语法画输入框（U+2500 边界行 + U+276F + U+00A0 提示符），
// 按实测阈值把 ≥4 行的粘贴折叠成 `[Pasted text #N +M lines]`，收到 Ctrl+S(DC3) 就清空重画。
// 它刻意不是「真的 Claude」——真机语法漂移由可手动跑的探针脚本负责盯，这里盯的是接缝。

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimeHomeMocks = vi.hoisted(() => ({ runtimeHomePath: "" }));

// 只改「kanban 家目录在哪」，其余符号一律透传：Prompt Library 落盘路径必须离开开发者真实的
// ~/.cline/kanban，否则这个测试会在用户的真库上取锁写文件。
vi.mock("../../src/state/workspace-state", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../src/state/workspace-state")>();
	return {
		...original,
		getRuntimeHomePath: () => runtimeHomeMocks.runtimeHomePath,
		getWorkspaceDirectoryPath: (workspaceId: string) =>
			join(runtimeHomeMocks.runtimeHomePath, "workspaces", workspaceId),
	};
});

const prepareAgentLaunchMock = vi.hoisted(() => vi.fn());

// 透传：以 agentId "claude" 走完整的 agent 会话分析管线（读框语法按 claude 解析），
// 但实际 spawn 的是下面那个合成 TUI 脚本。PtySession / TerminalStateMirror 都是真实现。
vi.mock("../../src/terminal/agent-session-adapters.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../src/terminal/agent-session-adapters.js")>();
	return {
		...original,
		prepareAgentLaunch: prepareAgentLaunchMock,
	};
});

import { mutateWorkspacePromptLibrary, readWorkspacePromptLibrarySnapshot } from "../../src/state/prompt-library-store";
import { TerminalSessionManager } from "../../src/terminal/session-manager";

const TASK_ID = "task-terminal-input-box-stash";
const WORKSPACE_ID = "workspace-terminal-input-box-stash";
const SESSION_COLUMN_COUNT = 100;
const ESCAPE = "\u001b";
const CARRIAGE_RETURN = "\u000d";
const BRACKETED_PASTE_START_MARKER = `${ESCAPE}[200~`;
const BRACKETED_PASTE_END_MARKER = `${ESCAPE}[201~`;

// 合成 Claude TUI。控制字符一律用 String.fromCharCode 造，避免在模板串里做多层反斜杠转义
// （那正是「注释里写着 \r、实际写进去的是别的字节」这类事故的温床）。
const SYNTHETIC_CLAUDE_TUI_SCRIPT_SOURCE = `
const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const DEVICE_CONTROL_3 = String.fromCharCode(19);
const BOX_BOUNDARY_LINE = String.fromCharCode(0x2500).repeat(60);
const PROMPT_PREFIX = String.fromCharCode(0x276f) + String.fromCharCode(0x00a0);
const PASTE_START = ESC + "[200~";
const PASTE_END = ESC + "[201~";

let composition = "";
let foldedPasteOrdinal = 0;
let pendingInput = "";
let insidePaste = false;
let pasteBuffer = "";

function redraw() {
	process.stdout.write(ESC + "[2J" + ESC + "[H");
	process.stdout.write(BOX_BOUNDARY_LINE + CR + LF);
	process.stdout.write(PROMPT_PREFIX + composition + CR + LF);
	process.stdout.write(BOX_BOUNDARY_LINE + CR + LF);
}

function appendPasteToComposition(payload) {
	const lineCount = payload.split(CR).length;
	// 实测折叠阈值：>= 4 行折叠成带行数后缀的占位符；单行 >= 820 字符折叠成无行数后缀的占位符。
	if (lineCount >= 4) {
		foldedPasteOrdinal += 1;
		composition += "[Pasted text #" + foldedPasteOrdinal + " +" + (lineCount - 1) + " lines]";
		return;
	}
	if (payload.length >= 820) {
		foldedPasteOrdinal += 1;
		composition += "[Pasted text #" + foldedPasteOrdinal + "]";
		return;
	}
	composition += payload;
}

// 标记可能被 PTY 切在 chunk 边界上，尾部的真前缀要留到下一块再判。
function measureTrailingPartialMarkerLength(text, marker) {
	for (let length = Math.min(marker.length - 1, text.length); length >= 1; length -= 1) {
		if (text.endsWith(marker.slice(0, length))) {
			return length;
		}
	}
	return 0;
}

function consume(text) {
	pendingInput += text;
	while (pendingInput.length > 0) {
		if (insidePaste) {
			const endMarkerIndex = pendingInput.indexOf(PASTE_END);
			if (endMarkerIndex === -1) {
				const heldBackLength = measureTrailingPartialMarkerLength(pendingInput, PASTE_END);
				pasteBuffer += pendingInput.slice(0, pendingInput.length - heldBackLength);
				pendingInput = pendingInput.slice(pendingInput.length - heldBackLength);
				return;
			}
			pasteBuffer += pendingInput.slice(0, endMarkerIndex);
			appendPasteToComposition(pasteBuffer);
			pasteBuffer = "";
			insidePaste = false;
			pendingInput = pendingInput.slice(endMarkerIndex + PASTE_END.length);
			continue;
		}
		const startMarkerIndex = pendingInput.indexOf(PASTE_START);
		if (startMarkerIndex === 0) {
			insidePaste = true;
			pendingInput = pendingInput.slice(PASTE_START.length);
			continue;
		}
		const plainTextEndIndex =
			startMarkerIndex === -1
				? pendingInput.length - measureTrailingPartialMarkerLength(pendingInput, PASTE_START)
				: startMarkerIndex;
		if (plainTextEndIndex <= 0) {
			return;
		}
		const plainText = pendingInput.slice(0, plainTextEndIndex);
		pendingInput = pendingInput.slice(plainTextEndIndex);
		for (const character of plainText) {
			// CR 提交、DC3 暂存，两者都把框清空——正是运行时侧判空所依赖的语义。
			if (character === CR || character === DEVICE_CONTROL_3) {
				composition = "";
				continue;
			}
			composition += character;
		}
	}
}

// 关掉行规程回显与行缓冲：真 TUI 都这么做，否则内核会把输入原样回显进输出流、把屏幕搅乱。
if (process.stdin.setRawMode) {
	process.stdin.setRawMode(true);
}
process.stdin.on("data", (chunk) => {
	consume(chunk.toString("utf8"));
	redraw();
});
process.stdin.resume();
redraw();
// CI 兜底自杀，防止测试异常退出后留下孤儿进程。
setTimeout(() => process.exit(0), 30000);
`;

describe("终端输入框 Ctrl+S 暂存进 Prompt Library（integration，真 PTY + 真镜像 + 真文件）", () => {
	let workDir: string;
	let manager: TerminalSessionManager;
	let receivedOutputText: string;

	beforeEach(() => {
		workDir = mkdtempSync(join(tmpdir(), "kanban-input-box-stash-"));
		runtimeHomeMocks.runtimeHomePath = mkdtempSync(join(tmpdir(), "kanban-input-box-stash-home-"));
		receivedOutputText = "";
		prepareAgentLaunchMock.mockReset();
		prepareAgentLaunchMock.mockImplementation(
			async (input: { binary: string; args: string[]; env?: Record<string, string | undefined> }) => ({
				binary: input.binary,
				args: [...input.args],
				env: input.env ?? {},
			}),
		);
		manager = new TerminalSessionManager();
	});

	afterEach(async () => {
		await manager.forceStopTaskSession(TASK_ID).catch(() => undefined);
		rmSync(workDir, { recursive: true, force: true });
		rmSync(runtimeHomeMocks.runtimeHomePath, { recursive: true, force: true });
	});

	async function waitForOutputContaining(expectedText: string, timeoutMs = 8_000): Promise<void> {
		const startedAtMs = Date.now();
		while (Date.now() - startedAtMs < timeoutMs) {
			if (receivedOutputText.includes(expectedText)) {
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		throw new Error(`未在 ${timeoutMs}ms 内等到输出包含 ${JSON.stringify(expectedText)}`);
	}

	it("粘贴被折叠成占位符后按 Ctrl+S：库里存到的是回填后的完整正文，框随即被清空", async () => {
		const scriptPath = join(workDir, "synthetic-claude-tui.cjs");
		writeFileSync(scriptPath, SYNTHETIC_CLAUDE_TUI_SCRIPT_SOURCE, "utf8");
		manager.attach(TASK_ID, {
			onOutput: (chunk) => {
				receivedOutputText += chunk.toString("utf8");
			},
		});
		await manager.startTaskSession({
			taskId: TASK_ID,
			agentId: "claude",
			binary: process.execPath,
			args: [scriptPath],
			cwd: workDir,
			prompt: "",
			cols: SESSION_COLUMN_COUNT,
			rows: 24,
		});
		// 输入框先画出来（合成 TUI 启动即 redraw 一次）。
		await waitForOutputContaining("\u276f");

		const pastedPayload = ["第一行", "第二行", "第三行", "第四行"].join(CARRIAGE_RETURN);
		manager.writeInput(
			TASK_ID,
			Buffer.from(`请看 ${BRACKETED_PASTE_START_MARKER}${pastedPayload}${BRACKETED_PASTE_END_MARKER} 结尾`, "utf8"),
		);
		// TUI 把它折叠掉了：此刻屏幕上一个字的原文都没有，原文只存在于运行时的粘贴账本里。
		await waitForOutputContaining("[Pasted text #1 +3 lines]");

		const capture = await manager.captureTaskTerminalInputBoxContentForPromptLibraryStash(TASK_ID);

		expect(capture?.status).toBe("captured_stashable_text");
		expect(capture?.text).toBe("请看 第一行\n第二行\n第三行\n第四行 结尾");
		expect(capture?.fidelity.backfilledPlaceholderCount).toBe(1);
		expect(capture?.fidelity.placeholdersLeftUnbackfilledBecauseNoLedgerEntryMatched).toBe(0);
		expect(capture?.fidelity.unrecoverablePasteCount).toBe(0);

		// 与 runtime-api 里的链路同序：先写库，再清框。
		const library = await mutateWorkspacePromptLibrary(WORKSPACE_ID, {
			kind: "upsert_prompt",
			promptId: "prompt-from-terminal-stash",
			text: capture?.text ?? "",
			scope: "task",
			taskId: TASK_ID,
			origin: "terminal_stash_by_user",
		});
		expect(library.taskScopedPromptsByTaskId[TASK_ID]).toHaveLength(1);
		// 清框认的是取文时那条 PTY incarnation：写库期间若终端被 refresh，令牌对不上就不许转发。
		expect(
			manager.forwardStashKeyToClearTaskTerminalInputBox(TASK_ID, capture?.terminalSessionIncarnationToken ?? ""),
		).toBe(true);

		// 合成 TUI 收到 DC3 会清空重画。验证「框真的空了」时**不能**只断言「读出来是空的」——
		// 读不到框（定位失败）同样会给出空字符串，那会让一个坏掉的读框冒充成功。
		// 改为清框后重新打一段字：读出来恰好只有这段新字，才同时证明「旧内容没了」与「读框仍然有效」。
		manager.writeInput(TASK_ID, Buffer.from("清空之后重新打的字", "utf8"));
		await waitForOutputContaining("清空之后重新打的字");
		const startedWaitingForClearedBoxAtMs = Date.now();
		let captureAfterClear = await manager.captureTaskTerminalInputBoxContentForPromptLibraryStash(TASK_ID);
		while (captureAfterClear?.text !== "清空之后重新打的字" && Date.now() - startedWaitingForClearedBoxAtMs < 5_000) {
			await new Promise((resolve) => setTimeout(resolve, 25));
			captureAfterClear = await manager.captureTaskTerminalInputBoxContentForPromptLibraryStash(TASK_ID);
		}
		expect(captureAfterClear?.text).toBe("清空之后重新打的字");

		// 磁盘上的那份才是真相源：重新读一遍，确认存的是回填后的正文而不是占位符。
		const persistedLibrary = await readWorkspacePromptLibrarySnapshot(WORKSPACE_ID);
		expect(persistedLibrary.taskScopedPromptsByTaskId[TASK_ID]).toEqual([
			expect.objectContaining({
				text: "请看 第一行\n第二行\n第三行\n第四行 结尾",
				scope: "task",
				origin: "terminal_stash_by_user",
			}),
		]);

		manager.stopTaskSession(TASK_ID);
	}, 30_000);
});
