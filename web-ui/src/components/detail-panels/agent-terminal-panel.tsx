import "@xterm/xterm/css/xterm.css";

import {
	ArrowDown,
	ArrowUp,
	CaseSensitive,
	Command,
	Maximize2,
	MessageSquare,
	Minimize2,
	RotateCcw,
	Search,
	X,
} from "lucide-react";
import type { ChangeEvent, KeyboardEvent, MutableRefObject, ReactElement } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { useTaskWorkspaceSnapshotValue } from "@/stores/workspace-metadata-store";
import type { TerminalSearchResultState } from "@/terminal/persistent-terminal-manager";
import { usePersistentTerminalSession } from "@/terminal/use-persistent-terminal-session";
import { isMacPlatform } from "@/utils/platform";

interface AgentTerminalSessionControls {
	clearTerminal: () => void;
	containerRef: MutableRefObject<HTMLDivElement | null>;
	isStopping: boolean;
	isRefreshing: boolean;
	isSearchOpen: boolean;
	lastError: string | null;
	searchOpenRequestKey: number;
	searchResults: TerminalSearchResultState;
	stopTerminal: () => Promise<void>;
	refreshTerminal: () => Promise<void>;
	closeTerminalSearch: () => void;
	findNextInTerminal: (query: string, options?: { caseSensitive?: boolean }) => boolean;
	findPreviousInTerminal: (query: string, options?: { caseSensitive?: boolean }) => boolean;
	openTerminalSearch: () => void;
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
	onCancelAutomaticAction?: () => void;
	cancelAutomaticActionLabel?: string | null;
	showMoveToTrash?: boolean;
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

function describeState(summary: RuntimeTaskSessionSummary | null): string {
	if (!summary) {
		return "No session yet";
	}
	if (summary.state === "running") {
		return "Running";
	}
	if (summary.state === "awaiting_review") {
		return "Ready for review";
	}
	if (summary.state === "interrupted") {
		return "Interrupted";
	}
	if (summary.state === "failed") {
		return "Failed";
	}
	return "Idle";
}

type StatusTagStyle = "neutral" | "success" | "warning" | "danger";

function getStateTagStyle(summary: RuntimeTaskSessionSummary | null): StatusTagStyle {
	if (!summary) {
		return "neutral";
	}
	if (summary.state === "running") {
		return "success";
	}
	if (summary.state === "awaiting_review") {
		return "warning";
	}
	if (summary.state === "interrupted" || summary.state === "failed") {
		return "danger";
	}
	return "neutral";
}

const statusTagColors: Record<StatusTagStyle, string> = {
	neutral: "bg-surface-3 text-text-secondary",
	success: "bg-status-green/15 text-status-green",
	warning: "bg-status-orange/15 text-status-orange",
	danger: "bg-status-red/15 text-status-red",
};

// Mirror the backend stall probe threshold (src/terminal/session-manager.ts).
// We don't take an action — just surface the dwell time so users can decide.
const STALL_HINT_THRESHOLD_MS = 45_000;
const STALL_HINT_TICK_MS = 5_000;

function useStallElapsedMs(summary: RuntimeTaskSessionSummary | null): number | null {
	const [now, setNow] = useState<number>(() => Date.now());
	const isRunning = summary?.state === "running";
	useEffect(() => {
		if (!isRunning) {
			return;
		}
		const timer = window.setInterval(() => {
			setNow(Date.now());
		}, STALL_HINT_TICK_MS);
		return () => {
			window.clearInterval(timer);
		};
	}, [isRunning]);
	if (!isRunning || !summary) {
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
	onCancelAutomaticAction,
	cancelAutomaticActionLabel,
	showMoveToTrash,
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
		stopTerminal,
	} = sessionControls;
	const canStop = summary?.state === "running" || summary?.state === "awaiting_review";
	const isSyntheticHomeSession = taskId.startsWith("__home_");
	const showRefreshButton = !isSyntheticHomeSession;
	const canRefresh = showRefreshButton && summary !== null && summary.agentId !== null && summary.agentId !== "cline";
	const showCompactHeader = !showSessionToolbar;
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
			<div style={{ flex: "1 1 0", minHeight: 0, overflow: "hidden", padding: "3px 1.5px 3px 3px" }}>
				<div
					ref={containerRef}
					className="kb-terminal-container"
					style={{ height: "100%", width: "100%", background: terminalBackgroundColor }}
				/>
			</div>
			{lastError ? (
				<div className="flex gap-2 rounded-none border-t border-status-red/30 bg-status-red/10 p-3 text-[13px] text-status-red">
					{lastError}
				</div>
			) : null}
			{showMoveToTrash && onMoveToTrash ? (
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
					<Button variant="danger" fill disabled={isMoveToTrashLoading} onClick={onMoveToTrash}>
						{isMoveToTrashLoading ? <Spinner size={14} /> : "Move Card To Done"}
					</Button>
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
