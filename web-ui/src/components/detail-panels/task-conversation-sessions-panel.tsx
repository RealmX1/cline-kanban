import { MessageCircleQuestion, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import type { RuntimeAgentId, RuntimeTaskSessionSummary } from "@/runtime/types";
import { LocalStorageKey, readLocalStorageItem, writeLocalStorageItem } from "@/storage/local-storage-store";

type TaskConversationSessionsPanelTab = "sessions" | "create_session";
type NewTaskConversationSessionContextSource = "started_from_scratch" | "forked_from_main_current_turn";

const byTheWaySessionSupportedAgentIds: ReadonlySet<RuntimeAgentId> = new Set(["cline", "claude", "codex"]);

interface CreateByTheWaySessionRequest {
	initialUserQuestion: string;
	contextSource: NewTaskConversationSessionContextSource;
}

function isByTheWaySessionForTask(summary: RuntimeTaskSessionSummary, workspaceTaskId: string): boolean {
	const metadata = summary.taskConversationSessionMetadata;
	return metadata?.workspaceTaskId === workspaceTaskId && metadata.taskConversationSessionRole === "by_the_way";
}

function getMainSessionTurnNumber(summary: RuntimeTaskSessionSummary): number {
	return summary.latestTurnCheckpoint?.turn ?? (summary.startedAt === null ? 0 : 1);
}

function getSessionStatusLabel(summary: RuntimeTaskSessionSummary): string {
	if (summary.turnOwner === "agent") {
		return summary.liveness === "retrying" ? "Retrying" : "Answering";
	}
	if (summary.turnOwner === "user") {
		return summary.liveness === "failed" ? "Failed" : "Ready";
	}
	return "Idle";
}

function readTaskConversationSessionReadReceipts(): Record<string, number> {
	const storedValue = readLocalStorageItem(LocalStorageKey.TaskConversationSessionReadReceipts);
	if (!storedValue) {
		return {};
	}
	try {
		const parsedValue: unknown = JSON.parse(storedValue);
		if (!parsedValue || typeof parsedValue !== "object" || Array.isArray(parsedValue)) {
			return {};
		}
		return Object.fromEntries(
			Object.entries(parsedValue).filter(
				(entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]),
			),
		);
	} catch {
		return {};
	}
}

export function TaskConversationSessionsPanel({
	workspaceTaskId,
	mainSessionSummary,
	mainSessionUserMessagePreview,
	effectiveAgentId,
	taskSessions,
	selectedTaskConversationSessionId,
	onSelectTaskConversationSession,
	onCreateByTheWaySession,
}: {
	workspaceTaskId: string;
	mainSessionSummary: RuntimeTaskSessionSummary;
	mainSessionUserMessagePreview: string;
	effectiveAgentId: RuntimeAgentId;
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	selectedTaskConversationSessionId: string;
	onSelectTaskConversationSession: (taskConversationSessionId: string) => void;
	onCreateByTheWaySession: (request: CreateByTheWaySessionRequest) => Promise<{ ok: boolean; message?: string }>;
}): React.ReactElement {
	const [activeTab, setActiveTab] = useState<TaskConversationSessionsPanelTab>("sessions");
	const [initialUserQuestion, setInitialUserQuestion] = useState("");
	const [contextSource, setContextSource] = useState<NewTaskConversationSessionContextSource>(() =>
		mainSessionSummary.startedAt === null ? "started_from_scratch" : "forked_from_main_current_turn",
	);
	const [isCreating, setIsCreating] = useState(false);
	const [creationError, setCreationError] = useState<string | null>(null);
	const isByTheWaySessionCreationSupported = byTheWaySessionSupportedAgentIds.has(effectiveAgentId);
	const [readSessionUpdatedAtById, setReadSessionUpdatedAtById] = useState<Record<string, number>>(
		readTaskConversationSessionReadReceipts,
	);
	const mainSessionTurnNumber = getMainSessionTurnNumber(mainSessionSummary);
	const byTheWaySessions = useMemo(
		() =>
			Object.values(taskSessions)
				.filter((summary) => isByTheWaySessionForTask(summary, workspaceTaskId))
				.sort((left, right) => right.updatedAt - left.updatedAt),
		[taskSessions, workspaceTaskId],
	);
	const canForkCurrentMainSession = mainSessionSummary.startedAt !== null && byTheWaySessions.length === 0;

	useEffect(() => {
		if (!canForkCurrentMainSession && contextSource === "forked_from_main_current_turn") {
			setContextSource("started_from_scratch");
		}
	}, [canForkCurrentMainSession, contextSource]);

	useEffect(() => {
		const selectedSummary = taskSessions[selectedTaskConversationSessionId];
		if (!selectedSummary || selectedTaskConversationSessionId === workspaceTaskId) {
			return;
		}
		setReadSessionUpdatedAtById((currentReadReceipts) => {
			if ((currentReadReceipts[selectedSummary.taskId] ?? 0) >= selectedSummary.updatedAt) {
				return currentReadReceipts;
			}
			const nextReadReceipts = {
				...currentReadReceipts,
				[selectedSummary.taskId]: selectedSummary.updatedAt,
			};
			writeLocalStorageItem(LocalStorageKey.TaskConversationSessionReadReceipts, JSON.stringify(nextReadReceipts));
			return nextReadReceipts;
		});
	}, [selectedTaskConversationSessionId, taskSessions, workspaceTaskId]);

	useEffect(() => {
		const synchronizeReadReceiptsAcrossTabs = (event: StorageEvent) => {
			if (event.key === LocalStorageKey.TaskConversationSessionReadReceipts) {
				setReadSessionUpdatedAtById(readTaskConversationSessionReadReceipts());
			}
		};
		window.addEventListener("storage", synchronizeReadReceiptsAcrossTabs);
		return () => window.removeEventListener("storage", synchronizeReadReceiptsAcrossTabs);
	}, []);

	const selectSession = (summary: RuntimeTaskSessionSummary) => {
		setReadSessionUpdatedAtById((currentReadReceipts) => {
			const nextReadReceipts = { ...currentReadReceipts, [summary.taskId]: summary.updatedAt };
			writeLocalStorageItem(LocalStorageKey.TaskConversationSessionReadReceipts, JSON.stringify(nextReadReceipts));
			return nextReadReceipts;
		});
		onSelectTaskConversationSession(summary.taskId);
	};

	const createSession = async () => {
		if (!isByTheWaySessionCreationSupported || !initialUserQuestion.trim() || isCreating) {
			return;
		}
		setCreationError(null);
		setIsCreating(true);
		const result = await onCreateByTheWaySession({
			initialUserQuestion,
			contextSource: canForkCurrentMainSession ? contextSource : "started_from_scratch",
		});
		setIsCreating(false);
		if (!result.ok) {
			setCreationError(result.message ?? "Could not create the session.");
			return;
		}
		setInitialUserQuestion("");
		setActiveTab("sessions");
	};

	return (
		<div className="flex h-full min-h-0 flex-col bg-surface-1">
			<div className="flex h-8 shrink-0 items-center border-b border-border px-2">
				<div role="tablist" aria-label="Task conversation sessions" className="flex min-w-0 items-center gap-0.5">
					<button
						type="button"
						role="tab"
						aria-selected={activeTab === "sessions"}
						className={cn(
							"h-6 rounded-sm px-2 text-xs font-medium",
							activeTab === "sessions"
								? "bg-surface-3 text-text-primary"
								: "text-text-secondary hover:bg-surface-3",
						)}
						onClick={() => setActiveTab("sessions")}
					>
						Sessions
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={activeTab === "create_session"}
						className={cn(
							"h-6 rounded-sm px-2 text-xs font-medium",
							activeTab === "create_session"
								? "bg-surface-3 text-text-primary"
								: "text-text-secondary hover:bg-surface-3",
						)}
						onClick={() => setActiveTab("create_session")}
						disabled={!isByTheWaySessionCreationSupported}
					>
						Create session
					</button>
				</div>
				{activeTab === "sessions" ? (
					<Button
						variant="ghost"
						size="sm"
						icon={<Plus size={14} />}
						className="ml-auto h-6"
						onClick={() => setActiveTab("create_session")}
						disabled={!isByTheWaySessionCreationSupported}
					>
						Add New
					</Button>
				) : null}
			</div>

			{activeTab === "sessions" ? (
				<div className="min-h-0 flex-1 overflow-y-auto p-1.5">
					<button
						type="button"
						className={cn(
							"mb-1 w-full rounded-md px-2 py-2 text-left hover:bg-surface-3",
							selectedTaskConversationSessionId === workspaceTaskId && "bg-surface-3",
						)}
						onClick={() => selectSession(mainSessionSummary)}
					>
						<div className="flex items-center gap-2">
							<span className="text-xs font-medium text-text-primary">Main session</span>
							<span className="ml-auto text-[11px] text-text-tertiary">
								{getSessionStatusLabel(mainSessionSummary)}
							</span>
						</div>
						<p className="mt-1 line-clamp-2 text-xs text-text-secondary">{mainSessionUserMessagePreview}</p>
					</button>
					{byTheWaySessions.map((summary) => {
						const metadata = summary.taskConversationSessionMetadata;
						if (!metadata) {
							return null;
						}
						const turnsAgo = Math.max(0, mainSessionTurnNumber - (metadata.mainSessionOriginTurnNumber ?? 0));
						const hasUnreadCompletion =
							summary.turnOwner === "user" &&
							(readSessionUpdatedAtById[summary.taskId] ?? 0) < summary.updatedAt &&
							selectedTaskConversationSessionId !== summary.taskId;
						return (
							<button
								type="button"
								key={summary.taskId}
								className={cn(
									"mb-1 w-full rounded-md px-2 py-2 text-left hover:bg-surface-3",
									selectedTaskConversationSessionId === summary.taskId && "bg-surface-3",
								)}
								onClick={() => selectSession(summary)}
							>
								<div className="flex items-center gap-2">
									<MessageCircleQuestion size={13} className="text-status-purple" />
									<span className="text-xs font-medium text-text-primary">By the way</span>
									{hasUnreadCompletion ? (
										<span role="img" className="h-2 w-2 rounded-full bg-accent" aria-label="Unread answer" />
									) : null}
									<span className="ml-auto text-[11px] text-text-tertiary">
										{getSessionStatusLabel(summary)}
									</span>
								</div>
								<p className="mt-1 line-clamp-2 text-xs text-text-secondary">
									{metadata.latestUserMessagePreview ?? "No question yet"}
								</p>
								<p className="mt-1 text-[11px] text-text-tertiary">
									{metadata.taskConversationSessionContextSource === "forked_from_main_current_turn"
										? `Forked from main · ${turnsAgo} turns ago`
										: `Started from scratch · ${turnsAgo} turns ago`}
								</p>
							</button>
						);
					})}
					{byTheWaySessions.length === 0 ? (
						<div className="flex flex-col items-center gap-2 px-4 py-6 text-center text-xs text-text-tertiary">
							<MessageCircleQuestion size={24} />
							<span>Ask a side question without interrupting the main session.</span>
						</div>
					) : null}
				</div>
			) : (
				<div className="min-h-0 flex-1 overflow-y-auto p-3">
					<label
						className="mb-1 block text-xs font-medium text-text-secondary"
						htmlFor="task-conversation-session-role"
					>
						Session role
					</label>
					<select
						id="task-conversation-session-role"
						className="mb-3 h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-xs text-text-primary"
						value="by_the_way"
						onChange={() => undefined}
					>
						<option value="by_the_way">By the way</option>
					</select>
					<label
						className="mb-1 block text-xs font-medium text-text-secondary"
						htmlFor="task-conversation-context-source"
					>
						Context
					</label>
					<select
						id="task-conversation-context-source"
						className="mb-3 h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-xs text-text-primary"
						value={contextSource}
						onChange={(event) => setContextSource(event.target.value as NewTaskConversationSessionContextSource)}
					>
						<option value="forked_from_main_current_turn" disabled={!canForkCurrentMainSession}>
							Fork current main session
						</option>
						<option value="started_from_scratch">Start from scratch</option>
					</select>
					<label
						className="mb-1 block text-xs font-medium text-text-secondary"
						htmlFor="task-conversation-initial-question"
					>
						Question
					</label>
					<textarea
						id="task-conversation-initial-question"
						className="min-h-24 w-full resize-y rounded-md border border-border bg-surface-2 p-2 text-xs text-text-primary placeholder:text-text-secondary focus:border-border-focus focus:outline-none"
						placeholder="Ask a side question…"
						value={initialUserQuestion}
						onChange={(event) => setInitialUserQuestion(event.target.value)}
					/>
					<p className="mt-1 text-[11px] text-text-tertiary">
						{!isByTheWaySessionCreationSupported
							? `${effectiveAgentId} By the way sessions are not available.`
							: effectiveAgentId === "cline"
								? "Cline will answer in read-only Plan mode."
								: `${effectiveAgentId === "claude" ? "Claude Code" : "Codex"} will run with read-only tools.`}
					</p>
					{creationError ? <p className="mt-2 text-xs text-status-red">{creationError}</p> : null}
					<Button
						variant="primary"
						size="sm"
						fill
						className="mt-3"
						disabled={!initialUserQuestion.trim() || isCreating}
						onClick={() => void createSession()}
					>
						{isCreating ? "Creating…" : "Create session"}
					</Button>
				</div>
			)}
		</div>
	);
}
