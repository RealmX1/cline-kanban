// 续跑前核对：要按 id 续跑的 Claude 对话，此刻是不是正被 **Claude Code 自己的后台会话守护进程**占着；
// 若是，能安全收回就收回，不能就拒绝（并交给盯梢 / 一键接管，见 session manager）。
//
// 存在理由（2026-10-07 任务 99b7e 取证）：kanban 终端里的 Claude 被转成后台会话——`/background`（`/bg`），或
// 输入框为空时按一下 ←（agent view 手势，不可改键，可在 `/config` 关掉「← opens agents」；99b7e 实为后者：
// 用户从未输入过 /bg，见 post-mortem）。
// Claude 把对话以 resume + fork 搬进自己的守护进程（`claude daemon` → `bg-pty-host`），原转录末尾写下
// `continued-in → <新 id>`。之后 kanban 按 id 续跑，`claude --resume <id>` 被拒并立即 exit 1：
// "That session is running in the background (<short>). Run `claude attach …` or `claude stop …` first"。
// kanban 对此毫无感知，只能当普通秒退处理，任务就此打不开。
//
// 处置（用户已定，并核对过热重启的影响；全文见 docs/post-mortems/claude-code-background-session-resume-refusal-2026-10-07.md）：
//   - **能安全收回** ⇒ `claude stop <short>`（对话保留，实测之后 `--resume` 同 id 成功、上下文连续），再照常
//     按 id 续跑。kanban 重新持有进程：hook env、pid、自动重启、程序化投递、热重启接管都重新成立。
//   - 「能安全收回」= Claude 自报 `idle` **且**输入框可见且为空。只看 `idle` 不够：Claude 的 status 只由
//     「请求在途 / 工具在跑（busy）」与「对话框 / 权限 / elicitation（waiting）」决定，外部编辑器（Ctrl+G，
//     屏上 "Save and close editor to continue..."）和输入框里没提交的草稿都不算——99b7e 现场就是 idle 却开着
//     一份 VS Code 草稿。输入框经 `claude logs` 的最近输出回放进无头镜像、用仓库既有的 Claude 读框语法读出。
//   - **不能安全收回** ⇒ 不 spawn、写明原因；由调用方决定盯梢等它变安全，或在用户显式确认后强制接管。
//   - 只认 kind=background 的占用者。交互终端（包括 kanban 自己的 PTY）一律不碰，照旧交给 Claude 自己判：
//     按 pid 认「这是不是 kanban 自己」在用户配了包装脚本时会认错，误拒一次活会话的刷新代价更大。
//   - 列举失败（CLI 不在、超时、输出格式不认识）⇒ 放行。核对不了不该挡住启动，最坏情形与修复前相同。
//
// 已知范围：只覆盖「按已记录的原生 id 续跑」。没有身份记录、走 `--continue` 的旧会话不预检。

import { execFile } from "node:child_process";
import { open, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

import type { RuntimeHarnessBackgroundSessionReclaimBlockedReason } from "../core/api-contract";
import { CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR, readTerminalInputBox } from "./terminal-input-box-reader";
import { TerminalStateMirror } from "./terminal-state-mirror";

const execFileAsync = promisify(execFile);

// `claude agents --json` 实测 0.14s；给足余量但不能让一次续跑卡太久。
const CLAUDE_CODE_LIVE_SESSION_LISTING_TIMEOUT_MS = 5_000;
// `claude stop` 实测 0.68s 且同步完成（返回时已从存活列表消失）。
const CLAUDE_CODE_BACKGROUND_SESSION_STOP_TIMEOUT_MS = 15_000;
const CLAUDE_CODE_BACKGROUND_SESSION_RECENT_TERMINAL_OUTPUT_TIMEOUT_MS = 5_000;
const CLAUDE_CODE_CLI_MAXIMUM_STDOUT_BYTES = 16 * 1024 * 1024;
// 回放 `claude logs` 用的镜像尺寸。后台 PTY 默认 200×50，被客户端 attach 过会改成客户端的尺寸；镜像比真实
// PTY 小会折行、读不出框（实测 120×40 读不出，200×50 / 400×120 都读得出），所以取一个宽裕的上限。
// 读不出框按「不安全」处理，错在保守一侧。
// EXPERIMENT_NODE: 400×120 是否覆盖用户常见的 attach 终端尺寸；更大的终端会被判成「输入框不可见」而不自动收回。
const CLAUDE_CODE_BACKGROUND_SESSION_SCREEN_REPLAY_MIRROR_COLUMNS = 400;
const CLAUDE_CODE_BACKGROUND_SESSION_SCREEN_REPLAY_MIRROR_ROWS = 120;

// `continued-in` 记录写在被搬走的转录末尾，其后只跟几行很小的 cost-state，尾部这么大足够覆盖。
const CLAUDE_CODE_TRANSCRIPT_TAIL_BYTES_SCANNED_FOR_CONTINUED_IN_RECORD = 256 * 1024;
const CLAUDE_CODE_CONTINUED_IN_CHAIN_MAXIMUM_FOLLOWED_HOPS = 16;

// `claude agents --json` 的单条记录。只取判定要用的字段，其余字段（name / state / startedAt …）忽略，
// 免得 Claude 加字段就让解析失败。
const claudeCodeLiveSessionListingEntryJsonSchema = z.object({
	id: z.string(),
	sessionId: z.string().nullable().optional(),
	cwd: z.string().nullable().optional(),
	kind: z.string(),
	pid: z.number().nullable().optional(),
	status: z.string().nullable().optional(),
});

export interface ClaudeCodeLiveSessionListingEntry {
	// `claude attach / stop / logs` 认的短 id（session id 的前 8 位）。
	claudeCodeSessionShortId: string;
	nativeSessionId: string | null;
	startedInWorkingDirectoryPath: string | null;
	// "background"：守护进程托管；"interactive"：某个终端里的前台会话（包括 kanban 自己的 PTY）。
	sessionHostKind: string;
	processId: number | null;
	// Claude 会话进程自报：busy = 请求在途或工具在跑；waiting = 对话框 / 权限 / elicitation 等着人；idle = 其余。
	turnActivityStatus: string | null;
}

export type ClaudeCodeLiveSessionListingOutcome =
	| { ok: true; liveSessions: ClaudeCodeLiveSessionListingEntry[] }
	| { ok: false; failureMessage: string };

export type ClaudeCodeBackgroundSessionStopOutcome = { ok: true } | { ok: false; failureMessage: string };

export type ClaudeCodeBackgroundSessionRecentTerminalOutputOutcome =
	| { ok: true; recentTerminalOutputBytes: Buffer }
	| { ok: false; failureMessage: string };

// 与 Claude 守护进程对话的三个动作。生产实现见 createClaudeCodeBackgroundSessionDaemonCliClient；
// session manager 未注入时整道预检不运行（与其它可选协作者同一约定）。
export interface ClaudeCodeBackgroundSessionDaemonClient {
	listLiveSessionsStartedUnderWorkingDirectory(input: {
		claudeBinary: string;
		workingDirectoryPath: string;
	}): Promise<ClaudeCodeLiveSessionListingOutcome>;
	readBackgroundSessionRecentTerminalOutput(input: {
		claudeBinary: string;
		claudeCodeSessionShortId: string;
	}): Promise<ClaudeCodeBackgroundSessionRecentTerminalOutputOutcome>;
	stopBackgroundSession(input: {
		claudeBinary: string;
		claudeCodeSessionShortId: string;
	}): Promise<ClaudeCodeBackgroundSessionStopOutcome>;
}

export function parseClaudeCodeLiveSessionListingJson(stdout: string): ClaudeCodeLiveSessionListingEntry[] {
	const parsed: unknown = JSON.parse(stdout);
	if (!Array.isArray(parsed)) {
		throw new Error("claude agents --json did not print a JSON array.");
	}
	const liveSessions: ClaudeCodeLiveSessionListingEntry[] = [];
	for (const candidate of parsed) {
		// 单条不认识就跳过而不是整体失败：一条怪记录不该让真正占着目标的那条也被忽略。
		const entry = claudeCodeLiveSessionListingEntryJsonSchema.safeParse(candidate);
		if (!entry.success) {
			continue;
		}
		liveSessions.push({
			claudeCodeSessionShortId: entry.data.id,
			nativeSessionId: entry.data.sessionId ?? null,
			startedInWorkingDirectoryPath: entry.data.cwd ?? null,
			sessionHostKind: entry.data.kind,
			processId: entry.data.pid ?? null,
			turnActivityStatus: entry.data.status ?? null,
		});
	}
	return liveSessions;
}

function describeExecFileFailure(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// 直接 execFile，不经交互 shell（AGENTS.md 铁律：重 shell init 下每任务一次会冻结运行时）。
// env 沿用运行时自己的：运行时启动时已擦掉继承的任务身份变量。`claude agents --json` 在守护进程没跑时
// 不会把它拉起来（隔离 HOME 与本机 10-08 实测），所以这里不会把运行时 env 泄进守护进程。列表里除了存活会话，
// 不论守护进程在不在跑，都可能混着已退役后台任务的残留记录（没有 pid），由
// findLiveBackgroundSessionHoldingResumeTarget 排除。
export function createClaudeCodeBackgroundSessionDaemonCliClient(): ClaudeCodeBackgroundSessionDaemonClient {
	return {
		async listLiveSessionsStartedUnderWorkingDirectory(input) {
			try {
				const { stdout } = await execFileAsync(
					input.claudeBinary,
					["agents", "--json", "--cwd", input.workingDirectoryPath],
					{
						timeout: CLAUDE_CODE_LIVE_SESSION_LISTING_TIMEOUT_MS,
						maxBuffer: CLAUDE_CODE_CLI_MAXIMUM_STDOUT_BYTES,
					},
				);
				return { ok: true, liveSessions: parseClaudeCodeLiveSessionListingJson(stdout) };
			} catch (error) {
				return { ok: false, failureMessage: describeExecFileFailure(error) };
			}
		},
		async readBackgroundSessionRecentTerminalOutput(input) {
			try {
				const { stdout } = await execFileAsync(input.claudeBinary, ["logs", input.claudeCodeSessionShortId], {
					timeout: CLAUDE_CODE_BACKGROUND_SESSION_RECENT_TERMINAL_OUTPUT_TIMEOUT_MS,
					maxBuffer: CLAUDE_CODE_CLI_MAXIMUM_STDOUT_BYTES,
					encoding: "buffer",
				});
				return { ok: true, recentTerminalOutputBytes: stdout };
			} catch (error) {
				return { ok: false, failureMessage: describeExecFileFailure(error) };
			}
		},
		async stopBackgroundSession(input) {
			try {
				await execFileAsync(input.claudeBinary, ["stop", input.claudeCodeSessionShortId], {
					timeout: CLAUDE_CODE_BACKGROUND_SESSION_STOP_TIMEOUT_MS,
				});
				return { ok: true };
			} catch (error) {
				return { ok: false, failureMessage: describeExecFileFailure(error) };
			}
		},
	};
}

// 只认带 pid 的后台记录。`claude agents --json` 还会列出守护进程已退役的后台任务（`~/.claude/jobs/<短 id>/`
// 的残留，state 多为 blocked）：没有 pid、没有 status。Claude 自己的续跑拒绝只查存活会话登记，这类残留不会
// 让续跑被拒（2026-10-08 99b7e：bdd73afb 10-07 05:45 已退役，06:13 按 id 续跑成功并跑了 6.8 小时，
// 次日预检却因它把任务挡住）。代价：后台任务创建后约 5 秒内 worker 尚未登记、暂无 pid，这期间会漏判，
// 漏判的后果与没有预检时相同（Claude 自己拒绝、exit 1），不丢东西。
export function findLiveBackgroundSessionHoldingResumeTarget(
	liveSessions: readonly ClaudeCodeLiveSessionListingEntry[],
	resumeTargetNativeSessionId: string,
): ClaudeCodeLiveSessionListingEntry | null {
	return (
		liveSessions.find(
			(session) =>
				session.sessionHostKind === "background" &&
				session.processId !== null &&
				session.nativeSessionId === resumeTargetNativeSessionId,
		) ?? null
	);
}

export type ClaudeCodeBackgroundSessionInputBoxStateFromRecentTerminalOutput =
	| "input_box_visible_and_empty"
	| "input_box_has_unsent_text"
	// 屏上找不到输入框：外部编辑器开着（"Save and close editor to continue..."）、全屏输出盖住了它，
	// 或回放尺寸装不下。一律当作「不确定没有未提交的东西」。
	| "input_box_not_visible";

export async function readClaudeCodeBackgroundSessionInputBoxStateFromRecentTerminalOutput(
	recentTerminalOutputBytes: Buffer,
): Promise<ClaudeCodeBackgroundSessionInputBoxStateFromRecentTerminalOutput> {
	const mirror = new TerminalStateMirror(
		CLAUDE_CODE_BACKGROUND_SESSION_SCREEN_REPLAY_MIRROR_COLUMNS,
		CLAUDE_CODE_BACKGROUND_SESSION_SCREEN_REPLAY_MIRROR_ROWS,
	);
	try {
		mirror.applyOutput(recentTerminalOutputBytes);
		const reading = readTerminalInputBox(await mirror.getScreenSnapshot(), CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR);
		if (!reading) {
			return "input_box_not_visible";
		}
		return reading.text.trim().length === 0 ? "input_box_visible_and_empty" : "input_box_has_unsent_text";
	} finally {
		mirror.dispose();
	}
}

export type ClaudeCodeBackgroundSessionReclaimSafety =
	| { safeToReclaim: true }
	| { safeToReclaim: false; reclaimBlockedReason: RuntimeHarnessBackgroundSessionReclaimBlockedReason };

// 纯判定：Claude 自报的活动状态 + 读框结果 ⇒ 能不能安全收回。读框结果只在 idle 时才有意义（调用方也只在
// idle 时才去读），其余状态不看它。
export function decideClaudeCodeBackgroundSessionReclaimSafety(input: {
	turnActivityStatus: string | null;
	inputBoxStateFromRecentTerminalOutput: ClaudeCodeBackgroundSessionInputBoxStateFromRecentTerminalOutput | null;
}): ClaudeCodeBackgroundSessionReclaimSafety {
	switch (input.turnActivityStatus) {
		case "busy":
			return { safeToReclaim: false, reclaimBlockedReason: "background_session_generating_response_mid_turn" };
		case "waiting":
			return { safeToReclaim: false, reclaimBlockedReason: "background_session_waiting_for_user_decision" };
		case "idle":
			return input.inputBoxStateFromRecentTerminalOutput === "input_box_visible_and_empty"
				? { safeToReclaim: true }
				: {
						safeToReclaim: false,
						reclaimBlockedReason: "background_session_input_box_has_unsent_text_or_is_hidden",
					};
		default:
			return { safeToReclaim: false, reclaimBlockedReason: "background_session_activity_status_unrecognized" };
	}
}

export type ClaudeCodeResumeTargetBackgroundSessionReclaimability =
	| { kind: "background_session_ownership_inspection_failed"; failureMessage: string }
	| { kind: "resume_target_not_held_by_live_background_session" }
	| {
			kind: "resume_target_held_by_live_background_session";
			claudeCodeSessionShortId: string;
			reclaimSafety: ClaudeCodeBackgroundSessionReclaimSafety;
	  };

// 只观察、不动手：盯梢计时器每一拍用它，续跑预检也先用它。
export async function inspectClaudeCodeResumeTargetBackgroundSessionReclaimability(input: {
	daemonClient: ClaudeCodeBackgroundSessionDaemonClient;
	claudeBinary: string;
	workingDirectoryPath: string;
	resumeTargetNativeSessionId: string;
}): Promise<ClaudeCodeResumeTargetBackgroundSessionReclaimability> {
	const listing = await input.daemonClient.listLiveSessionsStartedUnderWorkingDirectory({
		claudeBinary: input.claudeBinary,
		workingDirectoryPath: input.workingDirectoryPath,
	});
	if (!listing.ok) {
		return { kind: "background_session_ownership_inspection_failed", failureMessage: listing.failureMessage };
	}
	const holder = findLiveBackgroundSessionHoldingResumeTarget(listing.liveSessions, input.resumeTargetNativeSessionId);
	if (!holder) {
		return { kind: "resume_target_not_held_by_live_background_session" };
	}
	let inputBoxStateFromRecentTerminalOutput: ClaudeCodeBackgroundSessionInputBoxStateFromRecentTerminalOutput | null =
		null;
	if (holder.turnActivityStatus === "idle") {
		const recentTerminalOutput = await input.daemonClient.readBackgroundSessionRecentTerminalOutput({
			claudeBinary: input.claudeBinary,
			claudeCodeSessionShortId: holder.claudeCodeSessionShortId,
		});
		// 读不到屏就当作看不见输入框：宁可不自动收回，也不冒丢草稿的险。
		inputBoxStateFromRecentTerminalOutput = recentTerminalOutput.ok
			? await readClaudeCodeBackgroundSessionInputBoxStateFromRecentTerminalOutput(
					recentTerminalOutput.recentTerminalOutputBytes,
				)
			: "input_box_not_visible";
	}
	return {
		kind: "resume_target_held_by_live_background_session",
		claudeCodeSessionShortId: holder.claudeCodeSessionShortId,
		reclaimSafety: decideClaudeCodeBackgroundSessionReclaimSafety({
			turnActivityStatus: holder.turnActivityStatus,
			inputBoxStateFromRecentTerminalOutput,
		}),
	};
}

export type ClaudeCodeResumeTargetBackgroundSessionOwnershipPreflightOutcome =
	| { kind: "proceed_resume_target_not_held_by_live_background_session" }
	| { kind: "proceed_because_background_session_ownership_inspection_failed"; failureMessage: string }
	| {
			kind: "proceed_after_stopping_background_session";
			claudeCodeSessionShortId: string;
			// true = 本来不能安全收回，是用户在终端面板上显式确认了接管。
			stoppedDespiteUnsafeReclaimBecauseUserConfirmedTakeover: boolean;
	  }
	| {
			kind: "refuse_resume_target_held_by_background_session_not_safe_to_reclaim";
			claudeCodeSessionShortId: string;
			reclaimBlockedReason: RuntimeHarnessBackgroundSessionReclaimBlockedReason;
	  };

export async function runClaudeCodeResumeTargetBackgroundSessionOwnershipPreflight(input: {
	daemonClient: ClaudeCodeBackgroundSessionDaemonClient;
	claudeBinary: string;
	workingDirectoryPath: string;
	resumeTargetNativeSessionId: string;
	// 用户在终端面板上点了「停止后台会话并在这里续跑」并确认：不再看是否安全，占着就停。
	stopEvenIfReclaimIsUnsafeBecauseUserConfirmedTakeover: boolean;
}): Promise<ClaudeCodeResumeTargetBackgroundSessionOwnershipPreflightOutcome> {
	const reclaimability = await inspectClaudeCodeResumeTargetBackgroundSessionReclaimability(input);
	if (reclaimability.kind === "background_session_ownership_inspection_failed") {
		return {
			kind: "proceed_because_background_session_ownership_inspection_failed",
			failureMessage: reclaimability.failureMessage,
		};
	}
	if (reclaimability.kind === "resume_target_not_held_by_live_background_session") {
		return { kind: "proceed_resume_target_not_held_by_live_background_session" };
	}
	const { claudeCodeSessionShortId, reclaimSafety } = reclaimability;
	if (!reclaimSafety.safeToReclaim && !input.stopEvenIfReclaimIsUnsafeBecauseUserConfirmedTakeover) {
		return {
			kind: "refuse_resume_target_held_by_background_session_not_safe_to_reclaim",
			claudeCodeSessionShortId,
			reclaimBlockedReason: reclaimSafety.reclaimBlockedReason,
		};
	}
	const stop = await input.daemonClient.stopBackgroundSession({
		claudeBinary: input.claudeBinary,
		claudeCodeSessionShortId,
	});
	// stop 报成功后再看一眼：仍被占着就别 spawn 一个注定被拒的进程。复查本身失败时信 stop 的结果——
	// 它是同步的（返回时会话已从存活列表消失，实测）。
	const listingAfterStop = stop.ok
		? await input.daemonClient.listLiveSessionsStartedUnderWorkingDirectory({
				claudeBinary: input.claudeBinary,
				workingDirectoryPath: input.workingDirectoryPath,
			})
		: null;
	if (
		!stop.ok ||
		(listingAfterStop?.ok &&
			findLiveBackgroundSessionHoldingResumeTarget(listingAfterStop.liveSessions, input.resumeTargetNativeSessionId))
	) {
		return {
			kind: "refuse_resume_target_held_by_background_session_not_safe_to_reclaim",
			claudeCodeSessionShortId,
			reclaimBlockedReason: "background_session_did_not_release_after_stop",
		};
	}
	return {
		kind: "proceed_after_stopping_background_session",
		claudeCodeSessionShortId,
		stoppedDespiteUnsafeReclaimBecauseUserConfirmedTakeover: !reclaimSafety.safeToReclaim,
	};
}

export function describeClaudeCodeResumeTargetHeldByBackgroundSessionRefusal(input: {
	claudeCodeSessionShortId: string;
	reclaimBlockedReason: RuntimeHarnessBackgroundSessionReclaimBlockedReason;
}): string {
	const shortId = input.claudeCodeSessionShortId;
	const whyNotReclaimed: Record<RuntimeHarnessBackgroundSessionReclaimBlockedReason, string> = {
		background_session_generating_response_mid_turn: "它正在跑一个回合",
		background_session_waiting_for_user_decision: "它停在一个等你回答的对话框 / 权限请求上",
		background_session_input_box_has_unsent_text_or_is_hidden:
			"它的输入框里有没提交的内容，或输入框被外部编辑器（Ctrl+G）等盖住了",
		background_session_activity_status_unrecognized: "看不出它此刻是否空闲",
		background_session_did_not_release_after_stop: `\`claude stop ${shortId}\` 之后它仍未释放这段对话`,
	};
	return (
		`这段对话正在 Claude Code 后台会话 ${shortId} 里（例如终端里执行过 /background，或在空输入框按了 ←），` +
		`${whyNotReclaimed[input.reclaimBlockedReason]}，为了不丢东西没有自动收回。` +
		`Kanban 会继续盯着，等它能安全收回时自动接回这个终端；也可以用 \`claude attach ${shortId}\` 去那边处理，` +
		`或在终端面板上选择「停止后台会话并在这里续跑」。`
	);
}

// ---------------------------------------------------------------------------------------------------------
// `continued-in` 链：被 `/background` 或 ← 手势搬进后台的对话，在原转录末尾留下 `{type:"continued-in", continuedInSessionId}`。
// hook 没能把新 id 报回本任务时（后台会话的 hook env 继承自守护进程，可能指向别的任务，实测），记录的身份还停在
// 原 id 上；按原 id 续跑会撞上 "moved to a background session"，或接回一段已被后续对话甩在后面的历史。
// 沿链走到对话最新所在的 id，才是要核对、要续跑的目标。

interface ClaudeCodeTranscriptTailConversationRecordSummary {
	lastConversationRecordType: "user" | "assistant" | "continued-in" | null;
	continuedInSessionId: string | null;
}

async function readClaudeCodeTranscriptTailConversationRecordSummary(
	transcriptPath: string,
): Promise<ClaudeCodeTranscriptTailConversationRecordSummary | null> {
	let fileHandle: Awaited<ReturnType<typeof open>> | null = null;
	try {
		fileHandle = await open(transcriptPath, "r");
		const { size } = await fileHandle.stat();
		const tailByteCount = Math.min(size, CLAUDE_CODE_TRANSCRIPT_TAIL_BYTES_SCANNED_FOR_CONTINUED_IN_RECORD);
		const buffer = Buffer.alloc(tailByteCount);
		await fileHandle.read(buffer, 0, tailByteCount, size - tailByteCount);
		const lines = buffer.toString("utf8").split("\n");
		// 窗口起点多半切在某行中间，第一行不完整，丢掉（除非窗口覆盖了整个文件）。
		const completeLines = tailByteCount < size ? lines.slice(1) : lines;
		const summary: ClaudeCodeTranscriptTailConversationRecordSummary = {
			lastConversationRecordType: null,
			continuedInSessionId: null,
		};
		for (const line of completeLines) {
			if (!line.trim()) {
				continue;
			}
			let record: unknown;
			try {
				record = JSON.parse(line);
			} catch {
				continue;
			}
			if (!record || typeof record !== "object") {
				continue;
			}
			const recordType = (record as { type?: unknown }).type;
			if (recordType === "user" || recordType === "assistant") {
				summary.lastConversationRecordType = recordType;
				summary.continuedInSessionId = null;
			} else if (recordType === "continued-in") {
				const continuedInSessionId = (record as { continuedInSessionId?: unknown }).continuedInSessionId;
				if (typeof continuedInSessionId === "string" && continuedInSessionId.trim()) {
					summary.lastConversationRecordType = "continued-in";
					summary.continuedInSessionId = continuedInSessionId.trim();
				}
			}
		}
		return summary;
	} catch {
		return null;
	} finally {
		await fileHandle?.close().catch(() => {
			// 只读探测，关闭失败无后果。
		});
	}
}

async function doesFileExist(filePath: string): Promise<boolean> {
	try {
		return (await stat(filePath)).isFile();
	} catch {
		return false;
	}
}

// 返回对话最新所在的位置；原转录不是被搬走的（或读不到）时返回 null。
// 只沿着**同一项目目录**里存在的转录走：后台会话若开了 worktree 隔离，续跑它的 cwd 本就不是本任务的。
export async function followClaudeCodeConversationContinuedInChainFromTranscript(input: {
	transcriptPath: string;
}): Promise<{ nativeSessionId: string; transcriptPath: string } | null> {
	const visitedTranscriptPaths = new Set<string>([input.transcriptPath]);
	let latest: { nativeSessionId: string; transcriptPath: string } | null = null;
	let currentTranscriptPath = input.transcriptPath;
	for (let hop = 0; hop < CLAUDE_CODE_CONTINUED_IN_CHAIN_MAXIMUM_FOLLOWED_HOPS; hop += 1) {
		const summary = await readClaudeCodeTranscriptTailConversationRecordSummary(currentTranscriptPath);
		if (!summary || summary.lastConversationRecordType !== "continued-in" || !summary.continuedInSessionId) {
			break;
		}
		const continuationTranscriptPath = join(dirname(currentTranscriptPath), `${summary.continuedInSessionId}.jsonl`);
		if (
			visitedTranscriptPaths.has(continuationTranscriptPath) ||
			!(await doesFileExist(continuationTranscriptPath))
		) {
			break;
		}
		visitedTranscriptPaths.add(continuationTranscriptPath);
		latest = { nativeSessionId: summary.continuedInSessionId, transcriptPath: continuationTranscriptPath };
		currentTranscriptPath = continuationTranscriptPath;
	}
	return latest;
}
