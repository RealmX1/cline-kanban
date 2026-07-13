import * as Popover from "@radix-ui/react-popover";
import { GitFork, History, LoaderCircle, RefreshCw, Search } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeAgentId,
	RuntimeAvailableAgentSessionSearchScope,
	RuntimeAvailableAgentSessionSummary,
	RuntimeTaskAgentSessionInitialization,
	RuntimeTaskAgentSessionInitializationReuseMode,
} from "@/runtime/types";

const SESSION_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function isSessionInitializableAgentId(
	agentId: RuntimeAgentId | null | undefined,
): agentId is RuntimeTaskAgentSessionInitialization["sourceAgentId"] {
	return agentId === "claude" || agentId === "codex" || agentId === "cursor";
}

export function TaskAgentSessionInitializationControl({
	agentId,
	defaultAgentId,
	workspaceId,
	value,
	onChange,
	onAgentIdChange,
}: {
	agentId: RuntimeAgentId | undefined;
	defaultAgentId: RuntimeAgentId | null | undefined;
	workspaceId: string | null;
	value: RuntimeTaskAgentSessionInitialization | undefined;
	onChange: (value: RuntimeTaskAgentSessionInitialization | undefined) => void;
	onAgentIdChange: (value: RuntimeAgentId | undefined) => void;
}): ReactElement | null {
	const effectiveAgentId = agentId ?? defaultAgentId;
	const initializableAgentId = isSessionInitializableAgentId(effectiveAgentId) ? effectiveAgentId : null;
	const sessionIdInputId = useId();
	const [sessionIdInputValue, setSessionIdInputValue] = useState(value?.sourceSessionId ?? "");
	const [showValidationError, setShowValidationError] = useState(false);
	const [isSessionBrowserOpen, setIsSessionBrowserOpen] = useState(false);
	const [sessionSearchScope, setSessionSearchScope] =
		useState<RuntimeAvailableAgentSessionSearchScope>("current_repository");
	const [sessionSearchQuery, setSessionSearchQuery] = useState("");
	const [availableSessions, setAvailableSessions] = useState<RuntimeAvailableAgentSessionSummary[]>([]);
	const [nextPageCursor, setNextPageCursor] = useState<number | null>(null);
	const [totalMatchingSessions, setTotalMatchingSessions] = useState(0);
	const [scanWarnings, setScanWarnings] = useState<string[]>([]);
	const [isLoadingSessions, setIsLoadingSessions] = useState(false);
	const [isLoadingMoreSessions, setIsLoadingMoreSessions] = useState(false);

	useEffect(() => {
		setSessionIdInputValue(value?.sourceSessionId ?? "");
	}, [value?.sourceSessionId]);

	useEffect(() => {
		if (value && value.sourceAgentId !== effectiveAgentId) {
			onChange(undefined);
			setSessionIdInputValue("");
			setShowValidationError(false);
		}
	}, [effectiveAgentId, onChange, value]);

	const loadAvailableSessions = useCallback(
		async ({
			pageCursor = 0,
			append = false,
			forceRefresh = false,
		}: {
			pageCursor?: number;
			append?: boolean;
			forceRefresh?: boolean;
		} = {}) => {
			if (!workspaceId || !initializableAgentId) {
				return;
			}
			append ? setIsLoadingMoreSessions(true) : setIsLoadingSessions(true);
			try {
				const response = await getRuntimeTrpcClient(workspaceId).runtime.getAvailableAgentSessions.query({
					agentId: initializableAgentId,
					searchScope: sessionSearchScope,
					query: sessionSearchQuery,
					pageCursor,
					pageSize: 50,
					forceRefresh,
				});
				setAvailableSessions((current) => (append ? [...current, ...response.sessions] : response.sessions));
				setNextPageCursor(response.nextPageCursor);
				setTotalMatchingSessions(response.totalMatchingSessions);
				setScanWarnings(response.scanWarnings);
			} catch (error) {
				setAvailableSessions([]);
				setNextPageCursor(null);
				setTotalMatchingSessions(0);
				setScanWarnings([error instanceof Error ? error.message : String(error)]);
			} finally {
				setIsLoadingSessions(false);
				setIsLoadingMoreSessions(false);
			}
		},
		[initializableAgentId, sessionSearchQuery, sessionSearchScope, workspaceId],
	);

	useEffect(() => {
		if (!isSessionBrowserOpen) {
			return;
		}
		const timeoutId = window.setTimeout(() => {
			void loadAvailableSessions();
		}, 200);
		return () => window.clearTimeout(timeoutId);
	}, [isSessionBrowserOpen, loadAvailableSessions]);

	if (!initializableAgentId) {
		return null;
	}

	const commitSessionId = (sourceSessionId: string, sourceSessionWorkingDirectoryPath?: string): void => {
		onAgentIdChange(initializableAgentId);
		onChange({
			sourceAgentId: initializableAgentId,
			sourceSessionId,
			sourceSessionReuseMode: value?.sourceSessionReuseMode ?? "resume_existing_session",
			...(sourceSessionWorkingDirectoryPath ? { sourceSessionWorkingDirectoryPath } : {}),
		});
		setShowValidationError(false);
	};

	const updateSessionId = (nextRawValue: string): void => {
		setSessionIdInputValue(nextRawValue);
		const sourceSessionId = nextRawValue.trim();
		if (!sourceSessionId) {
			onChange(undefined);
			setShowValidationError(false);
			return;
		}
		if (!SESSION_UUID_PATTERN.test(sourceSessionId)) {
			return;
		}
		commitSessionId(sourceSessionId);
	};

	const updateReuseMode = (sourceSessionReuseMode: RuntimeTaskAgentSessionInitializationReuseMode): void => {
		if (!value) {
			return;
		}
		onChange({ ...value, sourceSessionReuseMode });
	};

	const hasInvalidSessionId =
		sessionIdInputValue.trim().length > 0 && !SESSION_UUID_PATTERN.test(sessionIdInputValue.trim());

	return (
		<div className="rounded-md border border-border bg-surface-2/60 p-2.5">
			<div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-text-primary">
				<History size={14} className="text-text-secondary" />
				Initialize agent session
			</div>
			<div className="flex items-start gap-2 max-sm:flex-col">
				<div className="min-w-0 flex-1">
					<label htmlFor={sessionIdInputId} className="mb-1 block text-[11px] text-text-secondary">
						Session ID <span className="text-text-tertiary">(optional)</span>
					</label>
					<div className="flex min-w-0">
						<input
							id={sessionIdInputId}
							value={sessionIdInputValue}
							onChange={(event) => updateSessionId(event.currentTarget.value)}
							onBlur={() => setShowValidationError(hasInvalidSessionId)}
							placeholder="Leave blank to start a new session"
							spellCheck={false}
							aria-invalid={showValidationError && hasInvalidSessionId}
							className="h-8 min-w-0 flex-1 rounded-l-md border border-border-bright bg-surface-1 px-2.5 font-mono text-[12px] text-text-primary outline-none placeholder:text-text-secondary focus:z-10 focus:border-border-focus focus:ring-1 focus:ring-border-focus"
						/>
						<Popover.Root open={isSessionBrowserOpen} onOpenChange={setIsSessionBrowserOpen}>
							<Popover.Trigger asChild>
								<Button
									variant="default"
									size="sm"
									icon={<Search size={14} />}
									className="h-8 rounded-l-none border-l-0"
									aria-label="Browse available agent sessions"
								/>
							</Popover.Trigger>
							<Popover.Portal>
								<Popover.Content
									side="bottom"
									align="start"
									sideOffset={6}
									className="z-50 flex max-h-[min(520px,70vh)] w-[min(560px,calc(100vw-24px))] flex-col overflow-hidden rounded-lg border border-border-bright bg-surface-1 shadow-xl"
								>
									<div className="flex items-center gap-2 border-b border-border p-2">
										<div className="relative min-w-0 flex-1">
											<Search
												size={14}
												className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary"
											/>
											<input
												value={sessionSearchQuery}
												onChange={(event) => setSessionSearchQuery(event.currentTarget.value)}
												placeholder="Search title, ID, path, branch, model or message"
												className="h-8 w-full rounded-md border border-border bg-surface-2 pl-8 pr-2 text-[12px] text-text-primary outline-none placeholder:text-text-secondary focus:border-border-focus"
											/>
										</div>
										<NativeSelect
											size="sm"
											value={sessionSearchScope}
											onChange={(event) =>
												setSessionSearchScope(
													event.currentTarget.value as RuntimeAvailableAgentSessionSearchScope,
												)
											}
										>
											<option value="current_repository">Repository</option>
											<option value="all_local_sessions">All sessions</option>
										</NativeSelect>
										<Button
											variant="ghost"
											size="sm"
											icon={<RefreshCw size={14} />}
											onClick={() => void loadAvailableSessions({ forceRefresh: true })}
											aria-label="Refresh available sessions"
										/>
									</div>
									<div className="min-h-28 overflow-y-auto overscroll-contain">
										{isLoadingSessions ? (
											<div className="flex h-28 items-center justify-center gap-2 text-[12px] text-text-secondary">
												<LoaderCircle size={15} className="animate-spin motion-reduce:animate-none" />
												Scanning local sessions
											</div>
										) : availableSessions.length === 0 ? (
											<div className="flex h-28 flex-col items-center justify-center px-4 text-center">
												<p className="text-[12px] text-text-primary">No matching sessions</p>
												<p className="mt-1 text-[11px] text-text-secondary">
													You can still paste a session UUID manually.
												</p>
											</div>
										) : (
											availableSessions.map((session) => (
												<button
													type="button"
													key={`${session.sourceAgentId}:${session.sourceSessionId}`}
													onClick={() => {
														setSessionIdInputValue(session.sourceSessionId);
														commitSessionId(
															session.sourceSessionId,
															session.sessionWorkingDirectoryPath ?? undefined,
														);
														setIsSessionBrowserOpen(false);
													}}
													className="block w-full border-b border-border px-3 py-2 text-left last:border-b-0 hover:bg-surface-3 focus:bg-surface-3 focus:outline-none"
												>
													<div className="flex items-center justify-between gap-3">
														<span className="truncate text-[12px] font-medium text-text-primary">
															{session.sessionTitle}
														</span>
														<span className="shrink-0 text-[10px] text-text-tertiary">
															{new Date(session.lastUpdatedAt).toLocaleString()}
														</span>
													</div>
													{session.previewConversationTurns.at(-1) ? (
														<p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-text-secondary">
															{session.previewConversationTurns.at(-1)?.text}
														</p>
													) : null}
													<div className="mt-1 flex min-w-0 items-center gap-1.5 text-[10px] text-text-tertiary">
														<code className="shrink-0 font-mono">
															{session.sourceSessionId.slice(0, 8)}
														</code>
														{session.gitBranchName ? (
															<span className="truncate">{session.gitBranchName}</span>
														) : null}
														{session.modelId ? <span className="truncate">{session.modelId}</span> : null}
														{session.sessionWorkingDirectoryPath ? (
															<span className="truncate">{session.sessionWorkingDirectoryPath}</span>
														) : null}
													</div>
												</button>
											))
										)}
										{nextPageCursor !== null && !isLoadingSessions ? (
											<div className="flex justify-center p-2">
												<Button
													size="sm"
													variant="default"
													onClick={() =>
														void loadAvailableSessions({ pageCursor: nextPageCursor, append: true })
													}
													disabled={isLoadingMoreSessions}
												>
													{isLoadingMoreSessions ? "Loading sessions" : "Load more sessions"}
												</Button>
											</div>
										) : null}
									</div>
									<div className="flex items-center justify-between gap-3 border-t border-border px-3 py-1.5 text-[10px] text-text-tertiary">
										<span>{totalMatchingSessions} available</span>
										{scanWarnings.length > 0 ? <span>{scanWarnings.length} transcript warnings</span> : null}
									</div>
								</Popover.Content>
							</Popover.Portal>
						</Popover.Root>
					</div>
					{showValidationError && hasInvalidSessionId ? (
						<p className="mt-1 text-[11px] text-status-red">Enter a complete session UUID.</p>
					) : null}
				</div>
				<div className="w-48 max-sm:w-full">
					<span className="mb-1 block text-[11px] text-text-secondary">Reuse behavior</span>
					<NativeSelect
						size="sm"
						value={value?.sourceSessionReuseMode ?? "resume_existing_session"}
						disabled={!value || initializableAgentId === "cursor"}
						onChange={(event) =>
							updateReuseMode(event.currentTarget.value as RuntimeTaskAgentSessionInitializationReuseMode)
						}
						className="w-full"
					>
						<option value="resume_existing_session">Resume existing session</option>
						{initializableAgentId !== "cursor" ? (
							<option value="fork_existing_session">Fork into a new session</option>
						) : null}
					</NativeSelect>
				</div>
			</div>
			<p className="mt-2 flex items-start gap-1.5 text-[11px] leading-4 text-text-secondary">
				<GitFork size={13} className="mt-0.5 shrink-0" />
				{initializableAgentId === "cursor"
					? "Cursor resumes the original chat; Kanban links its local chat store into the task workspace."
					: initializableAgentId === "claude"
						? "Claude resumes or forks the selected session; Kanban links its transcript into the task workspace."
						: "Resume continues the original session. Fork keeps the source session independent."}
			</p>
		</div>
	);
}
