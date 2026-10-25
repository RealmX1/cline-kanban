import { getRuntimeAgentCatalogEntry, getRuntimeLaunchSupportedAgentCatalog } from "@runtime-agent-catalog";
import {
	resolveSessionFacets,
	resolveTaskConversationSessionMainContextForkSelection,
} from "@runtime-session-activity";
import { FileText, MessageCircleQuestion, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { MOBILE_MINIMUM_TOUCH_TARGET_CLASS_NAME } from "@/components/shared/mobile-minimum-touch-target";
import { TruncatedIdentifierChipWithCopyOnClick } from "@/components/shared/truncated-identifier-chip-with-copy-on-click";
import { TaskOriginalPromptDialog } from "@/components/task-original-prompt-dialog";
import { TaskPromptComposer } from "@/components/task-prompt-composer";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Dialog, DialogBody, DialogDescription, DialogHeader } from "@/components/ui/dialog";
import { buildProjectTaskDeepLinkUrl } from "@/hooks/app-utils";
import type { RuntimeAgentDefinition, RuntimeAgentId, RuntimeTaskSessionSummary } from "@/runtime/types";
import { LocalStorageKey, readLocalStorageItem, writeLocalStorageItem } from "@/storage/local-storage-store";
import type { BoardCard } from "@/types";
import { IndependentTaskCreationAction } from "./independent-task-creation-action";
import { TaskMainSessionHandoverAction } from "./task-main-session-handover-action";

type TaskOriginalPromptCard = Pick<BoardCard, "title" | "prompt" | "images" | "createdAt">;

interface TaskSessionCreationDraft {
	initialUserQuestion: string;
	contextSource: NewTaskConversationSessionContextSource;
	sessionRole: "by_the_way" | "task_collaborator";
	collaborationAgentId: RuntimeAgentId;
}
// 仅存当前页面的草稿，按项目和任务隔离；对话框关闭或工作台换格不会清空。
const taskSessionCreationDraftsByWorkspaceAndTask = new Map<string, TaskSessionCreationDraft>();
type NewTaskConversationSessionContextSource = "started_from_scratch" | "forked_from_main_current_turn";

const byTheWaySessionSupportedAgentIds: ReadonlySet<RuntimeAgentId> = new Set(["cline", "claude", "codex"]);
const supportedAgentCatalog = getRuntimeLaunchSupportedAgentCatalog();

function resolveDefaultCollaborationAgentId(mainAgentId: RuntimeAgentId): RuntimeAgentId {
	return supportedAgentCatalog.some((entry) => entry.id === mainAgentId)
		? mainAgentId
		: (supportedAgentCatalog[0]?.id ?? "codex");
}

interface CreateTaskConversationSessionRequest {
	agentId: RuntimeAgentId;
	sessionRole: "by_the_way" | "task_collaborator";
	initialUserQuestion: string;
	contextSource: NewTaskConversationSessionContextSource;
}

// 每一行露出两个标识符：
//   · **会话 id**（旧主会话可以等于卡片 id，交接后仍保留各自 ID）——用户拿它对照日志、URL 与运行时诊断；
//   · **agent 原生会话 id**——harness 自己的 session id（`~/.claude/projects/**/<id>.jsonl` 就是它），
//     标签用记录里的 sourceAgentId 渲染，**不硬编码 agent 名**：这条 sidecar 由 hook stdin 落下，
//     跑的是哪个 harness 由它自己说了算。
// sidecar 缺席时（Cline / ACP 会话，或还没触发过 hook 的老数据）整块不渲染，不摆占位符——
// 一个空壳只会让人以为「这条会话的 id 是空的」。
function TaskConversationSessionIdentifierChips({
	summary,
	taskConversationSessionId,
}: {
	summary: RuntimeTaskSessionSummary;
	taskConversationSessionId: string;
}): React.ReactElement {
	const agentNativeConversationSessionIdentity = summary.agentNativeConversationSessionIdentity;
	return (
		// pr-9 给行右下角那个绝对定位的按钮让位（主会话行的「查看完整 prompt」）。
		<div className="flex flex-wrap items-center gap-1 px-2 pb-2 pr-9">
			<TruncatedIdentifierChipWithCopyOnClick
				identifierLabel="Session"
				identifierValue={taskConversationSessionId}
			/>
			{agentNativeConversationSessionIdentity ? (
				<TruncatedIdentifierChipWithCopyOnClick
					identifierLabel={agentNativeConversationSessionIdentity.sourceAgentId}
					identifierValue={agentNativeConversationSessionIdentity.nativeSessionId}
				/>
			) : null}
		</div>
	);
}

function isSideConversationSessionForTask(summary: RuntimeTaskSessionSummary, workspaceTaskId: string): boolean {
	const metadata = summary.taskConversationSessionMetadata;
	return metadata?.workspaceTaskId === workspaceTaskId && metadata.taskConversationSessionRole !== "main";
}

function getMainSessionTurnNumber(summary: RuntimeTaskSessionSummary): number {
	return summary.latestTurnCheckpoint?.turn ?? (summary.startedAt === null ? 0 : 1);
}

function getSessionStatusLabel(summary: RuntimeTaskSessionSummary): string {
	const facets = resolveSessionFacets(summary);
	if (facets.turnOwner === "agent") {
		return facets.liveness === "retrying" ? "Retrying" : "Answering";
	}
	if (facets.turnOwner === "user") {
		return facets.liveness === "failed" ? "Failed" : "Ready";
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
	isTaskAgentExecutionDisabled = false,
	workspaceId,
	taskCard,
	workspaceTaskId,
	mainSessionSummary,
	mainSessionUserMessagePreview,
	mainSessionOriginalPromptCard,
	effectiveAgentId,
	agents,
	taskSessions,
	selectedTaskConversationSessionId,
	onSelectTaskConversationSession,
	onCreateTaskConversationSession,
}: {
	isTaskAgentExecutionDisabled?: boolean;
	workspaceId?: string | null;
	taskCard?: BoardCard;
	workspaceTaskId: string;
	mainSessionSummary: RuntimeTaskSessionSummary;
	mainSessionUserMessagePreview: string;
	// 任务的初始 prompt 全文。移动端 Focus View 不渲染左侧 ColumnContextPanel，卡片上的
	// 「View original prompt」入口因此整个消失 —— 这里的 Main session 行本就在展示这段 prompt
	// 的两行预览，把「看全文」挂在它旁边是移动端唯一自然的落点。
	mainSessionOriginalPromptCard: TaskOriginalPromptCard;
	effectiveAgentId: RuntimeAgentId;
	agents?: RuntimeAgentDefinition[];
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	selectedTaskConversationSessionId: string;
	onSelectTaskConversationSession: (taskConversationSessionId: string) => void;
	onCreateTaskConversationSession: (
		request: CreateTaskConversationSessionRequest,
	) => Promise<{ ok: boolean; message?: string }>;
}): React.ReactElement {
	const [isOriginalPromptDialogOpen, setIsOriginalPromptDialogOpen] = useState(false);
	const [isCreationDialogOpen, setCreationDialogOpen] = useState(false);
	const draftIdentity = JSON.stringify([workspaceId, workspaceTaskId]);
	const savedDraft = taskSessionCreationDraftsByWorkspaceAndTask.get(draftIdentity);
	const [initialUserQuestion, setInitialUserQuestion] = useState(savedDraft?.initialUserQuestion ?? "");
	const [contextSource, setContextSource] = useState<NewTaskConversationSessionContextSource>(
		savedDraft?.contextSource ?? "forked_from_main_current_turn",
	);
	const [sessionRole, setSessionRole] = useState<"by_the_way" | "task_collaborator">(
		savedDraft?.sessionRole ?? "task_collaborator",
	);
	const [collaborationAgentId, setCollaborationAgentId] = useState<RuntimeAgentId>(
		() => savedDraft?.collaborationAgentId ?? resolveDefaultCollaborationAgentId(effectiveAgentId),
	);
	const selectedAgentId = sessionRole === "by_the_way" ? effectiveAgentId : collaborationAgentId;
	const [isCreating, setIsCreating] = useState(false);
	const [isPreparingQuestionImages, setIsPreparingQuestionImages] = useState(false);
	const [creationError, setCreationError] = useState<string | null>(null);
	const isByTheWaySessionCreationSupported = byTheWaySessionSupportedAgentIds.has(effectiveAgentId);
	const isSessionCreationSupported =
		sessionRole === "by_the_way"
			? isByTheWaySessionCreationSupported
			: supportedAgentCatalog.some((entry) => entry.id === selectedAgentId) &&
				agents?.find((agent) => agent.id === selectedAgentId)?.installed !== false;
	useEffect(() => {
		if (workspaceId)
			taskSessionCreationDraftsByWorkspaceAndTask.set(draftIdentity, {
				initialUserQuestion,
				contextSource,
				sessionRole,
				collaborationAgentId,
			});
	}, [workspaceId, draftIdentity, initialUserQuestion, contextSource, sessionRole, collaborationAgentId]);

	const [readSessionUpdatedAtById, setReadSessionUpdatedAtById] = useState<Record<string, number>>(
		readTaskConversationSessionReadReceipts,
	);
	const mainSessionTurnNumber = getMainSessionTurnNumber(mainSessionSummary);
	const sideConversationSessions = useMemo(
		() =>
			Object.values(taskSessions)
				.filter((summary) => isSideConversationSessionForTask(summary, workspaceTaskId))
				.sort((left, right) => right.updatedAt - left.updatedAt),
		[taskSessions, workspaceTaskId],
	);
	const mainSessionForkSelection = resolveTaskConversationSessionMainContextForkSelection({
		workspaceTaskId,
		launchAgentId: selectedAgentId,
		sessionRole,
		mainSessionSummary,
		mainSessionWorkingDirectoryPath: mainSessionSummary.workspacePath,
		existingTaskConversationSessionSummaries: Object.values(taskSessions),
	});
	const canForkCurrentMainSession =
		mainSessionSummary.startedAt !== null && mainSessionForkSelection.forkRejectionReason === null;

	// 身份尚未就绪时只暂时显示全新上下文；身份到达后恢复默认，保留用户明确选择。
	const resolvedContextSource = canForkCurrentMainSession ? contextSource : "started_from_scratch";

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
		if (isTaskAgentExecutionDisabled || !isSessionCreationSupported || !initialUserQuestion.trim() || isCreating) {
			return;
		}
		setCreationError(null);
		setIsCreating(true);

		try {
			const result = await onCreateTaskConversationSession({
				agentId: selectedAgentId,
				sessionRole,
				initialUserQuestion,
				contextSource: resolvedContextSource,
			});
			if (!result.ok) {
				setCreationError(result.message ?? "无法创建会话。");
				return;
			}
			setInitialUserQuestion("");
			setCreationDialogOpen(false);
		} catch (cause: unknown) {
			setCreationError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setIsCreating(false);
		}
	};

	return (
		<div className="flex h-full min-h-0 flex-col bg-surface-1">
			<div className="flex h-8 shrink-0 items-center border-b border-border px-2">
				<span className="text-xs font-medium">Sessions</span>
				<Button
					variant="ghost"
					size="sm"
					icon={<Plus size={14} />}
					className="ml-auto h-6"
					onClick={() => setCreationDialogOpen(true)}
					disabled={isCreating || isTaskAgentExecutionDisabled}
				>
					新建会话
				</Button>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto p-1.5">
				{workspaceId && taskCard?.independentTaskCreationProvenance && (
					<a
						className="mb-2 block break-words px-2 text-xs text-accent underline"
						href={`${buildProjectTaskDeepLinkUrl(taskCard.independentTaskCreationProvenance.sourceWorkspaceId, taskCard.independentTaskCreationProvenance.sourceTaskId)}&conversationSession=${encodeURIComponent(taskCard.independentTaskCreationProvenance.sourceTaskConversationSessionId)}`}
					>
						来自任务 {taskCard.independentTaskCreationProvenance.sourceTaskId} 的会话{" "}
						{taskCard.independentTaskCreationProvenance.sourceTaskConversationSessionId}
						{taskCard.independentTaskCreationProvenance.inheritedGitWorkingStateIncludedUncommittedChanges
							? "（含来源未提交修改）"
							: ""}
					</a>
				)}
				{workspaceId && taskCard && !isTaskAgentExecutionDisabled && (
					<TaskMainSessionHandoverAction
						workspaceId={workspaceId}
						taskCard={taskCard}
						mainSessionSummary={mainSessionSummary}
					/>
				)}
				{/* 「查看完整 prompt」是行内 button，不能嵌在选择会话的 button 里（嵌套 button 是无效 HTML），
					    故两者作为兄弟元素放进同一个 relative 容器，前者绝对定位到右下角。 */}
				{/* 底色挂在容器上而不是 button 上：id 条是 button 的兄弟节点（见下），底色留在 button 上
					    会让同一张卡片视觉上裂成两半。 */}
				<div
					className={cn(
						"relative mb-1 rounded-md hover:bg-surface-3",
						selectedTaskConversationSessionId === mainSessionSummary.taskId && "bg-surface-3",
					)}
				>
					<button
						type="button"
						className="w-full rounded-md px-2 pb-1 pt-2 text-left"
						onClick={() => selectSession(mainSessionSummary)}
					>
						<div className="flex items-center gap-2">
							<span className="text-xs font-medium text-text-primary">Main session</span>
							<span className="ml-auto text-[11px] text-text-tertiary">
								{getSessionStatusLabel(mainSessionSummary)}
							</span>
						</div>
						<p className="mt-1 line-clamp-2 pr-9 text-xs text-text-secondary">{mainSessionUserMessagePreview}</p>
					</button>
					<TaskConversationSessionIdentifierChips
						summary={mainSessionSummary}
						taskConversationSessionId={mainSessionSummary.taskId}
					/>
					<Button
						variant="ghost"
						size="sm"
						icon={<FileText size={14} />}
						onClick={() => setIsOriginalPromptDialogOpen(true)}
						aria-label="View the original prompt for this task"
						className={cn("absolute bottom-1 right-1", MOBILE_MINIMUM_TOUCH_TARGET_CLASS_NAME)}
					/>
				</div>
				<TaskOriginalPromptDialog
					open={isOriginalPromptDialogOpen}
					card={mainSessionOriginalPromptCard}
					onClose={() => setIsOriginalPromptDialogOpen(false)}
				/>
				{sideConversationSessions.map((summary) => {
					const metadata = summary.taskConversationSessionMetadata;
					if (!metadata) {
						return null;
					}
					const turnsAgo = Math.max(0, mainSessionTurnNumber - (metadata.mainSessionOriginTurnNumber ?? 0));
					const hasUnreadCompletion =
						resolveSessionFacets(summary).turnOwner === "user" &&
						(readSessionUpdatedAtById[summary.taskId] ?? 0) < summary.updatedAt &&
						selectedTaskConversationSessionId !== summary.taskId;
					return (
						// id 复制芯片是 button，不能嵌进这个整行可点的 button 里（嵌套 button 是无效 HTML），
						// 故与它并列放进同一个容器；底色同样挂在容器上，保持一张卡片的观感。
						<div
							key={summary.taskId}
							className={cn(
								"mb-1 rounded-md hover:bg-surface-3",
								selectedTaskConversationSessionId === summary.taskId && "bg-surface-3",
							)}
						>
							<button
								type="button"
								className="w-full rounded-md px-2 pb-1 pt-2 text-left"
								onClick={() => selectSession(summary)}
							>
								<div className="flex items-center gap-2">
									<MessageCircleQuestion size={13} className="text-status-purple" />
									<span className="text-xs font-medium text-text-primary">
										{metadata.taskConversationSessionHasHeldMainResponsibility ||
										metadata.taskConversationSessionRoleAtCreation === "main"
											? "前主会话"
											: metadata.taskConversationSessionRole === "task_collaborator"
												? "协作会话"
												: "By the way"}
									</span>
									<span className="text-[11px] text-text-tertiary">
										{getRuntimeAgentCatalogEntry(summary.agentId ?? "codex")?.label ?? summary.agentId}
									</span>
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
							<TaskConversationSessionIdentifierChips
								summary={summary}
								taskConversationSessionId={summary.taskId}
							/>
							{workspaceId &&
								!isTaskAgentExecutionDisabled &&
								!metadata.taskConversationSessionHasHeldMainResponsibility &&
								metadata.taskConversationSessionRoleAtCreation !== "main" && (
									<IndependentTaskCreationAction
										workspaceId={workspaceId}
										sourceTaskId={workspaceTaskId}
										sourceSessionId={summary.taskId}
									/>
								)}
						</div>
					);
				})}
				{sideConversationSessions.length === 0 ? (
					<div className="flex flex-col items-center gap-2 px-4 py-6 text-center text-xs text-text-tertiary">
						<MessageCircleQuestion size={24} />
						<span>
							{isTaskAgentExecutionDisabled
								? "此任务没有其他会话。"
								: "创建协作会话处理工作，或用 By the way 询问侧问。"}
						</span>
					</div>
				) : null}
			</div>
			<Dialog
				open={isCreationDialogOpen}
				onOpenChange={(open) => {
					if (!isCreating) setCreationDialogOpen(open);
				}}
			>
				<DialogHeader title="新建会话" />
				<DialogDescription className="px-3 pt-2 text-xs text-text-secondary">
					为当前任务创建协作会话或侧问会话。
				</DialogDescription>
				<DialogBody>
					<div className="min-h-0 flex-1 overflow-y-auto p-3">
						<label
							className="mb-1 block text-xs font-medium text-text-secondary"
							htmlFor="task-conversation-session-role"
						>
							会话类型
						</label>
						<select
							id="task-conversation-session-role"
							className="mb-3 h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-xs text-text-primary"
							value={sessionRole}
							disabled={isCreating}
							onChange={(event) => {
								setSessionRole(event.target.value as "by_the_way" | "task_collaborator");
								setContextSource("forked_from_main_current_turn");
								setCreationError(null);
							}}
						>
							<option value="task_collaborator">协作会话</option>
							<option value="by_the_way" disabled={!isByTheWaySessionCreationSupported}>
								By the way
							</option>
						</select>
						{sessionRole === "task_collaborator" ? (
							<>
								<label
									className="mb-1 block text-xs font-medium text-text-secondary"
									htmlFor="task-conversation-session-agent"
								>
									Agent
								</label>
								<select
									id="task-conversation-session-agent"
									value={collaborationAgentId}
									disabled={isCreating}
									className="mb-3 h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-xs text-text-primary"
									onChange={(event) => {
										setCollaborationAgentId(event.target.value as RuntimeAgentId);
										setContextSource("forked_from_main_current_turn");
									}}
								>
									{supportedAgentCatalog.map((agent) => (
										<option
											key={agent.id}
											value={agent.id}
											disabled={agents?.find((candidate) => candidate.id === agent.id)?.installed === false}
										>
											{agent.label}
											{agents?.find((candidate) => candidate.id === agent.id)?.installed === false
												? "（未安装）"
												: ""}
										</option>
									))}
								</select>
								<p className="mb-3 text-xs text-text-secondary">共用当前工作目录。主会话负责卡片生命周期。</p>
							</>
						) : null}
						<>
							<label
								className="mb-1 block text-xs font-medium text-text-secondary"
								htmlFor="task-conversation-context-source"
							>
								Context
							</label>
							<select
								id="task-conversation-context-source"
								className="mb-3 h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-xs text-text-primary"
								value={resolvedContextSource}
								onChange={(event) =>
									setContextSource(event.target.value as NewTaskConversationSessionContextSource)
								}
							>
								<option value="forked_from_main_current_turn" disabled={!canForkCurrentMainSession}>
									Fork current main session
								</option>
								<option value="started_from_scratch">Start from scratch</option>
							</select>
							{mainSessionForkSelection.forkRejectionReason ? (
								<p className="mb-3 text-xs text-text-secondary">
									{mainSessionForkSelection.forkRejectionReason}
								</p>
							) : null}
						</>
						<label
							className="mb-1 block text-xs font-medium text-text-secondary"
							htmlFor="task-conversation-initial-question"
						>
							{sessionRole === "task_collaborator" ? "首条消息" : "Question"}
						</label>
						<TaskPromptComposer
							id="task-conversation-initial-question"
							workspaceId={workspaceId}
							minimumTextareaHeight={96}
							placeholder={
								sessionRole === "task_collaborator" ? "描述要交给这个会话的工作…" : "Ask a side question…"
							}
							value={initialUserQuestion}
							onImagePreparationPendingChange={setIsPreparingQuestionImages}
							onValueChange={setInitialUserQuestion}
						/>
						<p className="mt-1 text-[11px] text-text-tertiary">
							{sessionRole === "task_collaborator"
								? "可执行命令与修改文件，权限和 Plan 起步设置沿用当前卡片。"
								: !isByTheWaySessionCreationSupported
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
							disabled={
								!isSessionCreationSupported ||
								!initialUserQuestion.trim() ||
								isCreating ||
								isPreparingQuestionImages
							}
							onClick={() => void createSession()}
						>
							{isCreating ? "Creating…" : "Create session"}
						</Button>
					</div>
				</DialogBody>
			</Dialog>
		</div>
	);
}
