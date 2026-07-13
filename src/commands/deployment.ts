import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import packageJson from "../../package.json" with { type: "json" };
import { loadRuntimeConfig } from "../config/runtime-config";
import type {
	RuntimeBoardColumnId,
	RuntimeGuidedVerificationAcknowledgement,
	RuntimeGuidedVerificationDeploymentGroup,
	RuntimeGuidedVerificationPendingConfirmation,
	RuntimeGuidedVerificationState,
	RuntimeGuidedVerificationTask,
	RuntimeUpdateVerificationChecklistRequest,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract";
import { runtimeGuidedVerificationAcknowledgementSchema } from "../core/api-contract";
import { parseGuidedVerificationState } from "../core/api-validation";
import { getKanbanRuntimeOrigin } from "../core/runtime-endpoint";
import { getTaskColumnId } from "../core/task-board-mutations";
import { readDeployMarker } from "../deployment/deploy-marker";
import {
	computeRequiredAcknowledgementsForColumn,
	createDeploymentGroup,
	createGuidedVerificationTaskWithSeededChecklist,
	getActiveGroup,
	getGuidedVerificationStatePath,
	markTaskVerified,
	setPendingConfirmation,
	updateTaskChecklist,
} from "../deployment/guided-verification-state";
import type { DeploymentCorrelationTaskInput } from "../deployment/task-deploy-correlation";
import { correlateTasksWithDeployDelta } from "../deployment/task-deploy-correlation";
import { logDeploymentDiagnosticWarning } from "../diagnostics/deployment-diagnostics-logger";
import { resolveProjectInputPath } from "../projects/project-path";
import { loadWorkspaceBoardById, loadWorkspaceContext, loadWorkspaceContextById } from "../state/workspace-state";
import { runGit } from "../workspace/git-utils";
import { createRuntimeTrpcClient, printJson, trashTaskById } from "./task";

type JsonRecord = Record<string, unknown>;

// pendingConfirmation token 短期过期窗口（plan Grilling #8：一次性 + 短期，如 15min）。
const CONFIRMATION_TOKEN_TTL_MS = 15 * 60 * 1000;
// agent response 预览统一截断上限（plan Grilling #5）。
const AGENT_RESPONSE_PREVIEW_MAX_CHARS = 800;

const KANBAN_PACKAGE_VERSION = typeof packageJson.version === "string" ? packageJson.version : "0.0.0";

function toErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message;
	}
	return String(error);
}

function isEnoent(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function runDeploymentCommand(handler: () => Promise<JsonRecord>): Promise<void> {
	try {
		printJson(await handler());
	} catch (error) {
		printJson({
			ok: false,
			error: `Deployment command failed at ${getKanbanRuntimeOrigin()}: ${toErrorMessage(error)}`,
		});
		process.exitCode = 1;
	}
}

/**
 * 只读加载 guided-verification-state（供 verification-state 输出与 complete/confirm 定位组用）。
 * ENOENT → 空组；解析失败 → 降级为空组并 warn。损坏隔离/重建是写路径（guided-verification-state 模块）的职责，
 * 只读路径不改盘。
 * ponytail: 直接读文件而非新增模块导出——本阶段只允许改 3 个文件，且这是纯容错读，无业务逻辑重造。
 */
async function readGuidedVerificationStateReadOnly(): Promise<RuntimeGuidedVerificationState> {
	const path = getGuidedVerificationStatePath();
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (isEnoent(error)) {
			return { deploymentGroups: [] };
		}
		throw error;
	}
	try {
		return parseGuidedVerificationState(JSON.parse(raw));
	} catch (error) {
		logDeploymentDiagnosticWarning(
			`[deployment] guided-verification-state 读取失败，按空状态处理（隔离/重建由写路径负责）：${toErrorMessage(error)}`,
		);
		return { deploymentGroups: [] };
	}
}

function findGroupInState(
	state: RuntimeGuidedVerificationState,
	deploymentId: string,
): RuntimeGuidedVerificationDeploymentGroup | null {
	return state.deploymentGroups.find((group) => group.deploymentId === deploymentId) ?? null;
}

function findTaskInGroup(
	group: RuntimeGuidedVerificationDeploymentGroup,
	taskId: string,
): RuntimeGuidedVerificationTask | null {
	return group.tasks.find((task) => task.taskId === taskId) ?? null;
}

function checklistFullyChecked(task: RuntimeGuidedVerificationTask): boolean {
	return task.checklist.length > 0 && task.checklist.every((item) => item.checked);
}

function acknowledgementSetsEqual(
	left: RuntimeGuidedVerificationAcknowledgement[],
	right: RuntimeGuidedVerificationAcknowledgement[],
): boolean {
	const leftSet = new Set(left);
	const rightSet = new Set(right);
	if (leftSet.size !== rightSet.size) {
		return false;
	}
	for (const value of leftSet) {
		if (!rightSet.has(value)) {
			return false;
		}
	}
	return true;
}

function acknowledgementMismatchMessage(required: RuntimeGuidedVerificationAcknowledgement[]): string {
	return required.length === 0
		? "This task requires no acknowledgements; pass --ack with an empty list."
		: `--ack must exactly match the required acknowledgements for the current column: ${required.join(", ")}.`;
}

function parseAcknowledgementList(value: string | undefined): RuntimeGuidedVerificationAcknowledgement[] {
	if (value === undefined) {
		return [];
	}
	const parts = value
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
	return parts.map((part) => {
		const result = runtimeGuidedVerificationAcknowledgementSchema.safeParse(part);
		if (!result.success) {
			throw new Error(`Invalid --ack value "${part}". Expected one of: skip_validation, in_progress_active.`);
		}
		return result.data;
	});
}

function parseRequiredBoolean(value: string, flagName: string): boolean {
	const normalized = value.trim().toLowerCase();
	if (normalized === "true" || normalized === "1" || normalized === "yes") {
		return true;
	}
	if (normalized === "false" || normalized === "0" || normalized === "no") {
		return false;
	}
	throw new Error(`Invalid boolean value for ${flagName}: "${value}". Use true or false.`);
}

function isExpiredIso(expiresAtIso: string, nowIso: string): boolean {
	const expiresMs = Date.parse(expiresAtIso);
	const nowMs = Date.parse(nowIso);
	return Number.isFinite(expiresMs) && Number.isFinite(nowMs) && expiresMs <= nowMs;
}

function truncateAgentResponsePreview(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length <= AGENT_RESPONSE_PREVIEW_MAX_CHARS) {
		return trimmed;
	}
	return `${trimmed.slice(0, AGENT_RESPONSE_PREVIEW_MAX_CHARS)}…`;
}

// 确认框 agent response 预览：CLI 路径统一取 latestHookActivity.finalMessage（经 live runtime 读会话摘要）。
// server 不在或无可用文本 → 返回 undefined（propose 路径仍返回 token，不因预览缺失而失败）。
// 限制（刻意）：Cline（agentId==="cline"）的「最后一条 assistant message」需 getTaskChatMessages，只在 server/tRPC
// 路径按 agent 类型分源接通（web 面板确认框，见 runtime-server.ts loadTaskAgentResponsePreview）；CLI offline 走
// workspace.getState 只能拿到 session 摘要、无从取 chat message，故此处对 Cline 也只回 finalMessage（缺省即 undefined），
// 不为此在 CLI 强行拉起 Cline SDK。
async function tryLoadAgentResponsePreview(workspaceId: string, taskId: string): Promise<string | undefined> {
	try {
		const client = createRuntimeTrpcClient(workspaceId);
		const state = await client.workspace.getState.query();
		const session = state.sessions[taskId] ?? null;
		const finalMessage = session?.latestHookActivity?.finalMessage ?? null;
		if (!finalMessage || finalMessage.trim().length === 0) {
			return undefined;
		}
		return truncateAgentResponsePreview(finalMessage);
	} catch {
		return undefined;
	}
}

interface LiveWorkspaceRuntime {
	client: ReturnType<typeof createRuntimeTrpcClient>;
	repoPath: string;
	board: RuntimeWorkspaceStateResponse["board"];
}

// 凡触发移列的路径都须 live runtime（plan server 依赖边界）：server 不在则明确报错、不静默降级
// （trashTaskById 内部对 tRPC 副作用是 catch-and-ignore，故必须在移列前显式探活）。
async function requireLiveWorkspaceRuntime(workspaceId: string): Promise<LiveWorkspaceRuntime> {
	const context = await loadWorkspaceContextById(workspaceId);
	if (!context) {
		throw new Error(`Workspace ${workspaceId} is not registered; cannot move its task to done.`);
	}
	const client = createRuntimeTrpcClient(workspaceId);
	try {
		const state = await client.workspace.getState.query();
		return { client, repoPath: context.repoPath, board: state.board };
	} catch (error) {
		throw new Error(
			`Guided Verification requires a running Kanban server at ${getKanbanRuntimeOrigin()} to move a task to done: ${toErrorMessage(error)}`,
		);
	}
}

async function moveTaskToDoneAndMarkVerified(input: {
	deploymentId: string;
	taskId: string;
	currentColumnId: RuntimeBoardColumnId;
	live: LiveWorkspaceRuntime;
	nowIso: string;
	forced: boolean;
}): Promise<JsonRecord> {
	const trashed = await trashTaskById({
		cwd: process.cwd(),
		taskId: input.taskId,
		projectPath: input.live.repoPath,
		workspaceRepoPath: input.live.repoPath,
		runtimeClient: input.live.client,
	});
	// 移列成功后才标记 verified（markTaskVerified 顺带清 pendingConfirmation token）。
	const marked = await markTaskVerified(input.deploymentId, input.taskId, input.nowIso);
	if (!marked.ok) {
		return { ok: false, error: marked.error ?? "Failed to mark task verified after moving it to done." };
	}
	return {
		ok: true,
		moved: true,
		forced: input.forced,
		previousColumn: input.currentColumnId,
		verifiedAt: marked.task?.verifiedAt ?? input.nowIso,
		worktreeDeleted: trashed.worktreeDeleted,
		...(trashed.worktreeDeleteError ? { worktreeDeleteError: trashed.worktreeDeleteError } : {}),
		task: marked.task,
	};
}

async function proposeVerificationConfirmation(input: {
	deploymentId: string;
	taskId: string;
	workspaceId: string;
	currentColumnId: RuntimeBoardColumnId;
	nowIso: string;
}): Promise<JsonRecord> {
	const requiredAcknowledgements = computeRequiredAcknowledgementsForColumn(input.currentColumnId);
	if (requiredAcknowledgements === null) {
		return {
			ok: false,
			needsConfirmation: false,
			error: `Task's current column "${input.currentColumnId}" is not a valid completion source (only validation, review, in_progress).`,
		};
	}
	const token = randomUUID();
	const expiresAtIso = new Date(Date.parse(input.nowIso) + CONFIRMATION_TOKEN_TTL_MS).toISOString();
	const pendingConfirmation: RuntimeGuidedVerificationPendingConfirmation = {
		token,
		expiresAtIso,
		requiredAcknowledgements,
		columnIdAtIssuance: input.currentColumnId,
	};
	const stored = await setPendingConfirmation(input.deploymentId, input.taskId, pendingConfirmation, input.nowIso);
	if (!stored.ok) {
		return { ok: false, needsConfirmation: false, error: stored.error };
	}
	const agentResponsePreview = await tryLoadAgentResponsePreview(input.workspaceId, input.taskId);
	return {
		ok: true,
		needsConfirmation: true,
		confirmationToken: token,
		expiresAtIso,
		columnIdAtIssuance: input.currentColumnId,
		requiredAcknowledgements,
		...(agentResponsePreview ? { agentResponsePreview } : {}),
	};
}

// ---- record ----

async function recordDeployment(input: {
	cwd: string;
	sourceCheckoutPath?: string;
	newCommit?: string;
	projectPath?: string;
}): Promise<JsonRecord> {
	const sourceCheckoutPath = input.sourceCheckoutPath
		? resolveProjectInputPath(input.sourceCheckoutPath, input.cwd)
		: input.cwd;
	// 关联任务的 workspace：显式 --project-path 优先，否则按 sourceCheckoutPath 定位（0 匹配即未注册 → 报错提示 --project-path）。
	const workspaceResolutionPath = input.projectPath
		? resolveProjectInputPath(input.projectPath, input.cwd)
		: sourceCheckoutPath;
	let workspace: Awaited<ReturnType<typeof loadWorkspaceContext>>;
	try {
		workspace = await loadWorkspaceContext(workspaceResolutionPath, { autoCreateIfMissing: false });
	} catch (error) {
		throw new Error(
			`Could not resolve a Kanban workspace for ${workspaceResolutionPath}: ${toErrorMessage(error)}. Pass --project-path to select a registered project.`,
		);
	}

	const revParse = await runGit(sourceCheckoutPath, ["rev-parse", input.newCommit ?? "HEAD"]);
	if (!revParse.ok || revParse.stdout.trim().length === 0) {
		throw new Error(
			`Could not resolve deploy commit "${input.newCommit ?? "HEAD"}" in ${sourceCheckoutPath}: ${revParse.error ?? revParse.stderr}`,
		);
	}
	const newSha = revParse.stdout.trim();

	const previousMarker = await readDeployMarker();
	const oldSha = previousMarker?.deployedSourceCommit ?? null;

	const board = await loadWorkspaceBoardById(workspace.workspaceId);
	const correlationTasks: DeploymentCorrelationTaskInput[] = [];
	for (const column of board.columns) {
		if (column.id !== "in_progress" && column.id !== "review") {
			continue;
		}
		for (const card of column.cards) {
			correlationTasks.push({
				taskId: card.id,
				columnId: column.id,
				cwd: workspace.repoPath,
				baseRef: card.baseRef,
				worktreeMode: card.worktreeMode,
			});
		}
	}
	const validationCards = board.columns.find((column) => column.id === "validation")?.cards ?? [];

	const candidates = await correlateTasksWithDeployDelta({
		sourceCheckoutPath,
		oldSha,
		newSha,
		tasks: correlationTasks,
	});

	const groupTasks: RuntimeGuidedVerificationTask[] = [];
	for (const candidate of candidates) {
		groupTasks.push(
			createGuidedVerificationTaskWithSeededChecklist({
				taskId: candidate.taskId,
				columnIdAtMatch: candidate.columnId,
				matchedCommits: candidate.matchedCommits,
				inclusionReason: "commit_correlation",
			}),
		);
	}
	for (const card of validationCards) {
		groupTasks.push(
			createGuidedVerificationTaskWithSeededChecklist({
				taskId: card.id,
				columnIdAtMatch: "validation",
				matchedCommits: [],
				inclusionReason: "validation_column",
			}),
		);
	}

	const deploymentId = randomUUID();
	const nowIso = new Date().toISOString();
	const { group, marker } = await createDeploymentGroup(
		{
			deploymentId,
			workspaceId: workspace.workspaceId,
			deployedSourceCommit: newSha,
			previousDeployedSourceCommit: oldSha,
			sourceCheckoutPath,
			packageVersion: KANBAN_PACKAGE_VERSION,
			tasks: groupTasks,
		},
		nowIso,
	);

	return {
		ok: true,
		deploymentId: group.deploymentId,
		workspaceId: group.workspaceId,
		workspacePath: workspace.repoPath,
		sourceCheckoutPath,
		deployedSourceCommit: group.deployedSourceCommit,
		previousDeployedSourceCommit: group.previousDeployedSourceCommit,
		deployedAtIso: group.deployedAtIso,
		packageVersion: marker.packageVersion,
		correlatedTaskCount: candidates.length,
		validationTaskCount: validationCards.length,
		totalVerificationTaskCount: groupTasks.length,
		noCorrelatedTasks: candidates.length === 0,
		tasks: groupTasks.map((task) => ({
			taskId: task.taskId,
			inclusionReason: task.inclusionReason,
			columnIdAtMatch: task.columnIdAtMatch,
			matchedCommits: task.matchedCommits,
			checklistItemCount: task.checklist.length,
		})),
	};
}

// ---- verification-summary ----

async function verificationSummary(input: { cwd: string; projectPath?: string }): Promise<JsonRecord> {
	const workspace = await loadWorkspaceContext(
		input.projectPath ? resolveProjectInputPath(input.projectPath, input.cwd) : input.cwd,
		{ autoCreateIfMissing: false },
	);
	const nowIso = new Date().toISOString();
	const activeGroup = await getActiveGroup(workspace.workspaceId, nowIso);
	if (!activeGroup) {
		return {
			ok: true,
			workspaceId: workspace.workspaceId,
			activeDeploymentId: null,
			pendingCount: 0,
			doneCount: 0,
			droppedCount: 0,
			noCorrelatedTasks: true,
		};
	}
	const liveTasks = activeGroup.tasks.filter((task) => task.droppedReason === null);
	const pendingCount = liveTasks.filter((task) => task.verifiedAt === null).length;
	const doneCount = liveTasks.filter((task) => task.verifiedAt !== null).length;
	const droppedCount = activeGroup.tasks.length - liveTasks.length;
	const noCorrelatedTasks = !activeGroup.tasks.some((task) => task.inclusionReason === "commit_correlation");
	return {
		ok: true,
		workspaceId: workspace.workspaceId,
		activeDeploymentId: activeGroup.deploymentId,
		deployedSourceCommit: activeGroup.deployedSourceCommit,
		previousDeployedSourceCommit: activeGroup.previousDeployedSourceCommit,
		deployedAtIso: activeGroup.deployedAtIso,
		pendingCount,
		doneCount,
		droppedCount,
		noCorrelatedTasks,
	};
}

// ---- verification-state ----

function latestActiveDeploymentId(groups: RuntimeGuidedVerificationDeploymentGroup[]): string | null {
	const active = groups
		.filter((group) => group.foldedAtIso === null)
		.sort((left, right) => Date.parse(right.deployedAtIso) - Date.parse(left.deployedAtIso));
	return active[0]?.deploymentId ?? null;
}

async function verificationState(input: {
	cwd: string;
	projectPath?: string;
	activeOnly?: boolean;
}): Promise<JsonRecord> {
	const state = await readGuidedVerificationStateReadOnly();
	let groups = state.deploymentGroups;
	if (input.projectPath !== undefined) {
		const workspace = await loadWorkspaceContext(resolveProjectInputPath(input.projectPath, input.cwd), {
			autoCreateIfMissing: false,
		});
		groups = groups.filter((group) => group.workspaceId === workspace.workspaceId);
	}
	// 无 --project-path 时 groups 是跨全部 workspace 的全集，单一标量 activeDeploymentId 在该模式下无良定义
	// （latestActiveDeploymentId 只会挑「谁最后部署」，可能属于调用方没在看的另一个 workspace）；仅在限定了
	// project 时才返回标量。deploymentGroups 各自带 workspaceId，全 dump 模式下由调用方自行按 workspace 消歧。
	const activeDeploymentId = input.projectPath !== undefined ? latestActiveDeploymentId(groups) : null;
	if (input.activeOnly) {
		groups = groups.filter((group) => group.foldedAtIso === null);
	}
	return { ok: true, activeDeploymentId, deploymentGroups: groups };
}

// ---- verification-update ----

function buildChecklistUpdateRequest(input: {
	deploymentId: string;
	taskId: string;
	itemId?: string;
	checked?: boolean;
	addCustomItem?: string;
	removeCustomItem?: string;
}): RuntimeUpdateVerificationChecklistRequest {
	const hasToggle = input.itemId !== undefined || input.checked !== undefined;
	const hasAdd = input.addCustomItem !== undefined;
	const hasRemove = input.removeCustomItem !== undefined;
	const selectedOperationCount = [hasToggle, hasAdd, hasRemove].filter(Boolean).length;
	if (selectedOperationCount !== 1) {
		throw new Error(
			"verification-update requires exactly one operation: (--item-id + --checked) | --add-custom-item | --remove-custom-item.",
		);
	}
	if (hasToggle) {
		if (input.itemId === undefined || input.checked === undefined) {
			throw new Error("Toggling a checklist item requires both --item-id and --checked.");
		}
		return {
			operation: "toggle_checklist_item",
			deploymentId: input.deploymentId,
			taskId: input.taskId,
			itemId: input.itemId,
			checked: input.checked,
		};
	}
	if (hasAdd) {
		return {
			operation: "add_custom_checklist_item",
			deploymentId: input.deploymentId,
			taskId: input.taskId,
			label: input.addCustomItem as string,
		};
	}
	return {
		operation: "remove_custom_checklist_item",
		deploymentId: input.deploymentId,
		taskId: input.taskId,
		itemId: input.removeCustomItem as string,
	};
}

async function verificationUpdate(input: {
	deploymentId: string;
	taskId: string;
	itemId?: string;
	checked?: boolean;
	addCustomItem?: string;
	removeCustomItem?: string;
}): Promise<JsonRecord> {
	const request = buildChecklistUpdateRequest(input);
	const result = await updateTaskChecklist(request, new Date().toISOString());
	return { ok: result.ok, task: result.task, ...(result.error ? { error: result.error } : {}) };
}

// ---- verification-complete ----

async function verificationComplete(input: { deploymentId: string; taskId: string }): Promise<JsonRecord> {
	const nowIso = new Date().toISOString();
	const state = await readGuidedVerificationStateReadOnly();
	const group = findGroupInState(state, input.deploymentId);
	if (!group) {
		return { ok: false, needsConfirmation: false, error: `Deployment group not found: ${input.deploymentId}` };
	}
	const task = findTaskInGroup(group, input.taskId);
	if (!task) {
		return {
			ok: false,
			needsConfirmation: false,
			error: `Task ${input.taskId} not found in deployment group ${input.deploymentId}.`,
		};
	}
	if (task.droppedReason !== null) {
		return {
			ok: false,
			needsConfirmation: false,
			error: `Task was dropped from verification (${task.droppedReason}).`,
		};
	}
	if (!checklistFullyChecked(task)) {
		return { ok: false, needsConfirmation: false, error: "Checklist is not fully checked yet." };
	}

	// 离线定当前列，使 review/in_progress 的 propose 路径无需 server。
	const board = await loadWorkspaceBoardById(group.workspaceId);
	const offlineColumnId = getTaskColumnId(board, input.taskId);
	if (!offlineColumnId) {
		return { ok: false, needsConfirmation: false, error: "Task is no longer on the board (deleted or moved out)." };
	}
	if (offlineColumnId === "trash") {
		return { ok: false, needsConfirmation: false, error: "Task is already in done." };
	}
	// 列门控与 Web 对齐（issue C）：仅 validation/review/in_progress 是合法完成来源；backlog 等非法列直接拒绝，
	// 否则后续 propose → verification-confirm/--force 可把手动移回 backlog、尚未 reconcile-dropped 的任务直接推入 Done。
	if (computeRequiredAcknowledgementsForColumn(offlineColumnId) === null) {
		return {
			ok: false,
			needsConfirmation: false,
			error: `Task's current column "${offlineColumnId}" is not a valid completion source (only validation, review, in_progress).`,
		};
	}

	if (offlineColumnId === "validation") {
		// validation 列直接完成（无确认）；移列需 live runtime。
		const live = await requireLiveWorkspaceRuntime(group.workspaceId);
		const liveColumnId = getTaskColumnId(live.board, input.taskId) ?? offlineColumnId;
		if (liveColumnId === "validation") {
			return await moveTaskToDoneAndMarkVerified({
				deploymentId: input.deploymentId,
				taskId: input.taskId,
				currentColumnId: liveColumnId,
				live,
				nowIso,
				forced: false,
			});
		}
		// 竞态：live 已流转出 validation → 回落 propose（按 live 列重算）。
		return await proposeVerificationConfirmation({
			deploymentId: input.deploymentId,
			taskId: input.taskId,
			workspaceId: group.workspaceId,
			currentColumnId: liveColumnId,
			nowIso,
		});
	}

	return await proposeVerificationConfirmation({
		deploymentId: input.deploymentId,
		taskId: input.taskId,
		workspaceId: group.workspaceId,
		currentColumnId: offlineColumnId,
		nowIso,
	});
}

// ---- verification-confirm ----

async function isForceCompleteEnabled(repoPath: string): Promise<boolean> {
	const config = await loadRuntimeConfig(repoPath);
	return config.guidedVerificationForceCompleteEnabled === true;
}

async function verificationConfirm(input: {
	deploymentId: string;
	taskId: string;
	token?: string;
	acks: RuntimeGuidedVerificationAcknowledgement[];
	force: boolean;
}): Promise<JsonRecord> {
	const nowIso = new Date().toISOString();
	if (input.force && input.token !== undefined) {
		return { ok: false, error: "--force and --token are mutually exclusive." };
	}
	if (!input.force && input.token === undefined) {
		return {
			ok: false,
			error: "verification-confirm requires --token (or --force with the runtime toggle enabled).",
		};
	}

	const state = await readGuidedVerificationStateReadOnly();
	const group = findGroupInState(state, input.deploymentId);
	if (!group) {
		return { ok: false, error: `Deployment group not found: ${input.deploymentId}` };
	}
	const task = findTaskInGroup(group, input.taskId);
	if (!task) {
		return { ok: false, error: `Task ${input.taskId} not found in deployment group ${input.deploymentId}.` };
	}
	if (task.droppedReason !== null) {
		return { ok: false, error: `Task was dropped from verification (${task.droppedReason}); cannot confirm.` };
	}
	if (!checklistFullyChecked(task)) {
		return { ok: false, error: "Checklist is not fully checked; cannot confirm." };
	}

	// confirm 会移列 → 需 live runtime；同时用 live 板确定当前列（全量重校验，不信任发放时快照）。
	const live = await requireLiveWorkspaceRuntime(group.workspaceId);
	const currentColumnId = getTaskColumnId(live.board, input.taskId);
	if (!currentColumnId) {
		return { ok: false, error: "Task is no longer on the board (deleted); cannot confirm." };
	}
	if (currentColumnId === "trash") {
		return { ok: false, error: "Task is already in done." };
	}
	// 列门控与 Web 对齐（issue C）：--force break-glass 与 token 两条路径都在此之后，故统一在此拒绝非法列（backlog 等），
	// 避免把手动移回 backlog、尚未 reconcile-dropped 的任务经 --force 或重发 token 直接推入 Done。
	const requiredAcknowledgements = computeRequiredAcknowledgementsForColumn(currentColumnId);
	if (requiredAcknowledgements === null) {
		return {
			ok: false,
			error: `Task's current column "${currentColumnId}" is not a valid completion source (only validation, review, in_progress); cannot confirm.`,
		};
	}

	if (input.force) {
		if (!(await isForceCompleteEnabled(live.repoPath))) {
			return {
				ok: false,
				error: "--force requires guidedVerificationForceCompleteEnabled to be enabled in the runtime config.",
			};
		}
		if (!acknowledgementSetsEqual(input.acks, requiredAcknowledgements)) {
			return {
				ok: false,
				error: acknowledgementMismatchMessage(requiredAcknowledgements),
				requiredAcknowledgements,
			};
		}
		return await moveTaskToDoneAndMarkVerified({
			deploymentId: input.deploymentId,
			taskId: input.taskId,
			currentColumnId,
			live,
			nowIso,
			forced: true,
		});
	}

	// token 两步路径：手动校验 token（不提前消费），移列成功后 markTaskVerified 才清 token
	// （移列失败则 token 保留供重试，避免「标记完成但实际未移列」）。
	const pending = task.pendingConfirmation;
	if (!pending) {
		return { ok: false, error: "No pending confirmation; run verification-complete first." };
	}
	if (pending.token !== input.token) {
		return { ok: false, error: "Confirmation token mismatch." };
	}
	if (isExpiredIso(pending.expiresAtIso, nowIso)) {
		return { ok: false, error: "Confirmation token expired; re-run verification-complete." };
	}
	if (pending.columnIdAtIssuance !== currentColumnId) {
		// 列已变（如自动流转）→ token 失效，按当前列重发新 token。
		const reissuedToken = randomUUID();
		const expiresAtIso = new Date(Date.parse(nowIso) + CONFIRMATION_TOKEN_TTL_MS).toISOString();
		await setPendingConfirmation(
			input.deploymentId,
			input.taskId,
			{ token: reissuedToken, expiresAtIso, requiredAcknowledgements, columnIdAtIssuance: currentColumnId },
			nowIso,
		);
		return {
			ok: false,
			error: "Task column changed since token issuance; re-confirm with the reissued token.",
			reissuedConfirmationToken: reissuedToken,
			requiredAcknowledgements,
		};
	}
	if (!acknowledgementSetsEqual(input.acks, requiredAcknowledgements)) {
		return { ok: false, error: acknowledgementMismatchMessage(requiredAcknowledgements), requiredAcknowledgements };
	}

	return await moveTaskToDoneAndMarkVerified({
		deploymentId: input.deploymentId,
		taskId: input.taskId,
		currentColumnId,
		live,
		nowIso,
		forced: false,
	});
}

export function registerDeploymentCommand(program: Command): void {
	const deployment = program
		.command("deployment")
		.description("Record deployments and drive Guided Verification from the CLI.");

	deployment
		.command("record")
		.description("Record a deployment: write the deploy marker and create a new Guided Verification group.")
		.option(
			"--source-checkout-path <path>",
			"Kanban source checkout where the deploy delta is computed. Defaults to cwd.",
		)
		.option("--new-commit <ref>", "The newly deployed source commit/ref. Defaults to HEAD.")
		.option(
			"--project-path <path>",
			"Registered project whose tasks to correlate. Defaults to matching the source checkout path.",
		)
		.action(async (options: { sourceCheckoutPath?: string; newCommit?: string; projectPath?: string }) => {
			await runDeploymentCommand(
				async () =>
					await recordDeployment({
						cwd: process.cwd(),
						sourceCheckoutPath: options.sourceCheckoutPath,
						newCommit: options.newCommit,
						projectPath: options.projectPath,
					}),
			);
		});

	deployment
		.command("verification-summary")
		.description("Summarize the active Guided Verification group for a workspace.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { projectPath?: string }) => {
			await runDeploymentCommand(
				async () => await verificationSummary({ cwd: process.cwd(), projectPath: options.projectPath }),
			);
		});

	deployment
		.command("verification-state")
		.description("Print the full Guided Verification state (all deployment groups, including folded history).")
		.option("--project-path <path>", "Filter to a single workspace. Defaults to all workspaces.")
		.option("--active-only", "Only include active (not-yet-folded) deployment groups.")
		.action(async (options: { projectPath?: string; activeOnly?: boolean }) => {
			await runDeploymentCommand(
				async () =>
					await verificationState({
						cwd: process.cwd(),
						projectPath: options.projectPath,
						activeOnly: options.activeOnly === true,
					}),
			);
		});

	deployment
		.command("verification-update")
		.description("Toggle a checklist item, or add/remove a custom checklist item, for a verification task.")
		.requiredOption("--deployment-id <id>", "Deployment group id.")
		.requiredOption("--task-id <id>", "Task id within the deployment group.")
		.option("--item-id <id>", "Checklist item id to toggle (requires --checked).")
		.option("--checked <value>", "New checked state for --item-id (true|false).")
		.option("--add-custom-item <label>", "Add a new custom checklist item with this label.")
		.option("--remove-custom-item <id>", "Remove a custom checklist item by id.")
		.action(
			async (options: {
				deploymentId: string;
				taskId: string;
				itemId?: string;
				checked?: string;
				addCustomItem?: string;
				removeCustomItem?: string;
			}) => {
				await runDeploymentCommand(
					async () =>
						await verificationUpdate({
							deploymentId: options.deploymentId,
							taskId: options.taskId,
							itemId: options.itemId,
							checked:
								options.checked === undefined ? undefined : parseRequiredBoolean(options.checked, "--checked"),
							addCustomItem: options.addCustomItem,
							removeCustomItem: options.removeCustomItem,
						}),
				);
			},
		);

	deployment
		.command("verification-complete")
		.description("Propose moving a fully-checked verification task to done (validation column completes directly).")
		.requiredOption("--deployment-id <id>", "Deployment group id.")
		.requiredOption("--task-id <id>", "Task id within the deployment group.")
		.action(async (options: { deploymentId: string; taskId: string }) => {
			await runDeploymentCommand(
				async () => await verificationComplete({ deploymentId: options.deploymentId, taskId: options.taskId }),
			);
		});

	deployment
		.command("verification-confirm")
		.description("Confirm moving a verification task to done using a confirmation token (or --force break-glass).")
		.requiredOption("--deployment-id <id>", "Deployment group id.")
		.requiredOption("--task-id <id>", "Task id within the deployment group.")
		.option("--token <token>", "Confirmation token from verification-complete. Mutually exclusive with --force.")
		.option(
			"--ack <list>",
			"Comma-separated acknowledgements (skip_validation,in_progress_active) required by the current column.",
		)
		.option("--force", "Break-glass: skip the token handshake. Requires guidedVerificationForceCompleteEnabled.")
		.action(
			async (options: { deploymentId: string; taskId: string; token?: string; ack?: string; force?: boolean }) => {
				await runDeploymentCommand(
					async () =>
						await verificationConfirm({
							deploymentId: options.deploymentId,
							taskId: options.taskId,
							token: options.token,
							acks: parseAcknowledgementList(options.ack),
							force: options.force === true,
						}),
				);
			},
		);
}
