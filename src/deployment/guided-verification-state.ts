import { randomUUID } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type {
	RuntimeBoardColumnId,
	RuntimeDeploymentMarker,
	RuntimeGuidedVerificationAcknowledgement,
	RuntimeGuidedVerificationChecklistItem,
	RuntimeGuidedVerificationDeploymentGroup,
	RuntimeGuidedVerificationInclusionReason,
	RuntimeGuidedVerificationPendingConfirmation,
	RuntimeGuidedVerificationState,
	RuntimeGuidedVerificationTask,
	RuntimeUpdateVerificationChecklistRequest,
} from "../core/api-contract";
import { parseGuidedVerificationState } from "../core/api-validation";
import { logDeploymentDiagnosticWarning } from "../diagnostics/deployment-diagnostics-logger";
import type { LockRequest } from "../fs/locked-file-system";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "../state/workspace-state";
import { writeDeployMarker } from "./deploy-marker";

// ~/.cline/kanban/guided-verification-state.json —— 跨 workspace 的单一全局文件（plan 1c）。
const GUIDED_VERIFICATION_STATE_FILENAME = "guided-verification-state.json";
// 历史（已折叠）组封顶；未折叠的活跃组恒保留、不参与裁剪。
const MAX_RETAINED_FOLDED_DEPLOYMENT_GROUPS = 20;
// validation 列任务无 commit 关联时 seed 的通用手工验证项 id（稳定值，勾选状态跨 reconcile 保留）。
const MANUAL_VERIFICATION_CHECKLIST_ITEM_ID = "manual-smoke-test-on-deployed-build";

export function getGuidedVerificationStatePath(): string {
	return join(getRuntimeHomePath(), GUIDED_VERIFICATION_STATE_FILENAME);
}

// 单一全局锁：state 被 CLI / tRPC mutation / 轮询 reconcile 三方读改写，写频率低，不做分组锁。
// ponytail: global lock, per-workspace 锁只有在写吞吐成为瓶颈时才需要——dogfood 场景不会。
function getGuidedVerificationStateLockRequest(): LockRequest {
	return { path: getGuidedVerificationStatePath(), type: "file" };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isExpired(expiresAtIso: string, nowMs: number): boolean {
	const expiresMs = Date.parse(expiresAtIso);
	return Number.isFinite(expiresMs) && expiresMs <= nowMs;
}

// 按任务「当前列」决定入 Done 需显式确认的项（plan 1d / Grilling #6）；返回 null = 该列不是合法完成来源。
// 合法完成来源仅 validation / review / in_progress；backlog / trash / done 等一律 null（拒绝完成核对）。
// Web（trpc/deployment-api）与 CLI（commands/deployment）共用此单一真源，保证两侧列门控严格一致（issue C）。
export function computeRequiredAcknowledgementsForColumn(
	columnId: RuntimeBoardColumnId,
): RuntimeGuidedVerificationAcknowledgement[] | null {
	switch (columnId) {
		case "validation":
			return [];
		case "review":
			return ["skip_validation"];
		case "in_progress":
			return ["skip_validation", "in_progress_active"];
		default:
			return null;
	}
}

// 损坏 JSON 不 throw：把损坏文件改名隔离（.corrupt-<调用方传入时间戳>），降级为空组重建并 warn。
// 隔离后原路径消失 → 下次读为 ENOENT → 空组，无需另写空文件。
async function readGuidedVerificationStateCorruptionTolerant(
	corruptIsolationTimestamp: string,
): Promise<RuntimeGuidedVerificationState> {
	const path = getGuidedVerificationStatePath();
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return { deploymentGroups: [] };
		}
		throw error;
	}
	try {
		return parseGuidedVerificationState(JSON.parse(raw));
	} catch (error) {
		const isolatedPath = `${path}.corrupt-${corruptIsolationTimestamp}`;
		try {
			await rename(path, isolatedPath);
		} catch {
			// 隔离改名失败不阻塞降级：仍返回空组，下一次写入会覆盖损坏内容。
		}
		logDeploymentDiagnosticWarning(
			`[guided-verification-state] state JSON 损坏，已隔离为 ${isolatedPath}，降级为空组重建：${errorMessage(error)}`,
		);
		return { deploymentGroups: [] };
	}
}

// 写盘前归一化：GC 过期 pendingConfirmation + 裁剪历史组至封顶（活跃组永不裁剪）。
// exemptFromRetentionDeploymentId：本次 mutation 正在触达的组，即使是最旧折叠组也豁免裁剪（finding #4）。
function normalizeStateForPersistence(
	state: RuntimeGuidedVerificationState,
	nowIso: string,
	exemptFromRetentionDeploymentId?: string,
): RuntimeGuidedVerificationState {
	const nowMs = Date.parse(nowIso);
	const gcApplied = state.deploymentGroups.map((group) => ({
		...group,
		tasks: group.tasks.map((task) =>
			task.pendingConfirmation !== null &&
			Number.isFinite(nowMs) &&
			isExpired(task.pendingConfirmation.expiresAtIso, nowMs)
				? { ...task, pendingConfirmation: null }
				: task,
		),
	}));

	const activeGroups = gcApplied.filter((group) => group.foldedAtIso === null);
	const foldedGroups = gcApplied
		.filter((group) => group.foldedAtIso !== null)
		.sort((left, right) => Date.parse(left.deployedAtIso) - Date.parse(right.deployedAtIso));
	const retainedFolded =
		foldedGroups.length > MAX_RETAINED_FOLDED_DEPLOYMENT_GROUPS
			? foldedGroups.slice(foldedGroups.length - MAX_RETAINED_FOLDED_DEPLOYMENT_GROUPS)
			: foldedGroups;
	// 豁免：若本次 mutation 触达的折叠组被裁掉，补回它——否则该组内的改动会返回 ok 却随裁剪丢失（不落盘）。
	if (
		exemptFromRetentionDeploymentId !== undefined &&
		!retainedFolded.some((group) => group.deploymentId === exemptFromRetentionDeploymentId)
	) {
		const exemptGroup = foldedGroups.find((group) => group.deploymentId === exemptFromRetentionDeploymentId);
		if (exemptGroup) {
			retainedFolded.unshift(exemptGroup);
		}
	}

	const merged = [...retainedFolded, ...activeGroups].sort(
		(left, right) => Date.parse(left.deployedAtIso) - Date.parse(right.deployedAtIso),
	);
	return { deploymentGroups: merged };
}

// 通用 read-modify-write 骨架：全程持锁；mutator 就地改 state 并返回结果。
// 返回值直接引用 mutator 触达的 task —— 该 task 的持久化形态与内存态一致（GC 只清 mutator 未触达任务的过期 token），故引用可信。
// touchedDeploymentId：本次 mutation 定位的组（如有），传给 normalize 令 retention 裁剪豁免该组，避免改动落在将被裁的最旧折叠组时丢写（finding #4）。
async function mutateGuidedVerificationState<ResultType>(
	nowIso: string,
	mutator: (state: RuntimeGuidedVerificationState) => ResultType,
	touchedDeploymentId?: string,
): Promise<ResultType> {
	return await lockedFileSystem.withLock(getGuidedVerificationStateLockRequest(), async () => {
		const state = await readGuidedVerificationStateCorruptionTolerant(nowIso);
		const result = mutator(state);
		const normalized = normalizeStateForPersistence(state, nowIso, touchedDeploymentId);
		await lockedFileSystem.writeJsonFileAtomic(getGuidedVerificationStatePath(), normalized, { lock: null });
		return result;
	});
}

function findGroup(
	state: RuntimeGuidedVerificationState,
	deploymentId: string,
): RuntimeGuidedVerificationDeploymentGroup | null {
	return state.deploymentGroups.find((group) => group.deploymentId === deploymentId) ?? null;
}

function findTask(
	state: RuntimeGuidedVerificationState,
	deploymentId: string,
	taskId: string,
): RuntimeGuidedVerificationTask | null {
	return findGroup(state, deploymentId)?.tasks.find((task) => task.taskId === taskId) ?? null;
}

function taskNotFoundError(deploymentId: string, taskId: string): string {
	return `任务未找到：deploymentId=${deploymentId} taskId=${taskId}`;
}

/**
 * 构造带 seed checklist 的验证任务（未勾）。record 建组与 reconcile 动态加入 validation 任务共用，
 * 保证 checklist seed 策略一致；checklist 跨 deploy 不继承由「每次进新组都新建任务」天然满足（plan Grilling #7）。
 */
export function createGuidedVerificationTaskWithSeededChecklist(input: {
	taskId: string;
	columnIdAtMatch: RuntimeBoardColumnId;
	matchedCommits: string[];
	inclusionReason: RuntimeGuidedVerificationInclusionReason;
	// 可选 sha → 简短标题，用于 commit 项标签；缺省用短 sha。
	commitChecklistLabels?: Record<string, string>;
}): RuntimeGuidedVerificationTask {
	const checklist: RuntimeGuidedVerificationChecklistItem[] = input.matchedCommits.map((sha) => ({
		id: `commit:${sha}`,
		label: input.commitChecklistLabels?.[sha] ?? `验证提交 ${sha.slice(0, 8)}`,
		checked: false,
		source: "commit",
	}));
	// 无 commit 项（如 validation 列纯纳入）时 seed 一条通用手工验证项，避免空 checklist 永远无法「全勾完成」。
	if (checklist.length === 0) {
		checklist.push({
			id: MANUAL_VERIFICATION_CHECKLIST_ITEM_ID,
			label: "在已部署 build 上手工验证",
			checked: false,
			source: "commit",
		});
	}
	return {
		taskId: input.taskId,
		columnIdAtMatch: input.columnIdAtMatch,
		matchedCommits: input.matchedCommits,
		inclusionReason: input.inclusionReason,
		checklist,
		verifiedAt: null,
		boardMovedToDoneAt: null,
		pendingConfirmation: null,
		droppedReason: null,
	};
}

export interface CreateDeploymentGroupInput {
	deploymentId: string;
	workspaceId: string;
	deployedSourceCommit: string;
	previousDeployedSourceCommit: string | null;
	sourceCheckoutPath: string;
	packageVersion: string;
	tasks: RuntimeGuidedVerificationTask[];
}

/**
 * 记录一次部署：折叠该 workspace 之前的活跃组进历史、追加新组，并在同一次 state 锁内连带写 marker，避免半写。
 * 时间戳全部用调用方传入的 nowIso。
 */
export async function createDeploymentGroup(
	input: CreateDeploymentGroupInput,
	nowIso: string,
): Promise<{ group: RuntimeGuidedVerificationDeploymentGroup; marker: RuntimeDeploymentMarker }> {
	const group: RuntimeGuidedVerificationDeploymentGroup = {
		deploymentId: input.deploymentId,
		workspaceId: input.workspaceId,
		deployedSourceCommit: input.deployedSourceCommit,
		previousDeployedSourceCommit: input.previousDeployedSourceCommit,
		deployedAtIso: nowIso,
		foldedAtIso: null,
		tasks: input.tasks,
	};
	const marker: RuntimeDeploymentMarker = {
		deploymentId: input.deploymentId,
		deployedSourceCommit: input.deployedSourceCommit,
		deployedAtIso: nowIso,
		sourceCheckoutPath: input.sourceCheckoutPath,
		packageVersion: input.packageVersion,
		...(input.previousDeployedSourceCommit !== null
			? { previousDeployedSourceCommit: input.previousDeployedSourceCommit }
			: {}),
	};

	return await lockedFileSystem.withLock(getGuidedVerificationStateLockRequest(), async () => {
		const state = await readGuidedVerificationStateCorruptionTolerant(nowIso);
		for (const existing of state.deploymentGroups) {
			if (existing.workspaceId === input.workspaceId && existing.foldedAtIso === null) {
				existing.foldedAtIso = nowIso;
			}
		}
		state.deploymentGroups.push(group);
		const normalized = normalizeStateForPersistence(state, nowIso);
		// marker + state 同一次锁内写入（均 lock:null 跳过内层加锁，由外层 state 锁串行化）。
		await lockedFileSystem.writeJsonFileAtomic(getGuidedVerificationStatePath(), normalized, { lock: null });
		await writeDeployMarker(marker, { lock: null });
		return { group, marker };
	});
}

/**
 * 取某 workspace 的活跃组 = foldedAtIso === null 中 deployedAtIso 最新的一组；无则 null。
 * 经 mutate 骨架读取，顺带 GC 过期 token（内容无变化则原子写自动短路，不产生写盘）。
 */
export async function getActiveGroup(
	workspaceId: string,
	nowIso: string,
): Promise<RuntimeGuidedVerificationDeploymentGroup | null> {
	return await mutateGuidedVerificationState(nowIso, (state) => {
		const active = state.deploymentGroups
			.filter((group) => group.workspaceId === workspaceId && group.foldedAtIso === null)
			.sort((left, right) => Date.parse(right.deployedAtIso) - Date.parse(left.deployedAtIso));
		return active[0] ?? null;
	});
}

export interface GuidedVerificationTaskMutationResult {
	ok: boolean;
	task: RuntimeGuidedVerificationTask | null;
	error?: string;
}

/**
 * 勾选 / 增删自定义 checklist 项。定位键 (deploymentId, taskId)；commit 项不可删（仅 custom 可删）。
 */
export async function updateTaskChecklist(
	request: RuntimeUpdateVerificationChecklistRequest,
	nowIso: string,
): Promise<GuidedVerificationTaskMutationResult> {
	return await mutateGuidedVerificationState(
		nowIso,
		(state) => {
			const task = findTask(state, request.deploymentId, request.taskId);
			if (!task) {
				return { ok: false, task: null, error: taskNotFoundError(request.deploymentId, request.taskId) };
			}
			switch (request.operation) {
				case "toggle_checklist_item": {
					const item = task.checklist.find((entry) => entry.id === request.itemId);
					if (!item) {
						return { ok: false, task, error: `checklist 项未找到：${request.itemId}` };
					}
					item.checked = request.checked;
					return { ok: true, task };
				}
				case "add_custom_checklist_item": {
					task.checklist.push({ id: randomUUID(), label: request.label, checked: false, source: "custom" });
					return { ok: true, task };
				}
				case "remove_custom_checklist_item": {
					const item = task.checklist.find((entry) => entry.id === request.itemId);
					if (!item) {
						return { ok: false, task, error: `checklist 项未找到：${request.itemId}` };
					}
					if (item.source !== "custom") {
						return { ok: false, task, error: `仅可删除自定义 checklist 项：${request.itemId}` };
					}
					task.checklist = task.checklist.filter((entry) => entry.id !== request.itemId);
					return { ok: true, task };
				}
			}
		},
		request.deploymentId,
	);
}

/**
 * 持久化 pendingConfirmation（token/过期/需确认项/发放时列）。token 跨进程两步确认必须落盘、不能只放内存（plan Grilling #8）。
 */
export async function setPendingConfirmation(
	deploymentId: string,
	taskId: string,
	pendingConfirmation: RuntimeGuidedVerificationPendingConfirmation,
	nowIso: string,
): Promise<GuidedVerificationTaskMutationResult> {
	return await mutateGuidedVerificationState(
		nowIso,
		(state) => {
			const task = findTask(state, deploymentId, taskId);
			if (!task) {
				return { ok: false, task: null, error: taskNotFoundError(deploymentId, taskId) };
			}
			task.pendingConfirmation = pendingConfirmation;
			return { ok: true, task };
		},
		deploymentId,
	);
}

export type ConsumePendingConfirmationFailureReason =
	| "task_not_found"
	| "no_pending_confirmation"
	| "token_mismatch"
	| "expired";

export interface ConsumePendingConfirmationResult {
	ok: boolean;
	task: RuntimeGuidedVerificationTask | null;
	failureReason?: ConsumePendingConfirmationFailureReason;
}

/**
 * 校验并一次性消费 pendingConfirmation token：token 不符 / 已过期均失败（过期时顺带清除）；
 * 通过则清空 pendingConfirmation。列变化等更高层重校验（重算 requiredAcknowledgements）归调用方 handler。
 */
export async function consumePendingConfirmation(
	deploymentId: string,
	taskId: string,
	token: string,
	nowIso: string,
): Promise<ConsumePendingConfirmationResult> {
	return await mutateGuidedVerificationState(
		nowIso,
		(state) => {
			const task = findTask(state, deploymentId, taskId);
			if (!task) {
				return { ok: false, task: null, failureReason: "task_not_found" };
			}
			const pending = task.pendingConfirmation;
			if (!pending) {
				return { ok: false, task, failureReason: "no_pending_confirmation" };
			}
			if (pending.token !== token) {
				return { ok: false, task, failureReason: "token_mismatch" };
			}
			if (isExpired(pending.expiresAtIso, Date.parse(nowIso))) {
				task.pendingConfirmation = null;
				return { ok: false, task, failureReason: "expired" };
			}
			task.pendingConfirmation = null;
			return { ok: true, task };
		},
		deploymentId,
	);
}

export interface ConsumePendingConfirmationAndMarkVerifiedResult {
	ok: boolean;
	task: RuntimeGuidedVerificationTask | null;
	failureReason?: ConsumePendingConfirmationFailureReason;
	// true = 任务此前已 verified，本次为幂等命中（未再校验/消费 token），见 issue B。
	alreadyVerified?: boolean;
}

/**
 * 原子「消费 token + 标记完成」：在单次 state 锁内校验并一次性消费 pendingConfirmation token，随后立即置
 * verifiedAt / boardMovedToDoneAt / 清 pendingConfirmation / 清误标 droppedReason。issue B：把 consume 与 mark
 * 合并为一次读改写，消除「token 已消费但 markTaskVerified 失败」的中间坏态（该坏态不再可达，无需 tokenless 再标记）。
 * 幂等：任务此前已 verified 直接返回 ok（confirm 成功但响应丢失 / 重复提交的恢复），不再要求 token 存在。
 * 仅更新 verification state，绝不移列（移列职责在 Web/CLI，见 plan 1d）。
 */
export async function consumePendingConfirmationAndMarkVerified(
	deploymentId: string,
	taskId: string,
	token: string,
	nowIso: string,
): Promise<ConsumePendingConfirmationAndMarkVerifiedResult> {
	return await mutateGuidedVerificationState(
		nowIso,
		(state) => {
			const task = findTask(state, deploymentId, taskId);
			if (!task) {
				return { ok: false, task: null, failureReason: "task_not_found" as const };
			}
			if (task.verifiedAt !== null) {
				return { ok: true, task, alreadyVerified: true };
			}
			const pending = task.pendingConfirmation;
			if (!pending) {
				return { ok: false, task, failureReason: "no_pending_confirmation" as const };
			}
			if (pending.token !== token) {
				return { ok: false, task, failureReason: "token_mismatch" as const };
			}
			if (isExpired(pending.expiresAtIso, Date.parse(nowIso))) {
				task.pendingConfirmation = null;
				return { ok: false, task, failureReason: "expired" as const };
			}
			task.verifiedAt = nowIso;
			task.boardMovedToDoneAt = nowIso;
			task.pendingConfirmation = null;
			// 同 markTaskVerified：核对完成宽容清除误标 droppedReason（finding #3），避免被 liveTasks 过滤器排除出 done 计数。
			task.droppedReason = null;
			return { ok: true, task };
		},
		deploymentId,
	);
}

/**
 * 标记任务已核对完成：置 verifiedAt / boardMovedToDoneAt 为 nowIso，并清 pendingConfirmation。
 * 仅更新 verification state，绝不移列（移列职责在 Web/CLI，见 plan 1d）。
 */
export async function markTaskVerified(
	deploymentId: string,
	taskId: string,
	nowIso: string,
): Promise<GuidedVerificationTaskMutationResult> {
	return await mutateGuidedVerificationState(
		nowIso,
		(state) => {
			const task = findTask(state, deploymentId, taskId);
			if (!task) {
				return { ok: false, task: null, error: taskNotFoundError(deploymentId, taskId) };
			}
			task.verifiedAt = nowIso;
			task.boardMovedToDoneAt = nowIso;
			task.pendingConfirmation = null;
			// 核对完成宽容清除 droppedReason（finding #3）：Web「先移入 trash 后 confirm」的时间窗里，
			// reconcile 可能已把在途任务误标 moved_out_manually；已核对完成的任务绝不应再带 droppedReason，
			// 否则会被 verification-summary 的 liveTasks(droppedReason===null) 过滤器排除出 done 计数。
			task.droppedReason = null;
			return { ok: true, task };
		},
		deploymentId,
	);
}

export interface ReconcileGroupBoardTask {
	taskId: string;
	columnId: RuntimeBoardColumnId;
}

export interface ReconcileGroupInput {
	deploymentId: string;
	// 当前看板上该 workspace 的任务快照；缺席某 taskId 即视为已删除。
	currentBoardTasks: ReconcileGroupBoardTask[];
	nowIso: string;
}

/**
 * 双向 reconcile 当前组（plan「任务纳入规则」）：
 *  - 方向一：组内未核对任务已从看板删除 → droppedReason="task_deleted"；未经核对被手动移入 trash/backlog → "moved_out_manually"。
 *  - 方向二：deploy 后新进 validation 列的任务动态加入本组（inclusionReason="validation_column"，seed 未勾 checklist）。
 * 找不到组返回 null。
 */
export async function reconcileGroup(
	input: ReconcileGroupInput,
): Promise<RuntimeGuidedVerificationDeploymentGroup | null> {
	return await mutateGuidedVerificationState(
		input.nowIso,
		(state) => {
			const group = findGroup(state, input.deploymentId);
			if (!group) {
				return null;
			}
			const columnByTaskId = new Map(
				input.currentBoardTasks.map((boardTask) => [boardTask.taskId, boardTask.columnId]),
			);

			for (const task of group.tasks) {
				if (task.verifiedAt !== null || task.droppedReason !== null) {
					continue;
				}
				const currentColumn = columnByTaskId.get(task.taskId);
				if (currentColumn === undefined) {
					task.droppedReason = "task_deleted";
					continue;
				}
				// confirmation 在途（pendingConfirmation !== null）= Web 已「先移入 trash、正要 confirm」，不算手动移出（finding #3）；
				// 跳过标记，避免与 confirmVerificationComplete 竞态出「同时带 verifiedAt 与 droppedReason」的坏态。
				if ((currentColumn === "trash" || currentColumn === "backlog") && task.pendingConfirmation === null) {
					task.droppedReason = "moved_out_manually";
				}
			}

			const existingTaskIds = new Set(group.tasks.map((task) => task.taskId));
			for (const boardTask of input.currentBoardTasks) {
				if (boardTask.columnId !== "validation" || existingTaskIds.has(boardTask.taskId)) {
					continue;
				}
				group.tasks.push(
					createGuidedVerificationTaskWithSeededChecklist({
						taskId: boardTask.taskId,
						columnIdAtMatch: boardTask.columnId,
						matchedCommits: [],
						inclusionReason: "validation_column",
					}),
				);
			}
			return group;
		},
		input.deploymentId,
	);
}
