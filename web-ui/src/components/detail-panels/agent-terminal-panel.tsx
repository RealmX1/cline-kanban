import { isRuntimeAgentSessionRenderedAsConversationPanel } from "@runtime-agent-catalog";
import "@xterm/xterm/css/xterm.css";

import { isSessionInActiveTurn, resolveSessionFacets } from "@runtime-session-activity";
import {
	ArrowDown,
	ArrowUp,
	CaseSensitive,
	Command,
	Maximize2,
	MessageSquare,
	Minimize2,
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
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-is-mobile";

import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { useTaskWorkspaceSnapshotValue } from "@/stores/workspace-metadata-store";
import type { TerminalSearchResultState } from "@/terminal/persistent-terminal-manager";
import { usePersistentTerminalSession } from "@/terminal/use-persistent-terminal-session";
import { isMacPlatform } from "@/utils/platform";

interface AgentTerminalSessionControls {
	clearTerminal: () => void;
	containerRef: MutableRefObject<HTMLDivElement | null>;
	hasRenderedAnyTerminalContent: boolean;
	isStopping: boolean;
	isRefreshing: boolean;
	isSearchOpen: boolean;
	isScrolledAwayFromLatest: boolean;
	lastError: string | null;
	searchOpenRequestKey: number;
	searchResults: TerminalSearchResultState;
	stopTerminal: () => Promise<void>;
	refreshTerminal: () => Promise<void>;
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
	minimalHeaderTitle?: string;
	minimalHeaderSubtitle?: string | null;
	panelBackgroundColor?: string;
	terminalBackgroundColor?: string;
	cursorColor?: string;
	isVisible?: boolean;
	onConnectionReady?: (taskId: string) => void;
	agentCommand?: string | null;
	onSendAgentCommand?: () => void;
	isExpanded?: boolean;
	onToggleExpand?: () => void;
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
function describeEmptyTerminalSessionCause(summary: RuntimeTaskSessionSummary | null): {
	headline: string;
	detail: string;
} {
	const reclamationOutcome = summary?.agentSessionRuntimeReclamationOutcome;
	if (reclamationOutcome) {
		return {
			headline:
				reclamationOutcome.reclamationTrigger === "park_abandoned"
					? "This session was reclaimed after waiting too long on dispatched background work."
					: "This session was reclaimed after sitting idle past its retention window.",
			detail: "Its conversation is still on disk. Restarting resumes it in the same worktree.",
		};
	}
	return {
		headline: "This session is no longer running.",
		detail:
			"It most likely ended with the previous runtime — a machine restart or a local redeploy. " +
			"Its conversation is still on disk. Restarting resumes it in the same worktree.",
	};
}

function AgentTerminalEmptySessionRecoveryNotice({
	summary,
	canRefresh,
	isRefreshing,
	onRefreshTerminal,
}: {
	summary: RuntimeTaskSessionSummary | null;
	canRefresh: boolean;
	isRefreshing: boolean;
	onRefreshTerminal: () => Promise<void>;
}): ReactElement {
	const { headline, detail } = describeEmptyTerminalSessionCause(summary);
	return (
		<div className="flex max-w-md flex-col items-center gap-3 rounded-md border border-border-subtle bg-surface-2 p-5 text-center">
			<Unplug size={18} className="text-text-secondary" />
			<div className="text-[13px] font-medium text-text-primary">{headline}</div>
			<div className="text-[12px] leading-relaxed text-text-secondary">{detail}</div>
			{canRefresh ? (
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
	minimalHeaderTitle = "Terminal",
	minimalHeaderSubtitle = null,
	panelBackgroundColor = "var(--color-surface-1)",
	terminalBackgroundColor = "var(--color-surface-1)",
	cursorColor: _cursorColor = "var(--color-text-primary)",
	isVisible: _isVisible = true,
	onConnectionReady: _onConnectionReady,
	agentCommand,
	onSendAgentCommand,
	isExpanded = false,
	onToggleExpand,
	sessionControls,
}: AgentTerminalPanelProps & { sessionControls: AgentTerminalSessionControls }): ReactElement {
	const {
		containerRef,
		lastError,
		hasRenderedAnyTerminalContent,
		isStopping,
		isRefreshing,
		isSearchOpen,
		searchOpenRequestKey,
		searchResults,
		clearTerminal,
		closeTerminalSearch,
		findNextInTerminal,
		findPreviousInTerminal,
		openTerminalSearch,
		refreshTerminal,
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
	// detail shell 同样不是 agent 会话，「重启终端会话」对它没有意义（服务端也会以「找不到卡片」拒绝）。
	const showRefreshButton = !isSyntheticShellSession;
	// **不**要求 summary.agentId 已知。渲染到这个面板本身就已经由 card-detail-view 判定过「这是个 PTY
	// agent 会话」，而 agentId 恰恰是硬中断后最容易丢的字段——一旦把「不知道用的哪个 agent」当成禁用理由，
	// 用户拿到的就是一个既全白、又点不动的面板，也就是这个按钮本该解决的那个故障本身。
	// 只在 agentId **已知且**确属对话面板 agent（Cline）时才禁用；与服务端 refreshTaskTerminal 的判据对齐。
	const canRefresh =
		showRefreshButton &&
		(summary?.agentId == null || !isRuntimeAgentSessionRenderedAsConversationPanel(summary.agentId));
	const showCompactHeader = !showSessionToolbar;
	const isMobile = useIsMobile();
	const [isTranscriptReaderOpen, setIsTranscriptReaderOpen] = useState(false);
	const showVirtualKeyInputBar = isMobile && !isSyntheticShellSession;
	// 终端一片空白且没有任何回合在跑 —— 这正是「会话随运行时一起没了」的样子。给出解释与出路，
	// 而不是留一块纯白的 div 让用户猜是加载慢还是坏了。
	// 合成 shell 排除在外：它本来就可能长时间没有输出，且没有「agent 会话」可重启。
	const showEmptyTerminalRecoveryState =
		!hasRenderedAnyTerminalContent && !isSyntheticShellSession && !isTranscriptReaderOpen && !canStop;
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
							{showRefreshButton ? (
								<Tooltip side="top" content="Restart this terminal session (recovers from a frozen TUI)">
									<Button
										icon={isRefreshing ? <Spinner size={14} /> : <RotateCcw size={14} />}
										variant="default"
										size="sm"
										onClick={() => {
											void refreshTerminal();
										}}
										disabled={!canRefresh || isRefreshing}
										aria-label="Refresh terminal session"
									/>
								</Tooltip>
							) : null}
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
						{showRefreshButton ? (
							<Tooltip side="top" content="Restart this terminal session (recovers from a frozen TUI)">
								<Button
									icon={isRefreshing ? <Spinner size={12} /> : <RotateCcw size={12} />}
									variant="ghost"
									size="sm"
									onClick={() => {
										void refreshTerminal();
									}}
									disabled={!canRefresh || isRefreshing}
									aria-label="Refresh terminal session"
								/>
							</Tooltip>
						) : null}
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
			{isStreamClosed ? (
				<div className="flex items-center gap-1.5 border-t border-border bg-surface-2 px-3 py-1.5 text-xs text-text-tertiary">
					<Unplug size={12} className="shrink-0" />
					<span>Terminal stream closed — the agent process has exited. The output above is final.</span>
				</div>
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
							summary={summary}
							canRefresh={canRefresh}
							isRefreshing={isRefreshing}
							onRefreshTerminal={refreshTerminal}
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
		isVisible: props.isVisible,
		sessionStartedAt: props.summary?.startedAt ?? null,
		terminalBackgroundColor: props.terminalBackgroundColor ?? "var(--color-surface-1)",
		cursorColor: props.cursorColor ?? "var(--color-text-primary)",
	});

	return <AgentTerminalPanelLayout {...props} sessionControls={sessionControls} />;
}
