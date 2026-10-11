import { isRuntimeAgentSessionSummaryRenderedAsConversationPanel } from "@runtime-agent-catalog";
import { AgentConversationHeldByHarnessBackgroundSessionNotice } from "@/components/detail-panels/agent-conversation-held-by-harness-background-session-notice";
import { AgentNativeConversationPersistenceRecoveryNotice } from "@/components/detail-panels/agent-native-conversation-persistence-recovery-notice";
import { AgentSessionTransportSwitchButton } from "@/components/detail-panels/agent-session-transport-switch-button";
import "@xterm/xterm/css/xterm.css";

import {
	isNeverStartedPlaceholderTaskSessionSummary,
	isSessionInActiveTurn,
	resolveSessionFacets,
} from "@runtime-session-activity";
import {
	AlertTriangle,
	ArrowDown,
	ArrowUp,
	CaseSensitive,
	Command,
	Maximize2,
	MessageSquare,
	Minimize2,
	Play,
	RefreshCw,
	RotateCcw,
	ScrollText,
	Search,
	TerminalSquare,
	Unplug,
	X,
} from "lucide-react";
import type { ChangeEvent, KeyboardEvent, MutableRefObject, ReactElement } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { TerminalScrollToLatestButton } from "@/components/detail-panels/terminal-scroll-to-latest-button";
import { TerminalScrollbackTranscriptReaderPanel } from "@/components/detail-panels/terminal-scrollback-transcript-reader-panel";
import { TerminalVirtualKeyInputBar } from "@/components/detail-panels/terminal-virtual-key-input-bar";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogBody,
	AlertDialogCancel,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-is-mobile";

import type { RuntimeTaskAgentSessionInitialization, RuntimeTaskSessionSummary } from "@/runtime/types";
import {
	type TaskAgentSessionStartRequestInFlightPhase,
	useTaskAgentSessionStartRequestInFlightPhase,
} from "@/stores/task-agent-session-start-request-in-flight-store";
import { useTaskWorkspaceSnapshotValue } from "@/stores/workspace-metadata-store";
import type { TerminalSearchResultState } from "@/terminal/persistent-terminal-manager";
import { wasCurrentRuntimeSessionIncarnationEndedByKanbanInactivityReclamation } from "@/terminal/stale-agent-terminal-session-automatic-resume-eligibility";
import type { StaleAgentTerminalSessionAutomaticResumePhase } from "@/terminal/stale-agent-terminal-session-automatic-resume-scheduler";
import { usePersistentTerminalSession } from "@/terminal/use-persistent-terminal-session";
import { isKeyboardEventEmittedDuringImeComposition } from "@/utils/keyboard-event-ime-composition-detection";
import { isMacPlatform } from "@/utils/platform";
import type { TaskAgentSessionLaunchHistoryEvidence } from "@/utils/task-agent-session-launch-history-evidence";

interface AgentTerminalSessionControls {
	clearTerminal: () => void;
	containerRef: MutableRefObject<HTMLDivElement | null>;
	hasRenderedAnyTerminalContent: boolean;
	isStopping: boolean;
	isRefreshing: boolean;
	isResyncingTerminalView: boolean;
	automaticStaleSessionResumePhase: StaleAgentTerminalSessionAutomaticResumePhase | null;
	isSearchOpen: boolean;
	isScrolledAwayFromLatest: boolean;
	lastError: string | null;
	searchOpenRequestKey: number;
	searchResults: TerminalSearchResultState;
	stopTerminal: () => Promise<void>;
	refreshTerminal: () => Promise<void>;
	adoptExistingAgentConversationAndResume: (initialization: RuntimeTaskAgentSessionInitialization) => Promise<void>;
	forceStopHarnessBackgroundSessionAndResumeHere: () => Promise<void>;
	resyncTerminalView: () => Promise<void>;
	closeTerminalSearch: () => void;
	findNextInTerminal: (query: string, options?: { caseSensitive?: boolean }) => boolean;
	findPreviousInTerminal: (query: string, options?: { caseSensitive?: boolean }) => boolean;
	openTerminalSearch: () => void;
	scrollTerminalToLatest: () => void;
}

export interface AgentTerminalPanelProps {
	taskId: string;
	workspaceId: string | null;
	terminalEnabled?: boolean;
	summary: RuntimeTaskSessionSummary | null;
	onSummary?: (summary: RuntimeTaskSessionSummary) => void;
	onCommit?: () => void;
	onOpenPr?: () => void;
	isCommitLoading?: boolean;
	isOpenPrLoading?: boolean;
	taskColumnId?: string;
	onMoveToTrash?: () => void;
	isMoveToTrashLoading?: boolean;
	onMoveToValidation?: () => void;
	isMoveToValidationLoading?: boolean;
	onCancelAutomaticAction?: () => void;
	cancelAutomaticActionLabel?: string | null;
	showMoveToTrash?: boolean;
	showMoveToValidation?: boolean;
	showSessionToolbar?: boolean;
	onClose?: () => void;
	autoFocus?: boolean;
	// 由详情视图递增的「把键盘焦点接过去」请求信号，透传给终端会话；key 不变就不重复抢焦。
	agentEntryKeyboardFocusRequestKey?: number;
	// 渲染本面板的视图是不是「相邻卡片导航热键（alt+↑/↓）的接管者」。只有详情视图注册了那两条
	// useHotkeys，所以也只有它该传 true；首页底部 shell 终端与首页侧栏 agent 终端不传，alt+↑/↓
	// 在那里照常发给 agent，而不是被吞进两不管地带。
	isMountedInsideAdjacentTaskCardNavigationHotkeyOwnerView?: boolean;
	minimalHeaderTitle?: string;
	minimalHeaderSubtitle?: string | null;
	// 这张卡的主 agent 会话以前有没有真正启动过（三值证据，见 task-agent-session-launch-history-evidence.ts）。
	// 只有能拿到卡片的宿主（详情视图的主会话面板）才传；不传 = 本面板不承载这个问题，空态沿用「会话随运行时
	// 没了」的旧解释。占位 summary + 空终端时：never_launched → 「还没启动」+ 启动（带原 prompt）；
	// launch_history_unknown → 如实说不知道，把「启动」与「续跑」都摆出来；launched_before → 旧解释 + 续跑。
	taskAgentSessionLaunchHistoryEvidence?: TaskAgentSessionLaunchHistoryEvidence;
	onStartTaskAgentSessionWithTaskPrompt?: () => void;
	panelBackgroundColor?: string;
	terminalBackgroundColor?: string;
	cursorColor?: string;
	isVisible?: boolean;
	onConnectionReady?: (taskId: string) => void;
	agentCommand?: string | null;
	onSendAgentCommand?: () => void;
	isExpanded?: boolean;
	onToggleExpand?: () => void;
	// 「对话从未建立」时的「用原 prompt 全新开局」（见 agent-native-conversation-persistence-recovery-notice.tsx）。
	// 只有能拿到卡片的宿主（卡片详情）才传；不传就不显示这条出路。
	originalTaskPromptForFreshStart?: string | null;
	onStartFreshAgentSessionWithOriginalTaskPrompt?: () => Promise<void>;
}

// 读 facet 真相源（turnOwner/liveness），不再读 legacy `state`；标签文案与旧 state 映射逐项等价
// （agent⟺running、user+interrupted⟺interrupted、user+failed⟺failed、user 其余⟺awaiting_review、null⟺idle）。
// awaiting_review 的 live/exited 都落入 user 其余分支，故进程是否已退不改变此处展示（保持旧行为）。
export function describeState(summary: RuntimeTaskSessionSummary | null): string {
	if (!summary) {
		return "No session yet";
	}
	const facets = resolveSessionFacets(summary);
	if (facets.turnOwner === "agent") {
		return "Running";
	}
	if (facets.turnOwner === "user") {
		if (facets.liveness === "interrupted") {
			return "Interrupted";
		}
		if (facets.liveness === "failed") {
			return "Failed";
		}
		return "Ready for review";
	}
	return "Idle";
}

type StatusTagStyle = "neutral" | "success" | "warning" | "danger";

// 同 describeState：读 facet 真相源，样式与旧 state 映射逐项等价（agent→success、user+{interrupted,failed}→danger、user 其余→warning、null→neutral）。
export function getStateTagStyle(summary: RuntimeTaskSessionSummary | null): StatusTagStyle {
	if (!summary) {
		return "neutral";
	}
	const facets = resolveSessionFacets(summary);
	if (facets.turnOwner === "agent") {
		return "success";
	}
	if (facets.turnOwner === "user") {
		return facets.liveness === "interrupted" || facets.liveness === "failed" ? "danger" : "warning";
	}
	return "neutral";
}

const statusTagColors: Record<StatusTagStyle, string> = {
	neutral: "bg-surface-3 text-text-secondary",
	success: "bg-status-green/15 text-status-green",
	warning: "bg-status-orange/15 text-status-orange",
	danger: "bg-status-red/15 text-status-red",
};

// 终端一片空白时的可解释空态。
//
// 这块 UI 存在的直接原因：会话在首轮结束前被系统重启 / 本地 redeploy 打断后，新运行时既没有快照可发、
// 也不会再有输出，用户拿到的是一块**纯白无字**的 div —— 分不清是加载慢、是坏了、还是该做点什么。
// 契约层早就要求把回收结果讲给用户听（api-contract 的 agentSessionRuntimeReclamationOutcome 注释：
// 「用户重进任务时必须看到明确说明，而不是一个空终端让人误以为只是加载慢」），但前端一直没实现。
//
// 但「空终端 + 没有活跃回合」不只有「随运行时没了」这一种来历。一张刚进 In Progress 的新卡在整个启动窗口里
// 也长这样（高负载下实测 20s～56s），此前一律被说成「随上一个运行时没了」，还递出一个续跑式重启按钮——
// 在启动窗口里点它会和真正的启动抢同一把 per-task 闸门，把一次慢启动变成真失败。所以先分清来历，
// 再决定说什么、给什么动作。判定顺序即优先级：
//   1. 本标签页的启动请求还在路上 → 正在启动，不给任何会干扰启动的动作；
//   1b. 打开任务时的陈旧会话自动续跑正在进行 → 说明正在续跑，同样不给会和它抢 per-task 闸门的动作；
//   2. 会话以 spawn/准备失败告终（liveness=failed）→ 启动失败（原因由服务端写进终端，到了就会盖掉本空态）；
//   3. 被回收（reclamation outcome）→ 说明回收原因；
//   4. summary 仍是占位、且宿主有正面证据「这张卡从没启动过」（任务 worktree 不存在）→ 尚未启动，
//      动作是「启动」而不是续跑；
//   5. summary 仍是占位、宿主说不清有没有启动过（卡片缺启动记录但 worktree 在）→ 如实说不知道，
//      「启动」与「续跑」都给：把未知压成任何一边都会在另一边造成实伤（重发 prompt 起新对话 / 空 prompt 续跑）；
//   6. 其余 → 确有启动史、会话随运行时没了（原解释）。
type EmptyTerminalSessionCause =
	| { kind: "agent_session_start_request_in_flight"; phase: TaskAgentSessionStartRequestInFlightPhase }
	| { kind: "agent_session_automatic_resume_in_flight" }
	| { kind: "agent_session_failed_to_start" }
	| {
			kind: "agent_session_reclaimed";
			reclamationTrigger: NonNullable<
				RuntimeTaskSessionSummary["agentSessionRuntimeReclamationOutcome"]
			>["reclamationTrigger"];
	  }
	| { kind: "agent_session_never_launched" }
	| { kind: "agent_session_not_running_with_unknown_launch_history" }
	| { kind: "agent_session_ended_with_previous_runtime" };

export function classifyEmptyTerminalSessionCause({
	summary,
	startRequestInFlightPhase,
	taskAgentSessionLaunchHistoryEvidence,
	automaticStaleSessionResumePhase = null,
}: {
	summary: RuntimeTaskSessionSummary | null;
	startRequestInFlightPhase: TaskAgentSessionStartRequestInFlightPhase | null;
	taskAgentSessionLaunchHistoryEvidence: TaskAgentSessionLaunchHistoryEvidence | undefined;
	automaticStaleSessionResumePhase?: StaleAgentTerminalSessionAutomaticResumePhase | null;
}): EmptyTerminalSessionCause {
	if (startRequestInFlightPhase !== null) {
		return { kind: "agent_session_start_request_in_flight", phase: startRequestInFlightPhase };
	}
	if (automaticStaleSessionResumePhase !== null) {
		return { kind: "agent_session_automatic_resume_in_flight" };
	}
	if (summary && resolveSessionFacets(summary).liveness === "failed") {
		return { kind: "agent_session_failed_to_start" };
	}
	const reclamationOutcome = summary?.agentSessionRuntimeReclamationOutcome;
	if (reclamationOutcome) {
		return { kind: "agent_session_reclaimed", reclamationTrigger: reclamationOutcome.reclamationTrigger };
	}
	const isSummaryNeverStartedPlaceholder = summary === null || isNeverStartedPlaceholderTaskSessionSummary(summary);
	if (isSummaryNeverStartedPlaceholder && taskAgentSessionLaunchHistoryEvidence === "never_launched") {
		return { kind: "agent_session_never_launched" };
	}
	if (isSummaryNeverStartedPlaceholder && taskAgentSessionLaunchHistoryEvidence === "launch_history_unknown") {
		return { kind: "agent_session_not_running_with_unknown_launch_history" };
	}
	return { kind: "agent_session_ended_with_previous_runtime" };
}

function describeEmptyTerminalSessionCause(cause: EmptyTerminalSessionCause): {
	headline: string;
	detail: string;
} {
	switch (cause.kind) {
		case "agent_session_start_request_in_flight":
			return {
				headline:
					cause.phase === "preparing_task_worktree"
						? "Preparing the task worktree…"
						: "Launching the agent session…",
				detail: "This can take a while when the machine is under heavy load. The agent's output will appear here.",
			};
		case "agent_session_automatic_resume_in_flight":
			return {
				headline: "Resuming the previous conversation…",
				detail:
					"This task's agent session had stopped — reclaimed after sitting idle, or ended with the previous runtime. " +
					"Kanban is resuming its conversation from disk in the same worktree.",
			};
		case "agent_session_failed_to_start":
			return {
				headline: "This agent session failed to start.",
				detail: "Restarting launches it again in the same worktree.",
			};
		case "agent_session_reclaimed":
			return {
				headline:
					cause.reclamationTrigger === "park_abandoned"
						? "This session was reclaimed after waiting too long on dispatched background work."
						: "This session was reclaimed after sitting idle past its retention window.",
				detail: "Its conversation is still on disk. Restarting resumes it in the same worktree.",
			};
		case "agent_session_never_launched":
			return {
				headline: "This task's agent session hasn't started.",
				detail: "Starting it sets up the worktree if needed and sends the task prompt to the agent.",
			};
		case "agent_session_not_running_with_unknown_launch_history":
			return {
				headline: "This task's agent session isn't running.",
				detail:
					"If it never started, Start sends the task prompt to a new agent session. " +
					"If it ran before, Restart resumes its previous conversation from disk instead.",
			};
		case "agent_session_ended_with_previous_runtime":
			return {
				headline: "This session is no longer running.",
				detail:
					"It most likely ended with the previous runtime — a machine restart or a local redeploy. " +
					"Its conversation is still on disk. Restarting resumes it in the same worktree.",
			};
	}
}

// 进程已退、屏幕上还留着旧输出时的那条横幅。被 Kanban 空闲回收结束的会话不是「到此为止」：打开任务就会
// 自动续跑（见 stale-agent-terminal-session-automatic-resume-eligibility.ts），措辞要说清这一点。
// 判据直接复用资格模块的同一个函数：回收失败 / 演练记录不触发自动续跑，横幅也就不能承诺。
function describeTerminalStreamClosedBanner(summary: RuntimeTaskSessionSummary | null): string {
	if (summary && wasCurrentRuntimeSessionIncarnationEndedByKanbanInactivityReclamation(summary)) {
		return "This session was reclaimed after sitting idle. It resumes when you open the task; Restart resumes it now.";
	}
	return "Terminal stream closed — the agent process has exited. The output above is final.";
}

function AgentTerminalEmptySessionRecoveryNotice({
	cause,
	canRefresh,
	isRefreshing,
	onRefreshTerminal,
	onStartTaskAgentSessionWithTaskPrompt,
}: {
	cause: EmptyTerminalSessionCause;
	canRefresh: boolean;
	isRefreshing: boolean;
	onRefreshTerminal: () => Promise<void>;
	onStartTaskAgentSessionWithTaskPrompt: (() => void) | undefined;
}): ReactElement {
	const { headline, detail } = describeEmptyTerminalSessionCause(cause);
	const icon =
		cause.kind === "agent_session_start_request_in_flight" ||
		cause.kind === "agent_session_automatic_resume_in_flight" ? (
			<Spinner size={18} />
		) : cause.kind === "agent_session_failed_to_start" ? (
			<AlertTriangle size={18} className="text-status-red" />
		) : (
			<Unplug size={18} className="text-text-secondary" />
		);
	// 「启动」= 走正常启动、把卡片上的原 prompt 发给一段新对话；「续跑」= 对磁盘上的旧对话 --continue、空 prompt。
	// 启动请求或自动续跑在路上时两者都不给（都会和它抢 per-task 闸门）；从没启动过只给启动（没有旧对话可续）；
	// 说不清时两者都给；其余只给续跑。
	const offersStartWithTaskPrompt =
		(cause.kind === "agent_session_never_launched" ||
			cause.kind === "agent_session_not_running_with_unknown_launch_history") &&
		onStartTaskAgentSessionWithTaskPrompt !== undefined;
	const offersResumeOfPreviousConversation =
		cause.kind !== "agent_session_start_request_in_flight" &&
		cause.kind !== "agent_session_automatic_resume_in_flight" &&
		cause.kind !== "agent_session_never_launched" &&
		canRefresh;
	return (
		<div className="flex max-w-md flex-col items-center gap-3 rounded-md border border-border-subtle bg-surface-2 p-5 text-center">
			{icon}
			<div className="text-[13px] font-medium text-text-primary">{headline}</div>
			<div className="text-[12px] leading-relaxed text-text-secondary">{detail}</div>
			{offersStartWithTaskPrompt || offersResumeOfPreviousConversation ? (
				<div className="flex flex-wrap items-center justify-center gap-2">
					{offersStartWithTaskPrompt ? (
						<Button size="sm" variant="primary" onClick={onStartTaskAgentSessionWithTaskPrompt}>
							<Play size={12} />
							<span className="ml-1.5">Start agent session</span>
						</Button>
					) : null}
					{offersResumeOfPreviousConversation ? (
						<Button
							size="sm"
							variant="default"
							disabled={isRefreshing}
							onClick={() => {
								void onRefreshTerminal();
							}}
						>
							{isRefreshing ? <Spinner size={12} /> : <RotateCcw size={12} />}
							<span className="ml-1.5">Restart terminal session</span>
						</Button>
					) : null}
				</div>
			) : null}
		</div>
	);
}

// 工具条上那两个长得很像、语义却天差地别的按钮，成对抽出来共用。
//
// 抽出来的**唯一目的**是杜绝漏改：这两个按钮在本文件里要渲染两遍（完整工具栏 / 紧凑头部），历史上就是
// 同一段 JSX 抄了两份，改一处忘另一处，于是「打开会话工具栏时看到的还是旧行为」。两处的差别只有
// iconSize 与 variant，行为必须逐字一致，所以差别做成参数、行为只写一遍。
//
// 两个动作的分工：
// - Resync：只把画面从服务端 mirror 重画一遍，**不碰 agent 进程**。TUI 冻住绝大多数时候坏的是 viewer 这条
//   通路，不是 agent，所以它排在前面，是「屏幕不动了」的第一顺位解法。
// - Restart：杀掉 agent 进程再从磁盘 transcript 续跑。它会丢掉当前这一轮（还没落盘），所以在活跃回合里
//   先弹确认。
function TerminalViewResyncAndAgentSessionRestartButtons({
	showAgentSessionRestartButton,
	canRestartAgentSession,
	isRestartingAgentSession,
	isResyncingTerminalView,
	isAgentSessionInActiveTurn,
	onResyncTerminalView,
	onRestartAgentSession,
	iconSize,
	variant,
}: {
	showAgentSessionRestartButton: boolean;
	canRestartAgentSession: boolean;
	isRestartingAgentSession: boolean;
	isResyncingTerminalView: boolean;
	isAgentSessionInActiveTurn: boolean;
	onResyncTerminalView: () => Promise<void>;
	onRestartAgentSession: () => Promise<void>;
	iconSize: number;
	variant: "default" | "ghost";
}): ReactElement {
	const [isRestartConfirmOpen, setIsRestartConfirmOpen] = useState(false);
	return (
		<>
			{/* 门控**刻意**与重启按钮不同：resync 不需要看板卡片、不调 tRPC、纯 WebSocket，所以合成 shell
			    会话（__home_ / __detail_terminal__）同样能用——那边一样会遇到「屏幕冻住」。
			    showAgentSessionRestartButton 那条排除只适用于「重启 agent 会话」。 */}
			<Tooltip side="top" content="Resync the terminal view from the server (does not touch the agent process)">
				<Button
					icon={isResyncingTerminalView ? <Spinner size={iconSize} /> : <RefreshCw size={iconSize} />}
					variant={variant}
					size="sm"
					onClick={() => {
						void onResyncTerminalView();
					}}
					disabled={isResyncingTerminalView}
					aria-label="Resync terminal view"
				/>
			</Tooltip>
			{showAgentSessionRestartButton ? (
				<Tooltip
					side="top"
					content="Restart this agent session — kills the agent process and resumes it from its transcript"
				>
					<Button
						icon={isRestartingAgentSession ? <Spinner size={iconSize} /> : <RotateCcw size={iconSize} />}
						variant={variant}
						size="sm"
						onClick={() => {
							// 活跃回合里重启会丢掉正在跑的这一轮，先问一句；空闲时不打扰。
							if (isAgentSessionInActiveTurn) {
								setIsRestartConfirmOpen(true);
								return;
							}
							void onRestartAgentSession();
						}}
						disabled={!canRestartAgentSession || isRestartingAgentSession}
						aria-label="Restart agent session"
					/>
				</Tooltip>
			) : null}
			<AlertDialog
				open={isRestartConfirmOpen}
				onOpenChange={(isOpen) => {
					if (!isOpen) {
						setIsRestartConfirmOpen(false);
					}
				}}
			>
				<AlertDialogHeader>
					<AlertDialogTitle>Restart this agent session?</AlertDialogTitle>
				</AlertDialogHeader>
				<AlertDialogBody>
					<AlertDialogDescription>
						The agent process will be killed and immediately restarted, resuming the conversation from its on-disk
						transcript. Whatever it is working on right now is lost — the in-flight turn has not been written to
						that transcript yet. If the terminal is merely frozen, use “Resync terminal view” instead: it repaints
						the screen without touching the agent.
					</AlertDialogDescription>
				</AlertDialogBody>
				<AlertDialogFooter>
					<AlertDialogCancel asChild>
						<Button variant="default" onClick={() => setIsRestartConfirmOpen(false)}>
							Cancel
						</Button>
					</AlertDialogCancel>
					<AlertDialogAction asChild>
						<Button
							variant="danger"
							onClick={() => {
								setIsRestartConfirmOpen(false);
								void onRestartAgentSession();
							}}
						>
							Restart session
						</Button>
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialog>
		</>
	);
}

// Mirror the backend stall probe threshold (src/terminal/session-manager.ts).
// We don't take an action — just surface the dwell time so users can decide.
const STALL_HINT_THRESHOLD_MS = 45_000;
const STALL_HINT_TICK_MS = 5_000;

function useStallElapsedMs(summary: RuntimeTaskSessionSummary | null): number | null {
	const [now, setNow] = useState<number>(() => Date.now());
	// 门控由 legacy `state==="running"` 翻为 facet `turnOwner==="agent"`（二者等价）；stall 仅在 agent 回合计时。
	const isAgentTurn = summary ? resolveSessionFacets(summary).turnOwner === "agent" : false;
	useEffect(() => {
		if (!isAgentTurn) {
			return;
		}
		const timer = window.setInterval(() => {
			setNow(Date.now());
		}, STALL_HINT_TICK_MS);
		return () => {
			window.clearInterval(timer);
		};
	}, [isAgentTurn]);
	if (!isAgentTurn || !summary) {
		return null;
	}
	const baseline = summary.lastOutputAt ?? summary.startedAt;
	if (!baseline) {
		return null;
	}
	const elapsed = now - baseline;
	return elapsed >= STALL_HINT_THRESHOLD_MS ? elapsed : null;
}

function formatSearchResultLabel(query: string, results: TerminalSearchResultState): string {
	if (!query.trim()) {
		return "";
	}
	if (results.resultCount === 0) {
		return "No results";
	}
	if (results.resultIndex < 0) {
		return `${results.resultCount}+`;
	}
	return `${results.resultIndex + 1}/${results.resultCount}`;
}

function isTerminalFindShortcut(event: KeyboardEvent<HTMLInputElement>): boolean {
	const isFindModifier = isMacPlatform ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
	return isFindModifier && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f";
}

/**
 * 「阅读模式」开关。桌面与移动端共用同一个入口 —— 长 transcript 在宽屏上同样值得用可选中、
 * 可按屏宽重排的文档视图来读，而不是只在小屏才有价值。
 */
function TerminalTranscriptReaderToggleButton({
	isOpen,
	onToggle,
	iconSize,
	variant,
}: {
	isOpen: boolean;
	onToggle: () => void;
	iconSize: number;
	variant: "default" | "ghost";
}): ReactElement {
	return (
		<Tooltip side="top" content={isOpen ? "Back to the live terminal" : "Read the transcript as a document"}>
			<Button
				icon={isOpen ? <TerminalSquare size={iconSize} /> : <ScrollText size={iconSize} />}
				variant={isOpen ? "primary" : variant}
				size="sm"
				onClick={onToggle}
				aria-label={isOpen ? "Back to the live terminal" : "Read the transcript as a document"}
				aria-pressed={isOpen}
			/>
		</Tooltip>
	);
}

function TerminalSearchBar({
	isOpen,
	openRequestKey,
	results,
	onClose,
	onNext,
	onPrevious,
}: {
	isOpen: boolean;
	openRequestKey: number;
	results: TerminalSearchResultState;
	onClose: () => void;
	onNext: (query: string, options?: { caseSensitive?: boolean }) => boolean;
	onPrevious: (query: string, options?: { caseSensitive?: boolean }) => boolean;
}): ReactElement | null {
	const inputRef = useRef<HTMLInputElement | null>(null);
	const [query, setQuery] = useState("");
	const [caseSensitive, setCaseSensitive] = useState(false);
	const trimmedQuery = query.trim();
	const resultLabel = formatSearchResultLabel(query, results);
	const hasQuery = trimmedQuery.length > 0;

	useEffect(() => {
		if (!isOpen) {
			return;
		}
		window.requestAnimationFrame(() => {
			inputRef.current?.focus();
			inputRef.current?.select();
		});
	}, [isOpen, openRequestKey]);

	useEffect(() => {
		if (!isOpen) {
			return;
		}
		onNext(query, { caseSensitive });
	}, [caseSensitive, isOpen, onNext, query]);

	if (!isOpen) {
		return null;
	}

	const handleQueryChange = (event: ChangeEvent<HTMLInputElement>) => {
		const nextQuery = event.target.value;
		setQuery(nextQuery);
	};

	const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		// 输入法组字期间，按键属于输入法本身（上屏字符原文、翻候选页、取消组字），处理器必须整体让开。
		if (isKeyboardEventEmittedDuringImeComposition(event)) {
			return;
		}
		if (isTerminalFindShortcut(event)) {
			event.preventDefault();
			event.stopPropagation();
			inputRef.current?.focus();
			inputRef.current?.select();
			return;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			onClose();
			return;
		}
		if (event.key === "Enter") {
			event.preventDefault();
			event.stopPropagation();
			if (event.shiftKey) {
				onPrevious(query, { caseSensitive });
				return;
			}
			onNext(query, { caseSensitive });
		}
	};

	return (
		<div className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-surface-1 px-2">
			<Search size={14} className="shrink-0 text-text-tertiary" />
			<input
				ref={inputRef}
				value={query}
				onChange={handleQueryChange}
				onKeyDown={handleKeyDown}
				placeholder="Find in terminal"
				className="h-7 min-w-0 flex-1 rounded-md border border-border bg-surface-2 px-2 text-xs text-text-primary outline-none placeholder:text-text-tertiary focus:border-border-focus"
				aria-label="Find in terminal"
			/>
			<span className="w-16 shrink-0 text-right text-[11px] text-text-secondary" aria-live="polite">
				{resultLabel}
			</span>
			<Tooltip content="Match case">
				<Button
					icon={<CaseSensitive size={14} />}
					variant="ghost"
					size="sm"
					className={cn(caseSensitive && "bg-surface-3 text-text-primary")}
					onClick={() => {
						setCaseSensitive((current) => !current);
					}}
					aria-label="Match case"
					aria-pressed={caseSensitive}
				/>
			</Tooltip>
			<Tooltip content="Previous match">
				<Button
					icon={<ArrowUp size={14} />}
					variant="ghost"
					size="sm"
					onClick={() => onPrevious(query, { caseSensitive })}
					disabled={!hasQuery}
					aria-label="Previous match"
				/>
			</Tooltip>
			<Tooltip content="Next match">
				<Button
					icon={<ArrowDown size={14} />}
					variant="ghost"
					size="sm"
					onClick={() => onNext(query, { caseSensitive })}
					disabled={!hasQuery}
					aria-label="Next match"
				/>
			</Tooltip>
			<Tooltip content="Close search">
				<Button icon={<X size={14} />} variant="ghost" size="sm" onClick={onClose} aria-label="Close search" />
			</Tooltip>
		</div>
	);
}

function AgentTerminalReviewActions({
	taskId,
	taskColumnId,
	onCommit,
	onOpenPr,
	isCommitLoading,
	isOpenPrLoading,
}: {
	taskId: string;
	taskColumnId: string;
	onCommit?: () => void;
	onOpenPr?: () => void;
	isCommitLoading: boolean;
	isOpenPrLoading: boolean;
}): ReactElement | null {
	const reviewWorkspaceSnapshot = useTaskWorkspaceSnapshotValue(taskId);
	const showReviewGitActions = taskColumnId === "review" && (reviewWorkspaceSnapshot?.changedFiles ?? 0) > 0;

	if (!showReviewGitActions) {
		return null;
	}

	return (
		<div style={{ display: "flex", gap: 6 }}>
			<Button
				variant="primary"
				size="sm"
				style={{ flex: "1 1 0" }}
				disabled={isCommitLoading || isOpenPrLoading}
				onClick={onCommit}
			>
				{isCommitLoading ? "..." : "Commit"}
			</Button>
			<Button
				variant="primary"
				size="sm"
				style={{ flex: "1 1 0" }}
				disabled={isCommitLoading || isOpenPrLoading}
				onClick={onOpenPr}
			>
				{isOpenPrLoading ? "..." : "Open PR"}
			</Button>
		</div>
	);
}

function AgentTerminalPanelLayout({
	taskId,
	workspaceId,
	summary,
	onSummary: _onSummary,
	onCommit,
	onOpenPr,
	isCommitLoading = false,
	isOpenPrLoading = false,
	taskColumnId = "in_progress",
	onMoveToTrash,
	isMoveToTrashLoading = false,
	onMoveToValidation,
	isMoveToValidationLoading = false,
	onCancelAutomaticAction,
	cancelAutomaticActionLabel,
	showMoveToTrash,
	showMoveToValidation,
	showSessionToolbar = true,
	onClose,
	autoFocus: _autoFocus = false,
	agentEntryKeyboardFocusRequestKey: _agentEntryKeyboardFocusRequestKey,
	isMountedInsideAdjacentTaskCardNavigationHotkeyOwnerView:
		_isMountedInsideAdjacentTaskCardNavigationHotkeyOwnerView = false,
	minimalHeaderTitle = "Terminal",
	minimalHeaderSubtitle = null,
	taskAgentSessionLaunchHistoryEvidence,
	onStartTaskAgentSessionWithTaskPrompt,
	panelBackgroundColor = "var(--color-surface-1)",
	terminalBackgroundColor = "var(--color-surface-1)",
	cursorColor: _cursorColor = "var(--color-text-primary)",
	isVisible: _isVisible = true,
	onConnectionReady: _onConnectionReady,
	agentCommand,
	onSendAgentCommand,
	isExpanded = false,
	onToggleExpand,
	originalTaskPromptForFreshStart = null,
	onStartFreshAgentSessionWithOriginalTaskPrompt,
	sessionControls,
}: AgentTerminalPanelProps & { sessionControls: AgentTerminalSessionControls }): ReactElement {
	const {
		containerRef,
		lastError,
		hasRenderedAnyTerminalContent,
		isStopping,
		isRefreshing,
		isResyncingTerminalView,
		automaticStaleSessionResumePhase,
		isSearchOpen,
		searchOpenRequestKey,
		searchResults,
		clearTerminal,
		closeTerminalSearch,
		findNextInTerminal,
		findPreviousInTerminal,
		openTerminalSearch,
		refreshTerminal,
		adoptExistingAgentConversationAndResume,
		forceStopHarnessBackgroundSessionAndResumeHere,
		resyncTerminalView,
		scrollTerminalToLatest,
		stopTerminal,
		isScrolledAwayFromLatest,
	} = sessionControls;
	// canStop 由 legacy `state∈{running,awaiting_review}` 翻为 facet 活跃回合判据（isSessionInActiveTurn 与之等价）。
	const sessionFacets = summary ? resolveSessionFacets(summary) : null;
	const canStop = sessionFacets ? isSessionInActiveTurn(sessionFacets) : false;
	// channel B（distinction ②）：终端 agent 进程已退、任务仍等你审 → liveness==="exited"。面板顶端给一条
	// muted 提示，解释「终端为何不再更新/冻结」。Cline SDK 在进程内运行、恒 live，永不进此分支。
	const isStreamClosed = sessionFacets?.liveness === "exited";
	const isSyntheticHomeSession = taskId.startsWith("__home_");
	// 合成 shell 终端（home / detail shell）不是 agent TUI，不需要代按 Ctrl+C / 方向键 / double-ESC。
	const isSyntheticShellSession = isSyntheticHomeSession || taskId.startsWith("__detail_terminal__:");
	// detail shell 同样不是 agent 会话，「重启 agent 会话」对它没有意义（服务端也会以「找不到卡片」拒绝）。
	// 只挡重启：旁边那个「重新同步画面」纯走 WebSocket、不需要卡片，合成 shell 冻住时照样要能救。
	const showRefreshButton = !isSyntheticShellSession;
	// **不**要求 summary.agentId 已知。渲染到这个面板本身就已经由 card-detail-view 判定过「这是个 PTY
	// agent 会话」，而 agentId 恰恰是硬中断后最容易丢的字段——一旦把「不知道用的哪个 agent」当成禁用理由，
	// 用户拿到的就是一个既全白、又点不动的面板，也就是这个按钮本该解决的那个故障本身。
	// 只在这条会话**确实跑在非 PTY 通道**上时才禁用；与服务端 refreshTaskTerminal 的判据对齐。
	// 判据读会话盖的通道章而不是 agentId：omp 有 TUI / ACP 两条通道，agentId 版谓词只认得它的
	// catalog 默认，会把一条 ACP 会话当成可刷新的 PTY 会话。summary 缺席（会话已经没了）时按
	// 「不知道 ⇒ 不禁用」放行，正是这个按钮存在的场景。
	// 本标签页对这张卡的启动请求还在路上（建 worktree / 启动 RPC）。此时「重启 agent 会话」会和这次启动抢
	// 同一把 per-task 闸门：refresh 先进闸就把原 prompt 折叠掉永不送达，启动先进闸就被 refresh 当场杀掉。
	const startRequestInFlightPhase = useTaskAgentSessionStartRequestInFlightPhase(workspaceId, taskId);
	// 同理，打开任务时的陈旧会话自动续跑在路上（等停留时长 / 请求在途）时也不给重启：日志里有过续跑 6 秒后
	// 用户点重启、把刚起的进程杀掉重来的实例——那几秒里屏幕上没有任何迹象表明续跑已经在路上。
	const isAutomaticStaleSessionResumeInProgress = automaticStaleSessionResumePhase !== null;
	const canRefresh =
		showRefreshButton &&
		!isRuntimeAgentSessionSummaryRenderedAsConversationPanel(summary) &&
		startRequestInFlightPhase === null &&
		!isAutomaticStaleSessionResumeInProgress;
	const showCompactHeader = !showSessionToolbar;
	const isMobile = useIsMobile();
	const [isTranscriptReaderOpen, setIsTranscriptReaderOpen] = useState(false);
	const showVirtualKeyInputBar = isMobile && !isSyntheticShellSession;
	// 终端一片空白且没有任何回合在跑：给出解释与出路，而不是留一块纯白的 div 让用户猜是加载慢还是坏了。
	// 来历不止一种（正在启动 / 启动失败 / 被回收 / 从没启动过 / 随运行时没了），见 classifyEmptyTerminalSessionCause。
	// 合成 shell 排除在外：它本来就可能长时间没有输出，且没有「agent 会话」可重启。
	const showEmptyTerminalRecoveryState =
		!hasRenderedAnyTerminalContent && !isSyntheticShellSession && !isTranscriptReaderOpen && !canStop;
	const emptyTerminalSessionCause = useMemo(
		() =>
			classifyEmptyTerminalSessionCause({
				summary,
				startRequestInFlightPhase,
				taskAgentSessionLaunchHistoryEvidence,
				automaticStaleSessionResumePhase,
			}),
		[summary, startRequestInFlightPhase, taskAgentSessionLaunchHistoryEvidence, automaticStaleSessionResumePhase],
	);
	const statusLabel = useMemo(() => describeState(summary), [summary]);
	const statusTagStyle = useMemo(() => getStateTagStyle(summary), [summary]);
	const stallElapsedMs = useStallElapsedMs(summary);
	const agentLabel = useMemo(() => {
		const normalizedCommand = agentCommand?.trim();
		if (!normalizedCommand) {
			return null;
		}
		return normalizedCommand.split(/\s+/)[0] ?? null;
	}, [agentCommand]);

	return (
		<div
			style={{
				display: "flex",
				flex: "1 1 0",
				flexDirection: "column",
				minWidth: 0,
				minHeight: 0,
				background: panelBackgroundColor,
			}}
		>
			{showSessionToolbar ? (
				<>
					<div
						style={{
							display: "flex",
							alignItems: "center",
							justifyContent: "space-between",
							gap: 8,
							padding: "8px 12px",
						}}
					>
						<div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
							<span
								className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${statusTagColors[statusTagStyle]}`}
							>
								{statusLabel}
							</span>
							{stallElapsedMs !== null ? (
								<span className="text-xs text-text-tertiary">
									No output for {Math.round(stallElapsedMs / 1000)}s
								</span>
							) : null}
						</div>
						<div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
							<TerminalTranscriptReaderToggleButton
								isOpen={isTranscriptReaderOpen}
								onToggle={() => setIsTranscriptReaderOpen((current) => !current)}
								iconSize={14}
								variant="default"
							/>
							<Tooltip side="top" content="Find in terminal">
								<Button
									icon={<Search size={14} />}
									variant="default"
									size="sm"
									onClick={openTerminalSearch}
									aria-label="Find in terminal"
								/>
							</Tooltip>
							<TerminalViewResyncAndAgentSessionRestartButtons
								showAgentSessionRestartButton={showRefreshButton}
								canRestartAgentSession={canRefresh}
								isRestartingAgentSession={isRefreshing}
								isResyncingTerminalView={isResyncingTerminalView}
								isAgentSessionInActiveTurn={canStop}
								onResyncTerminalView={resyncTerminalView}
								onRestartAgentSession={refreshTerminal}
								iconSize={14}
								variant="default"
							/>
							<AgentSessionTransportSwitchButton
								workspaceId={workspaceId}
								taskId={taskId}
								agentId={summary?.agentId ?? null}
								currentSessionTransport="pty_terminal"
								iconSize={14}
								variant="default"
							/>
							<Button variant="default" size="sm" onClick={clearTerminal}>
								Clear
							</Button>
							<Button
								variant="default"
								size="sm"
								onClick={() => {
									void stopTerminal();
								}}
								disabled={!canStop || isStopping}
							>
								Stop
							</Button>
						</div>
					</div>
					<div className="h-px bg-border" />
				</>
			) : showCompactHeader ? (
				<div
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						gap: 8,
						padding: "6px 0 0 3px",
					}}
				>
					<div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
						<span className="text-text-secondary" style={{ fontSize: 12 }}>
							{minimalHeaderTitle}
						</span>
						{minimalHeaderSubtitle ? (
							<span
								className="truncate font-mono text-text-secondary"
								style={{ fontSize: 10 }}
								title={minimalHeaderSubtitle}
							>
								{minimalHeaderSubtitle}
							</span>
						) : null}
						{stallElapsedMs !== null ? (
							<span className="whitespace-nowrap text-text-tertiary" style={{ fontSize: 10 }}>
								No output for {Math.round(stallElapsedMs / 1000)}s
							</span>
						) : null}
					</div>
					<div style={{ display: "flex", alignItems: "center", gap: 2, marginRight: "-6px" }}>
						<TerminalTranscriptReaderToggleButton
							isOpen={isTranscriptReaderOpen}
							onToggle={() => setIsTranscriptReaderOpen((current) => !current)}
							iconSize={12}
							variant="ghost"
						/>
						<Tooltip side="top" content="Find in terminal">
							<Button
								icon={<Search size={12} />}
								variant="ghost"
								size="sm"
								onClick={openTerminalSearch}
								aria-label="Find in terminal"
							/>
						</Tooltip>
						<TerminalViewResyncAndAgentSessionRestartButtons
							showAgentSessionRestartButton={showRefreshButton}
							canRestartAgentSession={canRefresh}
							isRestartingAgentSession={isRefreshing}
							isResyncingTerminalView={isResyncingTerminalView}
							isAgentSessionInActiveTurn={canStop}
							onResyncTerminalView={resyncTerminalView}
							onRestartAgentSession={refreshTerminal}
							iconSize={12}
							variant="ghost"
						/>
						{agentLabel && onSendAgentCommand ? (
							<Tooltip side="top" content={`Run ${agentLabel}`}>
								<Button
									icon={<MessageSquare size={12} />}
									variant="ghost"
									size="sm"
									onClick={onSendAgentCommand}
									aria-label={`Run ${agentLabel}`}
								/>
							</Tooltip>
						) : null}
						{onToggleExpand ? (
							<Tooltip
								side="top"
								content={
									<span style={{ display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
										<span>{isExpanded ? "Collapse" : "Expand"}</span>
										<span
											style={{ display: "inline-flex", alignItems: "center", gap: 2, whiteSpace: "nowrap" }}
										>
											<span>(</span>
											{isMacPlatform ? <Command size={11} /> : <span style={{ fontSize: 11 }}>Ctrl</span>}
											<span>+ M)</span>
										</span>
									</span>
								}
							>
								<Button
									icon={isExpanded ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
									variant="ghost"
									size="sm"
									onClick={onToggleExpand}
									aria-label={isExpanded ? "Collapse terminal" : "Expand terminal"}
								/>
							</Tooltip>
						) : null}
						{onClose ? (
							<Button
								icon={<X size={14} />}
								variant="ghost"
								size="sm"
								onClick={onClose}
								aria-label="Close terminal"
							/>
						) : null}
					</div>
				</div>
			) : null}
			<TerminalSearchBar
				isOpen={isSearchOpen}
				openRequestKey={searchOpenRequestKey}
				results={searchResults}
				onClose={closeTerminalSearch}
				onNext={findNextInTerminal}
				onPrevious={findPreviousInTerminal}
			/>
			{isAutomaticStaleSessionResumeInProgress ? (
				<div className="flex items-center gap-1.5 border-t border-border bg-surface-2 px-3 py-1.5 text-xs text-text-tertiary">
					<Spinner size={12} />
					<span>Resuming the previous conversation…</span>
				</div>
			) : isStreamClosed ? (
				<div className="flex items-center gap-1.5 border-t border-border bg-surface-2 px-3 py-1.5 text-xs text-text-tertiary">
					<Unplug size={12} className="shrink-0" />
					<span>{describeTerminalStreamClosedBanner(summary)}</span>
				</div>
			) : null}
			{canRefresh ? (
				<AgentNativeConversationPersistenceRecoveryNotice
					summary={summary}
					workspaceId={workspaceId}
					originalTaskPromptForFreshStart={originalTaskPromptForFreshStart}
					isRestartingAgentSession={isRefreshing}
					onStartFreshAgentSessionWithOriginalTaskPrompt={onStartFreshAgentSessionWithOriginalTaskPrompt}
					onAdoptExistingAgentConversationAndResume={adoptExistingAgentConversationAndResume}
				/>
			) : null}
			{canRefresh ? (
				<AgentConversationHeldByHarnessBackgroundSessionNotice
					summary={summary}
					isRestartingAgentSession={isRefreshing}
					onForceStopHarnessBackgroundSessionAndResumeHere={forceStopHarnessBackgroundSessionAndResumeHere}
				/>
			) : null}
			{/* 阅读模式是叠加而非替换：xterm 始终挂载、PTY 继续跑、输出继续进 buffer（xterm 的渲染
			    挂起只由整个浏览器标签页的 visibilitychange 驱动，不看元素是否可见），所以两种模式
			    可以随时来回切且切回时没有积压回放。阅读视图读的也正是这同一个 buffer。 */}
			<div
				style={{
					position: "relative",
					flex: "1 1 0",
					minHeight: 0,
					overflow: "hidden",
					padding: "3px 1.5px 3px 3px",
				}}
			>
				<div
					ref={containerRef}
					className="kb-terminal-container"
					style={{ height: "100%", width: "100%", background: terminalBackgroundColor }}
				/>
				{isTranscriptReaderOpen ? null : (
					<TerminalScrollToLatestButton
						isScrolledAwayFromLatest={isScrolledAwayFromLatest}
						onScrollToLatest={scrollTerminalToLatest}
					/>
				)}
				{isTranscriptReaderOpen ? (
					<div className="absolute inset-0 z-10 flex">
						<TerminalScrollbackTranscriptReaderPanel taskId={taskId} isVisible />
					</div>
				) : null}
				{showEmptyTerminalRecoveryState ? (
					<div className="absolute inset-0 z-10 flex items-center justify-center p-6">
						<AgentTerminalEmptySessionRecoveryNotice
							cause={emptyTerminalSessionCause}
							canRefresh={canRefresh}
							isRefreshing={isRefreshing}
							onRefreshTerminal={refreshTerminal}
							onStartTaskAgentSessionWithTaskPrompt={onStartTaskAgentSessionWithTaskPrompt}
						/>
					</div>
				) : null}
			</div>
			{showVirtualKeyInputBar ? <TerminalVirtualKeyInputBar taskId={taskId} /> : null}
			{lastError ? (
				<div className="flex gap-2 rounded-none border-t border-status-red/30 bg-status-red/10 p-3 text-[13px] text-status-red">
					{lastError}
				</div>
			) : null}
			{(showMoveToTrash && onMoveToTrash) || (showMoveToValidation && onMoveToValidation) ? (
				<div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "8px 12px" }}>
					<AgentTerminalReviewActions
						taskId={taskId}
						taskColumnId={taskColumnId}
						onCommit={onCommit}
						onOpenPr={onOpenPr}
						isCommitLoading={isCommitLoading}
						isOpenPrLoading={isOpenPrLoading}
					/>
					{cancelAutomaticActionLabel && onCancelAutomaticAction ? (
						<Button variant="default" fill onClick={onCancelAutomaticAction}>
							{cancelAutomaticActionLabel}
						</Button>
					) : null}
					{showMoveToValidation && onMoveToValidation ? (
						<Button variant="primary" fill disabled={isMoveToValidationLoading} onClick={onMoveToValidation}>
							{isMoveToValidationLoading ? <Spinner size={14} /> : "Move Card To Validation"}
						</Button>
					) : null}
					{showMoveToTrash && onMoveToTrash ? (
						<Button variant="danger" fill disabled={isMoveToTrashLoading} onClick={onMoveToTrash}>
							{isMoveToTrashLoading ? <Spinner size={14} /> : "Move Card To Done"}
						</Button>
					) : null}
				</div>
			) : null}
		</div>
	);
}

export function AgentTerminalPanel(props: AgentTerminalPanelProps): ReactElement {
	// enabled gates whether this panel should keep a live persistent terminal connection.
	// We disable it for non-active task contexts so backlog and trash views do not keep extra websocket sockets open.
	const sessionControls = usePersistentTerminalSession({
		taskId: props.taskId,
		workspaceId: props.workspaceId,
		enabled: props.terminalEnabled ?? true,
		onSummary: props.onSummary,
		onConnectionReady: props.onConnectionReady,
		autoFocus: props.autoFocus,
		agentEntryKeyboardFocusRequestKey: props.agentEntryKeyboardFocusRequestKey,
		isMountedInsideAdjacentTaskCardNavigationHotkeyOwnerView:
			props.isMountedInsideAdjacentTaskCardNavigationHotkeyOwnerView,
		isVisible: props.isVisible,
		sessionStartedAt: props.summary?.startedAt ?? null,
		terminalBackgroundColor: props.terminalBackgroundColor ?? "var(--color-surface-1)",
		cursorColor: props.cursorColor ?? "var(--color-text-primary)",
	});

	return <AgentTerminalPanelLayout {...props} sessionControls={sessionControls} />;
}
