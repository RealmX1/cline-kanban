import { basename, dirname, isAbsolute, relative, sep } from "node:path";
import { TRPCError } from "@trpc/server";
import type {
	RuntimeTaskConversationHistoryPageRequest,
	RuntimeTaskConversationHistoryPageResponse,
	RuntimeTaskDirectoryRequest,
	RuntimeTaskFileDownloadRequest,
	RuntimeTaskFileIdentityRequest,
} from "../core/api-contract";
import {
	resolveMainTaskConversationSessionId,
	resolveMainTaskConversationSessionSummary,
} from "../core/task-main-conversation-session-binding";
import { removeTaskSessionSummariesOwnedByOtherWorkspaces } from "../state/task-session-summaries-owned-by-other-workspaces-removal";
import { getTaskWorktreesHomePath, loadPersistedWorkspaceStateById } from "../state/workspace-state";
import { getTaskWorkspacePathInfo, resolveTaskCwd } from "../workspace/task-worktree";
import {
	listTaskDirectory,
	type OpenedTaskFileDownload,
	openTaskRegularFile,
	taskFileAccessError,
} from "./task-file-access";
import { readLatestTaskMainSessionPlan, taskPlanCandidateId } from "./task-main-session-plan";

type WorkspaceScope = { workspaceId: string; workspacePath: string };
type ReadHistory = (
	scope: WorkspaceScope,
	request: RuntimeTaskConversationHistoryPageRequest,
) => Promise<RuntimeTaskConversationHistoryPageResponse>;
export type TaskFileDownloadContents = OpenedTaskFileDownload | { markdown: string; fileName: string };
const MAXIMUM_PLAN_FILE_COMPARISON_BYTES = 8 * 1024 * 1024;

async function openPlanSourceFile(workspacePath: string, sourceReference: string): Promise<OpenedTaskFileDownload> {
	const fromWorkspace = relative(workspacePath, sourceReference);
	const insideWorkspace =
		fromWorkspace !== "" &&
		fromWorkspace !== ".." &&
		!fromWorkspace.startsWith(`..${sep}`) &&
		!isAbsolute(fromWorkspace);
	if (insideWorkspace) return openTaskRegularFile(workspacePath, fromWorkspace);
	return openTaskRegularFile(dirname(sourceReference), basename(sourceReference));
}

async function planFileAgreesWithMarkdown(file: OpenedTaskFileDownload, markdown: string | null): Promise<boolean> {
	if (!markdown) return true;
	if (file.size > MAXIMUM_PLAN_FILE_COMPARISON_BYTES) return false;
	const buffer = Buffer.alloc(file.size);
	const { bytesRead } = file.size === 0 ? { bytesRead: 0 } : await file.handle.read(buffer, 0, file.size, 0);
	return buffer.subarray(0, bytesRead).toString("utf8").trim() === markdown.trim();
}

async function readTaskContext(scope: WorkspaceScope, input: RuntimeTaskFileIdentityRequest) {
	const state = await loadPersistedWorkspaceStateById(scope.workspaceId);
	const card = state.board.columns.flatMap((column) => column.cards).find((entry) => entry.id === input.taskId);
	if (!card) throw new TRPCError({ code: "NOT_FOUND", message: "指定项目中的任务不存在。" });
	if (card.createdAt !== input.expectedTaskIncarnationCreatedAtEpochMs)
		throw new TRPCError({ code: "CONFLICT", message: "任务身份已变化，请重新打开任务。" });
	const sessions = removeTaskSessionSummariesOwnedByOtherWorkspaces({
		workspaceId: scope.workspaceId,
		workspaceRepositoryPath: scope.workspacePath,
		taskWorktreesHomePath: getTaskWorktreesHomePath(),
		sessions: state.sessions,
	}).sessionsWithoutSummariesOwnedByOtherWorkspaces;
	return {
		card,
		summary: resolveMainTaskConversationSessionSummary(card, sessions),
		directoryBinding: JSON.stringify([card.worktreeMode, card.baseRef]),
	};
}

export function createTaskFileDownloadService(readHistory: ReadHistory) {
	const readPlan = async (scope: WorkspaceScope, input: RuntimeTaskFileIdentityRequest) => {
		const { card, summary } = await readTaskContext(scope, input);
		const sessionId = resolveMainTaskConversationSessionId(card);
		const workspacePath =
			summary?.workspacePath ??
			(
				await getTaskWorkspacePathInfo({
					cwd: scope.workspacePath,
					taskId: card.id,
					baseRef: card.baseRef,
					worktreeMode: card.worktreeMode,
				})
			).path;
		const plan = await readLatestTaskMainSessionPlan({
			sessionId,
			workspacePath,
			readPage: (cursor) =>
				readHistory(scope, {
					workspaceTaskId: card.id,
					taskConversationSessionId: sessionId,
					cursor,
					transcriptReadConsistency: "stable_snapshot",
				}),
		});
		const identityKey = (value: typeof summary) =>
			JSON.stringify([
				value?.agentId,
				value?.agentNativeConversationSessionIdentity?.sourceAgentId,
				value?.agentNativeConversationSessionIdentity?.nativeSessionId,
				value?.agentNativeConversationSessionIdentity?.transcriptPath,
			]);
		const assertCurrentSource = async () => {
			const current = await readTaskContext(scope, input);
			if (
				resolveMainTaskConversationSessionId(current.card) !== sessionId ||
				identityKey(current.summary) !== identityKey(summary)
			)
				throw new TRPCError({ code: "CONFLICT", message: "主会话来源已变化，请重试。" });
		};
		if (plan.version) {
			const readableCandidates = [];
			for (const candidate of plan.response.candidates) {
				if (candidate.sourceKind !== "file") {
					readableCandidates.push(candidate);
					continue;
				}
				try {
					const file = await openPlanSourceFile(workspacePath, candidate.sourceReference);
					try {
						if (await planFileAgreesWithMarkdown(file, plan.version.markdown)) readableCandidates.push(candidate);
					} finally {
						await file.handle.close();
					}
				} catch {
					/* 明确正文仍可导出，缺失原文件不能冒充可下载。 */
				}
			}
			if (!readableCandidates.length && plan.version.markdown)
				readableCandidates.push({
					candidateId: taskPlanCandidateId(sessionId, plan.version, null),
					fileName: "main-session-plan.md",
					sourceKind: "markdown" as const,
					sourceReference: `主会话 ${sessionId}，记录 ${plan.version.messageId}`,
				});
			plan.response.candidates = readableCandidates;
			if (!readableCandidates.length) {
				plan.response.availability = "unknown";
				plan.response.notice = "已找到计划来源，但文件不存在、没有读取权限或暂不可读，请重试。";
			}
		}
		await assertCurrentSource();
		return { ...plan, sessionId, assertCurrentSource, workspacePath };
	};
	return {
		listDirectory: async (scope: WorkspaceScope, input: RuntimeTaskDirectoryRequest) => {
			const { card, directoryBinding } = await readTaskContext(scope, input);
			const root = await resolveTaskCwd({
				cwd: scope.workspacePath,
				taskId: card.id,
				baseRef: card.baseRef,
				worktreeMode: card.worktreeMode,
				ensure: false,
			}).catch((error: unknown) => {
				throw taskFileAccessError(error);
			});
			const result = await listTaskDirectory(root, input.path);
			if ((await readTaskContext(scope, input)).directoryBinding !== directoryBinding)
				throw new TRPCError({ code: "CONFLICT", message: "任务工作目录归属已变化，请刷新后重试。" });
			return result;
		},
		getMainSessionPlan: async (scope: WorkspaceScope, input: RuntimeTaskFileIdentityRequest) =>
			(await readPlan(scope, input)).response,
		openDownload: async (
			scope: WorkspaceScope,
			input: RuntimeTaskFileDownloadRequest,
		): Promise<TaskFileDownloadContents> => {
			if (input.source === "task_file") {
				const { card, directoryBinding } = await readTaskContext(scope, input);
				const root = await resolveTaskCwd({
					cwd: scope.workspacePath,
					taskId: card.id,
					baseRef: card.baseRef,
					worktreeMode: card.worktreeMode,
					ensure: false,
				}).catch((error: unknown) => {
					throw taskFileAccessError(error);
				});
				const file = await openTaskRegularFile(root, input.path ?? "");
				try {
					if ((await readTaskContext(scope, input)).directoryBinding !== directoryBinding)
						throw new TRPCError({ code: "CONFLICT", message: "任务工作目录归属已变化，请刷新后重试。" });
					return file;
				} catch (error) {
					await file.handle.close();
					throw error;
				}
			}
			const plan = await readPlan(scope, input);
			const candidate = plan.response.candidates.find((entry) => entry.candidateId === input.candidateId);
			if (!candidate || !plan.version)
				throw new TRPCError({ code: "CONFLICT", message: "Plan 来源已变化或暂不可读，请刷新 Plan 后重试。" });
			if (candidate.sourceKind === "markdown" && plan.version.markdown)
				return { markdown: plan.version.markdown, fileName: `${input.taskId}-main-session-plan.md` };
			const file = await openPlanSourceFile(plan.workspacePath, candidate.sourceReference);
			let deliverFile = false;
			try {
				await plan.assertCurrentSource();
				if (await planFileAgreesWithMarkdown(file, plan.version.markdown)) {
					deliverFile = true;
					return file;
				}
				if (!plan.version.markdown)
					throw new TRPCError({ code: "CONFLICT", message: "文件在读取时发生变化，请重试。" });
				return { markdown: plan.version.markdown, fileName: `${input.taskId}-main-session-plan.md` };
			} finally {
				if (!deliverFile) await file.handle.close();
			}
		},
	};
}
