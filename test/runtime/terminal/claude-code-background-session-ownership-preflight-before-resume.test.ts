// Claude 后台会话预检（`/background` 之后按 id 续跑被拒、秒退 exit 1 的修复）的单元覆盖：
//   - `claude agents --json` 的解析容错与 CLI argv 契约（假 claude 脚本）；
//   - 判定：只认 kind=background 的占用者；只有 idle 且输入框可见为空才自动收回（99b7e 现场是 idle 却开着
//     外部编辑器草稿）；用户确认接管时不看是否安全；
//   - stop 之后复查确实释放；
//   - `continued-in` 链：多跳、被后续对话覆盖、续接转录缺失、成环。
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	type ClaudeCodeBackgroundSessionDaemonClient,
	type ClaudeCodeLiveSessionListingEntry,
	createClaudeCodeBackgroundSessionDaemonCliClient,
	decideClaudeCodeBackgroundSessionReclaimSafety,
	describeClaudeCodeResumeTargetHeldByBackgroundSessionRefusal,
	findLiveBackgroundSessionHoldingResumeTarget,
	followClaudeCodeConversationContinuedInChainFromTranscript,
	parseClaudeCodeLiveSessionListingJson,
	readClaudeCodeBackgroundSessionInputBoxStateFromRecentTerminalOutput,
	runClaudeCodeResumeTargetBackgroundSessionOwnershipPreflight,
} from "../../../src/terminal/claude-code-background-session-ownership-preflight-before-resume";

const TASK_WORKING_DIRECTORY = "/Users/example/.cline/worktrees/99b7e/cline-kanban";
const RESUME_TARGET_NATIVE_SESSION_ID = "bdd73afb-38f0-4ec6-8c4e-9c488e8667f1";

function buildLiveSession(overrides: Partial<ClaudeCodeLiveSessionListingEntry>): ClaudeCodeLiveSessionListingEntry {
	return {
		claudeCodeSessionShortId: "bdd73afb",
		nativeSessionId: RESUME_TARGET_NATIVE_SESSION_ID,
		startedInWorkingDirectoryPath: TASK_WORKING_DIRECTORY,
		sessionHostKind: "background",
		processId: 66849,
		turnActivityStatus: "idle",
		...overrides,
	};
}

describe("parseClaudeCodeLiveSessionListingJson", () => {
	it("reads the fields of a real `claude agents --json` listing and ignores the rest", () => {
		// 2026-10-07 本机 `claude agents --json` 的原样输出（Claude Code 2.1.292）。
		const stdout = JSON.stringify([
			{
				pid: 66849,
				id: "bdd73afb",
				cwd: TASK_WORKING_DIRECTORY,
				kind: "background",
				startedAt: 1791311298366,
				sessionId: RESUME_TARGET_NATIVE_SESSION_ID,
				name: "Orchestrator agent for parallel tasks",
				status: "idle",
				state: "working",
			},
			{
				pid: 1407,
				cwd: "/Users/example/.cline/worktrees/e336e/cline-kanban",
				kind: "interactive",
				startedAt: 1791319560023,
				sessionId: "39827522-ca6d-45ba-8178-b2b61f117786",
				name: "cline-kanban-c8",
				status: "busy",
			},
		]);
		expect(parseClaudeCodeLiveSessionListingJson(stdout)).toEqual([
			buildLiveSession({}),
			// 交互会话没有短 id 字段——不认识的条目被跳过，而不是让整份列表失败。
		]);
	});

	it("skips an unrecognized entry without dropping the entry that holds the resume target", () => {
		const stdout = JSON.stringify([
			{ kind: 42 },
			{ id: "bdd73afb", kind: "background", sessionId: RESUME_TARGET_NATIVE_SESSION_ID, status: "busy" },
		]);
		expect(parseClaudeCodeLiveSessionListingJson(stdout)).toEqual([
			buildLiveSession({ startedInWorkingDirectoryPath: null, processId: null, turnActivityStatus: "busy" }),
		]);
	});

	it("rejects output that is not a JSON array", () => {
		expect(() => parseClaudeCodeLiveSessionListingJson("{}")).toThrow("JSON array");
		expect(() => parseClaudeCodeLiveSessionListingJson("not json")).toThrow();
	});
});

// 合成的 Claude TUI 屏幕：清屏后画「横线 / 提示符行 / 横线」。提示符是 U+276F + U+00A0（与读框语法一致）。
function buildClaudeScreenBytesWithInputBox(inputBoxText: string): Buffer {
	const boundaryLine = "─".repeat(120);
	return Buffer.from(
		`\u001b[2J\u001b[H Claude Code\r\n\r\n${boundaryLine}\r\n❯ ${inputBoxText}\r\n${boundaryLine}\r\n  ⏸ manual mode on · ← for agents\r\n`,
		"utf8",
	);
}

// 99b7e 现场：Ctrl+G 打开外部编辑器后，输入框被 "Save and close editor to continue..." 取代。
const CLAUDE_SCREEN_BYTES_WAITING_FOR_EXTERNAL_EDITOR = Buffer.from(
	`\u001b[2J\u001b[H 决策请求标准化：等元分析拿到数据后再设计\r\nSave and close editor to continue...\r\n${"─".repeat(120)}\r\n`,
	"utf8",
);

describe("readClaudeCodeBackgroundSessionInputBoxStateFromRecentTerminalOutput", () => {
	it("tells an empty input box from one holding an unsent draft", async () => {
		expect(
			await readClaudeCodeBackgroundSessionInputBoxStateFromRecentTerminalOutput(
				buildClaudeScreenBytesWithInputBox(""),
			),
		).toBe("input_box_visible_and_empty");
		expect(
			await readClaudeCodeBackgroundSessionInputBoxStateFromRecentTerminalOutput(
				buildClaudeScreenBytesWithInputBox("再则是我希望更新 task name"),
			),
		).toBe("input_box_has_unsent_text");
	});

	it("reports the input box as not visible while an external editor is open", async () => {
		expect(
			await readClaudeCodeBackgroundSessionInputBoxStateFromRecentTerminalOutput(
				CLAUDE_SCREEN_BYTES_WAITING_FOR_EXTERNAL_EDITOR,
			),
		).toBe("input_box_not_visible");
	});
});

describe("decideClaudeCodeBackgroundSessionReclaimSafety", () => {
	it("is safe only when Claude reports idle and the input box is visible and empty", () => {
		expect(
			decideClaudeCodeBackgroundSessionReclaimSafety({
				turnActivityStatus: "idle",
				inputBoxStateFromRecentTerminalOutput: "input_box_visible_and_empty",
			}),
		).toEqual({ safeToReclaim: true });
	});

	it.each([
		["busy", null, "background_session_generating_response_mid_turn"],
		["waiting", null, "background_session_waiting_for_user_decision"],
		["idle", "input_box_has_unsent_text", "background_session_input_box_has_unsent_text_or_is_hidden"],
		// 99b7e 现场：Claude 报 idle，但 VS Code 里开着一份没提交的草稿。
		["idle", "input_box_not_visible", "background_session_input_box_has_unsent_text_or_is_hidden"],
		["starting", null, "background_session_activity_status_unrecognized"],
		[null, null, "background_session_activity_status_unrecognized"],
	] as const)(
		"is not safe for status %s with input box %s",
		(turnActivityStatus, inputBoxState, reclaimBlockedReason) => {
			expect(
				decideClaudeCodeBackgroundSessionReclaimSafety({
					turnActivityStatus,
					inputBoxStateFromRecentTerminalOutput: inputBoxState,
				}),
			).toEqual({ safeToReclaim: false, reclaimBlockedReason });
		},
	);

	it("only looks at background sessions holding the resume target", () => {
		expect(
			findLiveBackgroundSessionHoldingResumeTarget(
				[
					buildLiveSession({ nativeSessionId: "another-conversation" }),
					// 交互终端（包括 kanban 自己的 PTY）一律不碰，交给 Claude 自己判。
					buildLiveSession({ sessionHostKind: "interactive" }),
				],
				RESUME_TARGET_NATIVE_SESSION_ID,
			),
		).toBeNull();
	});
});

function createFakeDaemonClient(input: {
	listings: Array<ClaudeCodeLiveSessionListingEntry[] | "listing_failed">;
	recentTerminalOutputBytes?: Buffer;
}) {
	const remainingListings = [...input.listings];
	return {
		listLiveSessionsStartedUnderWorkingDirectory: vi.fn<
			ClaudeCodeBackgroundSessionDaemonClient["listLiveSessionsStartedUnderWorkingDirectory"]
		>(async () => {
			const next = remainingListings.shift() ?? [];
			return next === "listing_failed"
				? { ok: false, failureMessage: "spawn claude ENOENT" }
				: { ok: true, liveSessions: next };
		}),
		readBackgroundSessionRecentTerminalOutput: vi.fn<
			ClaudeCodeBackgroundSessionDaemonClient["readBackgroundSessionRecentTerminalOutput"]
		>(async () =>
			input.recentTerminalOutputBytes
				? { ok: true, recentTerminalOutputBytes: input.recentTerminalOutputBytes }
				: { ok: false, failureMessage: "no output" },
		),
		stopBackgroundSession: vi.fn<ClaudeCodeBackgroundSessionDaemonClient["stopBackgroundSession"]>(async () => ({
			ok: true,
		})),
	};
}

async function runPreflight(
	daemonClient: ClaudeCodeBackgroundSessionDaemonClient,
	stopEvenIfReclaimIsUnsafeBecauseUserConfirmedTakeover = false,
) {
	return await runClaudeCodeResumeTargetBackgroundSessionOwnershipPreflight({
		daemonClient,
		claudeBinary: "claude",
		workingDirectoryPath: TASK_WORKING_DIRECTORY,
		resumeTargetNativeSessionId: RESUME_TARGET_NATIVE_SESSION_ID,
		stopEvenIfReclaimIsUnsafeBecauseUserConfirmedTakeover,
	});
}

describe("runClaudeCodeResumeTargetBackgroundSessionOwnershipPreflight", () => {
	it("stops an idle background session with an empty input box, confirms the release, then proceeds", async () => {
		const daemonClient = createFakeDaemonClient({
			listings: [[buildLiveSession({})], []],
			recentTerminalOutputBytes: buildClaudeScreenBytesWithInputBox(""),
		});
		expect(await runPreflight(daemonClient)).toEqual({
			kind: "proceed_after_stopping_background_session",
			claudeCodeSessionShortId: "bdd73afb",
			stoppedDespiteUnsafeReclaimBecauseUserConfirmedTakeover: false,
		});
		expect(daemonClient.readBackgroundSessionRecentTerminalOutput).toHaveBeenCalledWith({
			claudeBinary: "claude",
			claudeCodeSessionShortId: "bdd73afb",
		});
		expect(daemonClient.stopBackgroundSession).toHaveBeenCalledWith({
			claudeBinary: "claude",
			claudeCodeSessionShortId: "bdd73afb",
		});
		expect(daemonClient.listLiveSessionsStartedUnderWorkingDirectory).toHaveBeenCalledWith({
			claudeBinary: "claude",
			workingDirectoryPath: TASK_WORKING_DIRECTORY,
		});
	});

	it("does not stop an idle background session that is holding an unsent draft in an external editor", async () => {
		const daemonClient = createFakeDaemonClient({
			listings: [[buildLiveSession({})]],
			recentTerminalOutputBytes: CLAUDE_SCREEN_BYTES_WAITING_FOR_EXTERNAL_EDITOR,
		});
		expect(await runPreflight(daemonClient)).toEqual({
			kind: "refuse_resume_target_held_by_background_session_not_safe_to_reclaim",
			claudeCodeSessionShortId: "bdd73afb",
			reclaimBlockedReason: "background_session_input_box_has_unsent_text_or_is_hidden",
		});
		expect(daemonClient.stopBackgroundSession).not.toHaveBeenCalled();
	});

	it("treats an unreadable screen as not safe", async () => {
		const daemonClient = createFakeDaemonClient({ listings: [[buildLiveSession({})]] });
		expect((await runPreflight(daemonClient)).kind).toBe(
			"refuse_resume_target_held_by_background_session_not_safe_to_reclaim",
		);
		expect(daemonClient.stopBackgroundSession).not.toHaveBeenCalled();
	});

	it("never stops a background session that is mid-turn unless the user confirmed the takeover", async () => {
		const busyHolder = buildLiveSession({ turnActivityStatus: "busy" });
		const refusing = createFakeDaemonClient({ listings: [[busyHolder]] });
		expect(await runPreflight(refusing)).toEqual({
			kind: "refuse_resume_target_held_by_background_session_not_safe_to_reclaim",
			claudeCodeSessionShortId: "bdd73afb",
			reclaimBlockedReason: "background_session_generating_response_mid_turn",
		});
		expect(refusing.stopBackgroundSession).not.toHaveBeenCalled();
		// 只在 idle 时才读屏：busy 不必花这次 `claude logs`。
		expect(refusing.readBackgroundSessionRecentTerminalOutput).not.toHaveBeenCalled();

		const takingOver = createFakeDaemonClient({ listings: [[busyHolder], []] });
		expect(await runPreflight(takingOver, true)).toEqual({
			kind: "proceed_after_stopping_background_session",
			claudeCodeSessionShortId: "bdd73afb",
			stoppedDespiteUnsafeReclaimBecauseUserConfirmedTakeover: true,
		});
		expect(takingOver.stopBackgroundSession).toHaveBeenCalledTimes(1);
	});

	it("proceeds without blocking the launch when the ownership listing itself fails", async () => {
		const daemonClient = createFakeDaemonClient({ listings: ["listing_failed"] });
		expect(await runPreflight(daemonClient)).toEqual({
			kind: "proceed_because_background_session_ownership_inspection_failed",
			failureMessage: "spawn claude ENOENT",
		});
		expect(daemonClient.stopBackgroundSession).not.toHaveBeenCalled();
	});

	it("refuses when the stop fails or the session is still listed afterwards", async () => {
		const stopFails = createFakeDaemonClient({
			listings: [[buildLiveSession({})]],
			recentTerminalOutputBytes: buildClaudeScreenBytesWithInputBox(""),
		});
		stopFails.stopBackgroundSession.mockResolvedValueOnce({ ok: false, failureMessage: "daemon unreachable" });
		expect(await runPreflight(stopFails)).toMatchObject({
			kind: "refuse_resume_target_held_by_background_session_not_safe_to_reclaim",
			reclaimBlockedReason: "background_session_did_not_release_after_stop",
		});

		const stillListed = createFakeDaemonClient({
			listings: [[buildLiveSession({})], [buildLiveSession({})]],
			recentTerminalOutputBytes: buildClaudeScreenBytesWithInputBox(""),
		});
		expect(await runPreflight(stillListed)).toMatchObject({
			kind: "refuse_resume_target_held_by_background_session_not_safe_to_reclaim",
			reclaimBlockedReason: "background_session_did_not_release_after_stop",
		});
	});

	it("explains the refusal with the attach command and the takeover button", () => {
		const message = describeClaudeCodeResumeTargetHeldByBackgroundSessionRefusal({
			claudeCodeSessionShortId: "bdd73afb",
			reclaimBlockedReason: "background_session_input_box_has_unsent_text_or_is_hidden",
		});
		expect(message).toContain("claude attach bdd73afb");
		expect(message).toContain("停止后台会话并在这里续跑");
		expect(message).toContain("外部编辑器");
	});
});

describe("createClaudeCodeBackgroundSessionDaemonCliClient", () => {
	let temporaryDirectoryPath: string;

	beforeEach(() => {
		temporaryDirectoryPath = mkdtempSync(join(tmpdir(), "kanban-claude-background-session-cli-client-"));
	});

	afterEach(() => {
		rmSync(temporaryDirectoryPath, { recursive: true, force: true });
	});

	function writeFakeClaudeBinary(listingJson: string): string {
		const fakeClaudeBinaryPath = join(temporaryDirectoryPath, "claude");
		writeFileSync(join(temporaryDirectoryPath, "listing.json"), listingJson);
		writeFileSync(
			fakeClaudeBinaryPath,
			[
				"#!/bin/sh",
				'here="$(dirname "$0")"',
				'printf "%s\\n" "$*" >> "$here/argv-log.txt"',
				'if [ "$1" = "agents" ]; then cat "$here/listing.json"; exit 0; fi',
				'if [ "$1" = "stop" ]; then echo "stopped $2"; exit 0; fi',
				'if [ "$1" = "logs" ]; then printf "screen-of-%s" "$2"; exit 0; fi',
				"exit 2",
			].join("\n"),
		);
		chmodSync(fakeClaudeBinaryPath, 0o755);
		return fakeClaudeBinaryPath;
	}

	it("lists with `agents --json --cwd <cwd>`, reads the screen with `logs <short id>`, stops with `stop <short id>`", async () => {
		const claudeBinary = writeFakeClaudeBinary(
			JSON.stringify([
				{ id: "bdd73afb", kind: "background", sessionId: RESUME_TARGET_NATIVE_SESSION_ID, status: "idle" },
			]),
		);
		const client = createClaudeCodeBackgroundSessionDaemonCliClient();
		const listing = await client.listLiveSessionsStartedUnderWorkingDirectory({
			claudeBinary,
			workingDirectoryPath: TASK_WORKING_DIRECTORY,
		});
		expect(listing.ok && listing.liveSessions.map((session) => session.claudeCodeSessionShortId)).toEqual([
			"bdd73afb",
		]);
		const recentTerminalOutput = await client.readBackgroundSessionRecentTerminalOutput({
			claudeBinary,
			claudeCodeSessionShortId: "bdd73afb",
		});
		expect(recentTerminalOutput.ok && recentTerminalOutput.recentTerminalOutputBytes.toString("utf8")).toBe(
			"screen-of-bdd73afb",
		);
		expect(await client.stopBackgroundSession({ claudeBinary, claudeCodeSessionShortId: "bdd73afb" })).toEqual({
			ok: true,
		});
		expect(readFileSync(join(temporaryDirectoryPath, "argv-log.txt"), "utf8").trim().split("\n")).toEqual([
			`agents --json --cwd ${TASK_WORKING_DIRECTORY}`,
			"logs bdd73afb",
			"stop bdd73afb",
		]);
	});

	it("reports a failure instead of throwing when the claude binary is missing or prints garbage", async () => {
		const client = createClaudeCodeBackgroundSessionDaemonCliClient();
		const missing = await client.listLiveSessionsStartedUnderWorkingDirectory({
			claudeBinary: join(temporaryDirectoryPath, "no-such-claude"),
			workingDirectoryPath: TASK_WORKING_DIRECTORY,
		});
		expect(missing.ok).toBe(false);
		const garbage = await client.listLiveSessionsStartedUnderWorkingDirectory({
			claudeBinary: writeFakeClaudeBinary("Starting background service…"),
			workingDirectoryPath: TASK_WORKING_DIRECTORY,
		});
		expect(garbage.ok).toBe(false);
	});
});

describe("followClaudeCodeConversationContinuedInChainFromTranscript", () => {
	let projectDirectoryPath: string;

	beforeEach(() => {
		projectDirectoryPath = mkdtempSync(join(tmpdir(), "kanban-claude-continued-in-chain-"));
	});

	afterEach(() => {
		rmSync(projectDirectoryPath, { recursive: true, force: true });
	});

	function writeTranscript(sessionId: string, records: Array<Record<string, unknown>>): string {
		const transcriptPath = join(projectDirectoryPath, `${sessionId}.jsonl`);
		writeFileSync(transcriptPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
		return transcriptPath;
	}

	const userTurn = { type: "user", message: { role: "user", content: "hello" } };
	const assistantTurn = { type: "assistant", message: { role: "assistant", content: [] } };
	const costState = { type: "cost-state", totalCostUSD: 1 };

	it("follows every hop to the transcript where the conversation lives now", async () => {
		// 原样复刻 99b7e：fd026429 末尾 continued-in → bdd73afb，其后还跟着 cost-state。
		const originalTranscriptPath = writeTranscript("fd026429", [
			userTurn,
			assistantTurn,
			costState,
			{ type: "continued-in", continuedInSessionId: "bdd73afb" },
			costState,
		]);
		writeTranscript("bdd73afb", [
			userTurn,
			assistantTurn,
			{ type: "continued-in", continuedInSessionId: "c0ffee00" },
		]);
		const latestTranscriptPath = writeTranscript("c0ffee00", [userTurn, assistantTurn]);
		expect(
			await followClaudeCodeConversationContinuedInChainFromTranscript({ transcriptPath: originalTranscriptPath }),
		).toEqual({
			nativeSessionId: "c0ffee00",
			transcriptPath: latestTranscriptPath,
		});
	});

	it("does not follow a continuation that the conversation later moved past in the original transcript", async () => {
		const originalTranscriptPath = writeTranscript("fd026429", [
			userTurn,
			{ type: "continued-in", continuedInSessionId: "bdd73afb" },
			userTurn,
			assistantTurn,
		]);
		writeTranscript("bdd73afb", [userTurn]);
		expect(
			await followClaudeCodeConversationContinuedInChainFromTranscript({ transcriptPath: originalTranscriptPath }),
		).toBeNull();
	});

	it("stays put when the continuation transcript is not in the same project directory", async () => {
		const originalTranscriptPath = writeTranscript("fd026429", [
			userTurn,
			{ type: "continued-in", continuedInSessionId: "isolated-worktree-session" },
		]);
		expect(
			await followClaudeCodeConversationContinuedInChainFromTranscript({ transcriptPath: originalTranscriptPath }),
		).toBeNull();
	});

	it("stops at a cycle and on a missing transcript", async () => {
		const originalTranscriptPath = writeTranscript("aaaa", [{ type: "continued-in", continuedInSessionId: "bbbb" }]);
		const continuationTranscriptPath = writeTranscript("bbbb", [
			{ type: "continued-in", continuedInSessionId: "aaaa" },
		]);
		expect(
			await followClaudeCodeConversationContinuedInChainFromTranscript({ transcriptPath: originalTranscriptPath }),
		).toEqual({
			nativeSessionId: "bbbb",
			transcriptPath: continuationTranscriptPath,
		});
		expect(
			await followClaudeCodeConversationContinuedInChainFromTranscript({
				transcriptPath: join(projectDirectoryPath, "missing.jsonl"),
			}),
		).toBeNull();
	});

	it("finds the record at the end of a transcript far larger than the scanned tail", async () => {
		const hugeAssistantTurn = { type: "assistant", message: { content: "x".repeat(600 * 1024) } };
		const originalTranscriptPath = writeTranscript("fd026429", [
			userTurn,
			hugeAssistantTurn,
			{ type: "continued-in", continuedInSessionId: "bdd73afb" },
			costState,
		]);
		writeTranscript("bdd73afb", [userTurn]);
		expect(
			(await followClaudeCodeConversationContinuedInChainFromTranscript({ transcriptPath: originalTranscriptPath }))
				?.nativeSessionId,
		).toBe("bdd73afb");
	});
});
