// W2 Ctrl+S 暂存链路在 session-manager 里的两半：取文（只读，含折叠粘贴回填）与清框（转发 Ctrl+S）。
//
// 这里钉住的红线：
//   - 取文**绝不动框**。清框只能发生在写库成功之后，由调用方另行触发。
//   - 判空以输入侧字节跟踪为准。屏上有字但输入侧一个字节都没见过时不入库——那多半是 Claude 在空框里
//     渲染的占位提示（`Try "..."`），把 agent 的 UI 文案当用户资产存进去是纯污染。
//   - 「读不到」与「空」是两个不同的结论，不许混成一个。
//   - 读框前的镜像沉降窗要同时看**输出静默**与**人类击键静默**：用户敲完最后一个字符立刻按 Ctrl+S 时，
//     那几个字符的回显可能还没画进镜像，只看 lastOutputAt 会立即放行并读到截断文本。
//   - 清框认的是**取文时那条 PTY incarnation**，不是「此刻这个 taskId 上碰巧有个 active」。写库跨文件锁与
//     落盘，期间 refresh 会整体换掉 active；照 taskId 打过去就会清掉新会话里一段无关的输入。
//   - 同一 task 的暂存串行化落在 manager（per-workspace 长驻）而不是调用方：连按 / 多标签页并发不得让
//     同一份正文入库两次。

import { describe, expect, it, vi } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";
import { createTerminalInputBoxOccupancyTrackerState } from "../../../src/terminal/terminal-input-box-occupancy";

const BOX_COLUMN_COUNT = 60;
const BOX_BOUNDARY_LINE = "─".repeat(BOX_COLUMN_COUNT);
// 提示符是 U+276F 后跟 U+00A0（**不是**普通空格），与真机语法一致。
const INPUT_BOX_PROMPT_PREFIX = "\u276f\u00a0";
const BRACKETED_PASTE_START_MARKER = "\u001b[200~";
const BRACKETED_PASTE_END_MARKER = "\u001b[201~";
// 剪贴板换行在 bracketed paste 里以 CR 的形态到达 PTY。
const PASTED_NEWLINE = "\u000d";
const STASH_KEY_SEQUENCE = "\u0013";

// 与 session-manager 里的 TERMINAL_INPUT_BOX_STASH_MIRROR_SETTLE_QUIET_MS / _MAX_WAIT_MS 对齐（那两个
// 常量是模块私有）。用例只依赖「回显补齐时刻 < 沉降窗 < 总预算」这层关系，写成具名常量以免读成魔数。
const MIRROR_SETTLE_QUIET_WINDOW_MS = 150;
const MIRROR_SETTLE_MAX_WAIT_BUDGET_MS = 750;

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		workspacePath: "/tmp/worktree",
		pid: 1234,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		// null = 终端字节已静默：读框前的镜像沉降窗立即通过，测试不必空等 750ms 预算。
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		...overrides,
	};
}

// 镜像屏幕既可以给一份固定内容，也可以给一个「读的那一刻算」的函数——后者用来模拟「击键的回显还
// 没画进镜像、几十毫秒后才补上」这条真实时序（读框前的沉降窗正是为它存在的）。
type TerminalScreenLinesAtSnapshotTime = string[] | (() => string[]);

function injectClaudeEntryWithScreen(
	manager: TerminalSessionManager,
	screenLines: TerminalScreenLinesAtSnapshotTime,
	// 真实 manager 每次 startTaskSession 都会生成一个新令牌；用例要模拟「refresh 换了 PTY」时显式给一个
	// 不同的值即可（同一个 taskId 上再注入一次条目，就相当于换了一代）。
	terminalSessionIncarnationToken = "incarnation-1",
): {
	writeSpy: ReturnType<typeof vi.fn>;
	trackerState: ReturnType<typeof createTerminalInputBoxOccupancyTrackerState>;
} {
	const writeSpy = vi.fn();
	const trackerState = createTerminalInputBoxOccupancyTrackerState();
	const entry = {
		summary: createSummary(),
		active: {
			session: { write: writeSpy },
			awaitingCodexPromptAfterEnter: false,
			suppressSubstantiveOutputUntilContinues: false,
			lastUserInputAt: null as number | null,
			inputBoxOccupancyTracker: trackerState,
			terminalSessionIncarnationToken,
		},
		terminalStateMirror: {
			getScreenSnapshot: async () => ({
				lines: (typeof screenLines === "function" ? screenLines() : screenLines).map((text) => ({
					text,
					isWrapped: false,
				})),
				columnCount: BOX_COLUMN_COUNT,
			}),
		},
		listenerIdCounter: 1,
		listeners: new Map(),
	};
	(manager as unknown as { entries: Map<string, typeof entry> }).entries.set("task-1", entry);
	return { writeSpy, trackerState };
}

// writeInput 会把 lastUserInputAt 打成「刚刚」，而读框前的沉降窗要求人类击键也静默过窗。除了专门钉
// 这条时序的用例，其余用例关心的都不是沉降——把击键时刻直接倒推到窗口之外，免得每个用例都真等一
// 个沉降窗。
function markHumanKeystrokeSettleWindowAsAlreadyElapsed(manager: TerminalSessionManager): void {
	const entry = (
		manager as unknown as { entries: Map<string, { active: { lastUserInputAt: number | null } | null }> }
	).entries.get("task-1");
	if (entry?.active) {
		entry.active.lastUserInputAt = Date.now() - MIRROR_SETTLE_MAX_WAIT_BUDGET_MS;
	}
}

function buildInputBoxScreen(promptLineContent: string): string[] {
	return [
		"agent 之前的一些输出",
		BOX_BOUNDARY_LINE,
		`${INPUT_BOX_PROMPT_PREFIX}${promptLineContent}`,
		BOX_BOUNDARY_LINE,
	];
}

describe("captureTaskTerminalInputBoxContentForPromptLibraryStash", () => {
	it("手打文字 + 折叠占位符 → 回填成完整正文，且**不动框**", async () => {
		const manager = new TerminalSessionManager();
		const { writeSpy } = injectClaudeEntryWithScreen(
			manager,
			buildInputBoxScreen("hello [Pasted text #1 +3 lines] tail"),
		);
		const pastedPayload = ["a", "b", "c", "d"].join(PASTED_NEWLINE);
		manager.writeInput(
			"task-1",
			Buffer.from(`hello ${BRACKETED_PASTE_START_MARKER}${pastedPayload}${BRACKETED_PASTE_END_MARKER} tail`, "utf8"),
		);
		const writeCallCountAfterHumanInput = writeSpy.mock.calls.length;
		markHumanKeystrokeSettleWindowAsAlreadyElapsed(manager);

		const capture = await manager.captureTaskTerminalInputBoxContentForPromptLibraryStash("task-1");

		expect(capture?.status).toBe("captured_stashable_text");
		expect(capture?.text).toBe("hello a\nb\nc\nd tail");
		expect(capture?.fidelity.foldedPastePlaceholderCount).toBe(1);
		expect(capture?.fidelity.backfilledPlaceholderCount).toBe(1);
		expect(capture?.fidelity.unrecoverablePasteCount).toBe(0);
		// 取文是只读的：清框要等写库成功之后才发生，这里一个字节都不该写进 PTY。
		expect(writeSpy.mock.calls.length).toBe(writeCallCountAfterHumanInput);
	});

	it("屏上有字、输入侧却一个字节都没见过 → 不入库（那多半是 agent 的空框占位提示）", async () => {
		const manager = new TerminalSessionManager();
		injectClaudeEntryWithScreen(manager, buildInputBoxScreen('Try "edit session-manager.ts to..."'));

		const capture = await manager.captureTaskTerminalInputBoxContentForPromptLibraryStash("task-1");

		expect(capture?.status).toBe("screen_text_not_corroborated_by_keystroke_tracking");
		expect(capture?.text).toBe("");
	});

	it("输入侧确知有内容、读屏却定位不到框 → 报「读不到」而不是「空」", async () => {
		const manager = new TerminalSessionManager();
		injectClaudeEntryWithScreen(manager, ["agent 正在刷全屏输出", "没有任何输入框"]);
		manager.writeInput("task-1", Buffer.from("用户打了一半的字", "utf8"));
		markHumanKeystrokeSettleWindowAsAlreadyElapsed(manager);

		const capture = await manager.captureTaskTerminalInputBoxContentForPromptLibraryStash("task-1");

		expect(capture?.status).toBe("input_box_content_unreadable");
		expect(capture?.text).toBe("");
	});

	it("两路都说空 → input_box_empty，且 lastUserInputAt 为 null 不会把沉降窗空等满预算", async () => {
		const manager = new TerminalSessionManager();
		injectClaudeEntryWithScreen(manager, buildInputBoxScreen(""));
		const captureStartedAtMs = Date.now();

		const capture = await manager.captureTaskTerminalInputBoxContentForPromptLibraryStash("task-1");

		expect(capture?.status).toBe("input_box_empty");
		// 本会话还没有人手敲过（lastUserInputAt 为 null）⇒ 不存在「在路上的回显」，沉降窗必须立即放行。
		// 若把 null 当成「未静默」，空框上按一次 Ctrl+S 就要白等满整个等待预算。
		expect(Date.now() - captureStartedAtMs).toBeLessThan(MIRROR_SETTLE_MAX_WAIT_BUDGET_MS);
	});

	it("人类刚敲完、回显还没画进镜像（lastOutputAt 为 null）→ 先等沉降窗，读到的是补齐后的完整正文", async () => {
		const manager = new TerminalSessionManager();
		// 回显补齐时刻取在沉降窗**之内**：只要读框真的等过一个沉降窗，就必然读到补齐后的框；反之，
		// 若判据只看 lastOutputAt（这里是 null ⇒ 立即判静默），读到的就是缺了尾巴的 "hello"。
		const mirrorRedrawArrivesAtMs = Date.now() + MIRROR_SETTLE_QUIET_WINDOW_MS / 3;
		injectClaudeEntryWithScreen(manager, () =>
			buildInputBoxScreen(Date.now() >= mirrorRedrawArrivesAtMs ? "hello world" : "hello"),
		);
		manager.writeInput("task-1", Buffer.from("hello world", "utf8"));

		const capture = await manager.captureTaskTerminalInputBoxContentForPromptLibraryStash("task-1");

		expect(capture?.status).toBe("captured_stashable_text");
		expect(capture?.text).toBe("hello world");
	});

	it("提交（CR）之后账本与判空归零，占位符不再被上一次组合的粘贴认领", async () => {
		const manager = new TerminalSessionManager();
		injectClaudeEntryWithScreen(manager, buildInputBoxScreen("[Pasted text #1 +3 lines]"));
		const pastedPayload = ["a", "b", "c", "d"].join(PASTED_NEWLINE);
		manager.writeInput(
			"task-1",
			Buffer.from(`${BRACKETED_PASTE_START_MARKER}${pastedPayload}${BRACKETED_PASTE_END_MARKER}`, "utf8"),
		);
		manager.writeInput("task-1", Buffer.from(PASTED_NEWLINE, "utf8"));
		markHumanKeystrokeSettleWindowAsAlreadyElapsed(manager);

		const capture = await manager.captureTaskTerminalInputBoxContentForPromptLibraryStash("task-1");

		// 提交后账本清空 ⇒ 占位符配不上任何条目，只能原样保留；判空也已归零。
		expect(capture?.status).toBe("screen_text_not_corroborated_by_keystroke_tracking");
		expect(capture?.fidelity.placeholdersLeftUnbackfilledBecauseNoLedgerEntryMatched).toBe(1);
	});

	it("没有 active PTY 会话 → null（无结论，而不是「空」）", async () => {
		const manager = new TerminalSessionManager();
		expect(await manager.captureTaskTerminalInputBoxContentForPromptLibraryStash("task-1")).toBeNull();
	});
});

describe("forwardStashKeyToClearTaskTerminalInputBox", () => {
	it("把 Ctrl+S 字节转发给 agent，并把输入侧当前组合归零", () => {
		const manager = new TerminalSessionManager();
		const { writeSpy, trackerState } = injectClaudeEntryWithScreen(manager, buildInputBoxScreen("待暂存的内容"));
		const pastedPayload = ["a", "b", "c", "d"].join(PASTED_NEWLINE);
		manager.writeInput(
			"task-1",
			Buffer.from(`${BRACKETED_PASTE_START_MARKER}${pastedPayload}${BRACKETED_PASTE_END_MARKER}`, "utf8"),
		);
		expect(trackerState.hasUncommittedInputFromInputSideByteTracking).toBe(true);
		expect(trackerState.pasteLedger).toHaveLength(1);

		expect(manager.forwardStashKeyToClearTaskTerminalInputBox("task-1", "incarnation-1")).toBe(true);

		expect(writeSpy).toHaveBeenLastCalledWith(STASH_KEY_SEQUENCE);
		// 转发那一份走 session.write 直写 PTY、不过 writeInput，跟踪器看不见它，只能由这里显式归零。
		expect(trackerState.hasUncommittedInputFromInputSideByteTracking).toBe(false);
		expect(trackerState.pasteLedger).toHaveLength(0);
	});

	it("没有 active PTY 会话 → false，不写任何字节", () => {
		const manager = new TerminalSessionManager();
		expect(manager.forwardStashKeyToClearTaskTerminalInputBox("task-1", "incarnation-1")).toBe(false);
	});

	it("取文之后 refresh 换了 incarnation → 拒绝转发，绝不清掉新会话的框", async () => {
		const manager = new TerminalSessionManager();
		injectClaudeEntryWithScreen(manager, buildInputBoxScreen("上一条会话里打了一半的字"));
		manager.writeInput("task-1", Buffer.from("上一条会话里打了一半的字", "utf8"));
		markHumanKeystrokeSettleWindowAsAlreadyElapsed(manager);
		const capture = await manager.captureTaskTerminalInputBoxContentForPromptLibraryStash("task-1");
		expect(capture?.status).toBe("captured_stashable_text");
		expect(capture?.terminalSessionIncarnationToken).toBe("incarnation-1");

		// 写库那段异步里用户 refresh 了终端：同一个 taskId 换上一条全新的 PTY 与镜像。
		const { writeSpy: writeSpyOfRefreshedSession, trackerState: trackerStateOfRefreshedSession } =
			injectClaudeEntryWithScreen(manager, buildInputBoxScreen("新会话里刚打的字"), "incarnation-2");
		manager.writeInput("task-1", Buffer.from("新会话里刚打的字", "utf8"));
		const writeCallCountBeforeForward = writeSpyOfRefreshedSession.mock.calls.length;

		expect(
			manager.forwardStashKeyToClearTaskTerminalInputBox("task-1", capture?.terminalSessionIncarnationToken ?? ""),
		).toBe(false);

		// 新会话一个字节都没收到，它的输入侧组合也没被归零——那段输入与本次暂存毫无关系。
		expect(writeSpyOfRefreshedSession.mock.calls.length).toBe(writeCallCountBeforeForward);
		expect(trackerStateOfRefreshedSession.hasUncommittedInputFromInputSideByteTracking).toBe(true);
	});
});

describe("runTaskTerminalInputBoxStashAttemptExclusivelyPerTask", () => {
	it("同一 task 上重入 → 第二次不跑取文/写库，拿到「已有一次在进行中」的结论", async () => {
		const manager = new TerminalSessionManager();
		let concurrentlyRunningAttemptCount = 0;
		let peakConcurrentlyRunningAttemptCount = 0;
		let releaseFirstAttempt = (): void => {};
		const firstAttemptCanFinish = new Promise<void>((resolve) => {
			releaseFirstAttempt = resolve;
		});
		const runAttempt = async (blockUntilReleased: boolean): Promise<string> => {
			concurrentlyRunningAttemptCount += 1;
			peakConcurrentlyRunningAttemptCount = Math.max(
				peakConcurrentlyRunningAttemptCount,
				concurrentlyRunningAttemptCount,
			);
			if (blockUntilReleased) {
				await firstAttemptCanFinish;
			}
			concurrentlyRunningAttemptCount -= 1;
			return "stashed";
		};

		const firstAttempt = manager.runTaskTerminalInputBoxStashAttemptExclusivelyPerTask(
			"task-1",
			() => runAttempt(true),
			() => "already_in_flight",
		);
		// 第一次仍卡在写库上时按下的第二次：闸门必须当场拒绝，而不是排队、更不是放行去重复入库。
		const secondAttemptResult = await manager.runTaskTerminalInputBoxStashAttemptExclusivelyPerTask(
			"task-1",
			() => runAttempt(false),
			() => "already_in_flight",
		);
		releaseFirstAttempt();

		expect(secondAttemptResult).toBe("already_in_flight");
		expect(await firstAttempt).toBe("stashed");
		expect(peakConcurrentlyRunningAttemptCount).toBe(1);
	});

	it("闸门按 task 分，且失败也要释放（否则该 task 此后再也暂存不了）", async () => {
		const manager = new TerminalSessionManager();
		let otherTaskAttemptRan = false;
		const firstAttemptStillRunning = manager.runTaskTerminalInputBoxStashAttemptExclusivelyPerTask(
			"task-1",
			async () => {
				// 另一个 task 的暂存与本次无关，不该被这道闸门挡住。
				await manager.runTaskTerminalInputBoxStashAttemptExclusivelyPerTask(
					"task-2",
					async () => {
						otherTaskAttemptRan = true;
					},
					() => {
						throw new Error("task-2 不该被 task-1 的闸门挡住");
					},
				);
				throw new Error("写库炸了");
			},
			() => undefined,
		);

		await expect(firstAttemptStillRunning).rejects.toThrow("写库炸了");
		expect(otherTaskAttemptRan).toBe(true);
		// 抛错之后闸门已释放：同一个 task 立刻能再来一次。
		let retryRan = false;
		await manager.runTaskTerminalInputBoxStashAttemptExclusivelyPerTask(
			"task-1",
			async () => {
				retryRan = true;
			},
			() => {
				throw new Error("闸门泄漏：抛错之后没释放");
			},
		);
		expect(retryRan).toBe(true);
	});
});
