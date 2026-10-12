import { randomUUID } from "node:crypto";
import { access, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type {
	RuntimeBoardColumnId,
	RuntimeDeploymentMarker,
	RuntimePostDeployVerificationAcknowledgement,
	RuntimePostDeployVerificationChecklistItem,
	RuntimePostDeployVerificationChecklistItemSource,
	RuntimePostDeployVerificationCompletionPath,
	RuntimePostDeployVerificationDeploymentGroup,
	RuntimePostDeployVerificationPendingConfirmation,
	RuntimePostDeployVerificationRun,
	RuntimePostDeployVerificationState,
	RuntimePostDeployVerificationTask,
	RuntimePostDeployVerificationUncheckedChecklistItemClosureReason,
	RuntimeUpdateVerificationChecklistRequest,
} from "../core/api-contract";
import { parsePostDeployVerificationState } from "../core/api-validation";
import { logDeploymentDiagnosticWarning } from "../diagnostics/deployment-diagnostics-logger";
import type { LockRequest } from "../fs/locked-file-system";
import { lockedFileSystem } from "../fs/locked-file-system";
import type { PostDeployVerificationCompletionEvidence } from "../inter-work-unit-relation-ledger/post-deploy-verification-passed-observation-recording";
import { getRuntimeHomePath } from "../state/workspace-state";
import { materializeAuthoredVerificationItemsForWorkspaceTasks } from "./authored-verification-definitions";
import { writeDeployMarker } from "./deploy-marker";
import {
	applyPostDeployVerificationClosureToTaskWithinStateLock,
	isChecklistOfPostDeployVerificationTaskFullyChecked,
	markPostDeployVerificationTaskEnteredDoneWithoutProvableClosureWithinStateLock,
	type PostDeployVerificationTaskClosedWithinStateLock,
	readConfirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlagOfKanbanCliCompletionAuthorization,
	resolvePostDeployVerificationClosureProvableFromCurrentChecklist,
	resolveUncheckedChecklistItemClosureReasonsForPostDeployVerificationTask,
	runPostDeployVerificationClosureSideEffectsOutsideStateLock,
} from "./post-deploy-verification-closure-application";
import {
	assemblePostDeployVerificationTaskForDeploymentGroup,
	isGenericManualSmokeTestOnDeployedBuildChecklistItem,
	isPostDeployVerificationTaskAwaitingVerification,
	isPostDeployVerificationTaskClosed,
	mergeAuthoredChecklistItemsAndReconcileGenericManualSmokeTestItem,
	reconcileCarriedForwardDeploymentGroupTaskAgainstPreviousCopyWithinStateLock,
} from "./post-deploy-verification-deployment-group-task-assembly";
import type { TaskDeploymentAttributionComputation } from "./task-deployment-attribution-from-commit-integration-provenance";

// ~/.cline/kanban/post-deploy-verification-state.json —— 跨 workspace 的单一全局文件（plan 1c）。
const POST_DEPLOY_VERIFICATION_STATE_FILENAME = "post-deploy-verification-state.json";
// Legacy 文件名（Post-Deploy Verification 全量重命名前叫 Guided Verification）。仅用于读时一次性迁移：
// 新文件缺失且旧文件在场时 rename 旧→新，无数据丢失；迁移后旧路径消失，后续读走新文件。
const LEGACY_GUIDED_VERIFICATION_STATE_FILENAME = "guided-verification-state.json";
// 历史（已折叠）组封顶；未折叠的活跃组恒保留、不参与裁剪。
const MAX_RETAINED_FOLDED_DEPLOYMENT_GROUPS = 20;
// EXPERIMENT_NODE: 第三区（提交还没随部署上线 / 无从归属）任务的归属多久重算一次（10 分钟）；提交来历由 worktree 元数据轮询
// 刷新，任务落地后要等一次重算才挪进第二区——太短则每轮对账都为这批任务起 git，太长则落地后迟迟不显示「已上线」。
const UNDEPLOYED_OR_UNATTRIBUTABLE_TASK_DEPLOYMENT_ATTRIBUTION_RECOMPUTE_INTERVAL_MS = 10 * 60 * 1000;
// EXPERIMENT_NODE: 门禁授权后、移列成功却没写成结案的在途授权，runtime 对账至少等这么久才替它补完（30s）——给同一请求里的
// finalize 留出时间，免得两边抢写；太长则进程崩溃后要多等一个轮询周期才补上。
const DONE_ENTRY_CLOSURE_AUTHORIZED_BUT_LEFT_IN_FLIGHT_RUNTIME_FINALIZATION_GRACE_MS = 30_000;

export function getPostDeployVerificationStatePath(): string {
	return join(getRuntimeHomePath(), POST_DEPLOY_VERIFICATION_STATE_FILENAME);
}

// 单一全局锁：state 被 CLI / tRPC mutation / 轮询 reconcile 三方读改写，写频率低，不做分组锁。
// ponytail: global lock, per-workspace 锁只有在写吞吐成为瓶颈时才需要——dogfood 场景不会。
function getPostDeployVerificationStateLockRequest(): LockRequest {
	return { path: getPostDeployVerificationStatePath(), type: "file" };
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
): RuntimePostDeployVerificationAcknowledgement[] | null {
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

// 读时一次性迁移 legacy 文件名 → 新文件名（全量重命名兼容）。新文件已在则 no-op；
// 旧文件缺失或迁移失败均静默（读函数随后走 ENOENT → 空组）。rename 原子，无锁并发下最坏是一方 ENOENT 被吞。
// 导出供 CLI 只读 helper（commands/deployment.ts readPostDeployVerificationStateReadOnly）复用：
// 升级后若用户首个动作是只读 CLI（verification-state 等），也能立即看到 legacy 数据而非误报空组（issue CI4a）。
export async function migrateLegacyPostDeployVerificationStateFileIfNeeded(): Promise<void> {
	const newPath = getPostDeployVerificationStatePath();
	try {
		await access(newPath);
		return;
	} catch {
		// 新文件不存在，尝试从 legacy 文件名迁移。
	}
	const legacyPath = join(getRuntimeHomePath(), LEGACY_GUIDED_VERIFICATION_STATE_FILENAME);
	try {
		await rename(legacyPath, newPath);
		logDeploymentDiagnosticWarning(
			`[post-deploy-verification-state] 已将 legacy 状态文件 ${LEGACY_GUIDED_VERIFICATION_STATE_FILENAME} 迁移为 ${POST_DEPLOY_VERIFICATION_STATE_FILENAME}`,
		);
	} catch {
		// legacy 文件不存在或迁移失败：不阻塞，读函数走 ENOENT 空组重建。
	}
}

// 损坏 JSON 不 throw：把损坏文件改名隔离（.corrupt-<调用方传入时间戳>），降级为空组重建并 warn。
// 隔离后原路径消失 → 下次读为 ENOENT → 空组，无需另写空文件。
export async function readPostDeployVerificationStateCorruptionTolerant(
	corruptIsolationTimestamp: string,
): Promise<RuntimePostDeployVerificationState> {
	await migrateLegacyPostDeployVerificationStateFileIfNeeded();
	const path = getPostDeployVerificationStatePath();
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
		return parsePostDeployVerificationState(JSON.parse(raw));
	} catch (error) {
		const isolatedPath = `${path}.corrupt-${corruptIsolationTimestamp}`;
		try {
			await rename(path, isolatedPath);
		} catch {
			// 隔离改名失败不阻塞降级：仍返回空组，下一次写入会覆盖损坏内容。
		}
		logDeploymentDiagnosticWarning(
			`[post-deploy-verification-state] state JSON 损坏，已隔离为 ${isolatedPath}，降级为空组重建：${errorMessage(error)}`,
		);
		return { deploymentGroups: [] };
	}
}

// 历史组封顶裁剪：按部署时间保留最新的 MAX_RETAINED_FOLDED_DEPLOYMENT_GROUPS 个折叠组（返回按部署时间升序）。
// 写盘前归一化与跨组补写共用：后者据此跳过本次写盘就会被裁掉的折叠组（见 reconcileKanbanCliCompletionsAuthorizedButLeftInFlightAcrossWorkspaceDeploymentGroups）。
export function selectFoldedDeploymentGroupsSurvivingRetentionTrim(
	deploymentGroups: RuntimePostDeployVerificationDeploymentGroup[],
): RuntimePostDeployVerificationDeploymentGroup[] {
	const foldedGroups = deploymentGroups
		.filter((group) => group.foldedAtIso !== null)
		.sort((left, right) => Date.parse(left.deployedAtIso) - Date.parse(right.deployedAtIso));
	return foldedGroups.length > MAX_RETAINED_FOLDED_DEPLOYMENT_GROUPS
		? foldedGroups.slice(foldedGroups.length - MAX_RETAINED_FOLDED_DEPLOYMENT_GROUPS)
		: foldedGroups;
}

// 写盘前归一化：GC 过期 pendingConfirmation + 裁剪历史组至封顶（活跃组永不裁剪）。
// CLI 已授权的在途完成记录不在这里回收：它要么由 runtime 的跨组补写（覆盖活跃与已折叠组）补写 verifiedAt，
// 要么在卡没进 Done 时由同一处过期清除（见 reconcileKanbanCliCompletionsAuthorizedButLeftInFlightAcrossWorkspaceDeploymentGroups）。
// exemptFromRetentionDeploymentId：本次 mutation 正在触达的组，即使是最旧折叠组也豁免裁剪（finding #4）。
function normalizeStateForPersistence(
	state: RuntimePostDeployVerificationState,
	nowIso: string,
	exemptFromRetentionDeploymentId?: string,
): RuntimePostDeployVerificationState {
	const nowMs = Date.parse(nowIso);
	const gcApplied = state.deploymentGroups.map((group) => ({
		...group,
		tasks: group.tasks.map((task) =>
			task.pendingConfirmation !== null &&
			task.pendingConfirmation.kanbanCliCompletionAuthorizedBeforeMoveIntoDone === undefined &&
			Number.isFinite(nowMs) &&
			isExpired(task.pendingConfirmation.expiresAtIso, nowMs)
				? { ...task, pendingConfirmation: null }
				: task,
		),
	}));

	const activeGroups = gcApplied.filter((group) => group.foldedAtIso === null);
	const retainedFolded = selectFoldedDeploymentGroupsSurvivingRetentionTrim(gcApplied);
	// 豁免：若本次 mutation 触达的折叠组被裁掉，补回它——否则该组内的改动会返回 ok 却随裁剪丢失（不落盘）。
	if (
		exemptFromRetentionDeploymentId !== undefined &&
		!retainedFolded.some((group) => group.deploymentId === exemptFromRetentionDeploymentId)
	) {
		const exemptGroup = gcApplied.find(
			(group) => group.foldedAtIso !== null && group.deploymentId === exemptFromRetentionDeploymentId,
		);
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
// 导出给同目录的门禁模块（post-deploy-verification-done-entry-gate.ts）；src/commands/** 不得直接调用（CLI 写动词走 runtime procedure）。
export async function mutatePostDeployVerificationState<ResultType>(
	nowIso: string,
	mutator: (state: RuntimePostDeployVerificationState) => ResultType,
	touchedDeploymentId?: string,
): Promise<ResultType> {
	return await lockedFileSystem.withLock(getPostDeployVerificationStateLockRequest(), async () => {
		const state = await readPostDeployVerificationStateCorruptionTolerant(nowIso);
		const result = mutator(state);
		const normalized = normalizeStateForPersistence(state, nowIso, touchedDeploymentId);
		await lockedFileSystem.writeJsonFileAtomic(getPostDeployVerificationStatePath(), normalized, { lock: null });
		return result;
	});
}

function findGroup(
	state: RuntimePostDeployVerificationState,
	deploymentId: string,
): RuntimePostDeployVerificationDeploymentGroup | null {
	return state.deploymentGroups.find((group) => group.deploymentId === deploymentId) ?? null;
}

/** 某 workspace 的活跃组 = foldedAtIso === null 中 deployedAtIso 最新的一组。 */
export function findActiveDeploymentGroupOfWorkspace(
	state: RuntimePostDeployVerificationState,
	workspaceId: string,
): RuntimePostDeployVerificationDeploymentGroup | null {
	const active = state.deploymentGroups
		.filter((group) => group.workspaceId === workspaceId && group.foldedAtIso === null)
		.sort((left, right) => Date.parse(right.deployedAtIso) - Date.parse(left.deployedAtIso));
	return active[0] ?? null;
}

function findTask(
	state: RuntimePostDeployVerificationState,
	deploymentId: string,
	taskId: string,
): RuntimePostDeployVerificationTask | null {
	return findGroup(state, deploymentId)?.tasks.find((task) => task.taskId === taskId) ?? null;
}

export interface PostDeployVerificationTaskFoundFollowingCarriedForwardChain {
	group: RuntimePostDeployVerificationDeploymentGroup;
	task: RuntimePostDeployVerificationTask;
}

/**
 * 按 (deploymentId, taskId) 定位任务，并沿 carriedForwardIntoDeploymentId 跟到它被延续进的最新副本（RVF-002）。
 * 调用方手里的 deploymentId 可能是新部署建组之前读到的旧组（面板 / CLI 的快照）。被延续走的旧副本已不受门禁，
 * 结案相关的写入（待确认 token、CLI 在途完成记录、结案）若落在它上面，就会出现「旧副本结案、活跃组副本仍等核对」
 * 或同一任务结案两次。延续目标组已被裁剪时停在能找到的最后一份。
 */
export function findPostDeployVerificationTaskFollowingCarriedForwardChain(
	state: RuntimePostDeployVerificationState,
	deploymentId: string,
	taskId: string,
): PostDeployVerificationTaskFoundFollowingCarriedForwardChain | null {
	const startGroup = findGroup(state, deploymentId);
	const startTask = startGroup?.tasks.find((task) => task.taskId === taskId) ?? null;
	if (!startGroup || !startTask) {
		return null;
	}
	let found: PostDeployVerificationTaskFoundFollowingCarriedForwardChain = { group: startGroup, task: startTask };
	const visitedDeploymentIds = new Set([startGroup.deploymentId]);
	while (
		found.task.carriedForwardIntoDeploymentId !== null &&
		!visitedDeploymentIds.has(found.task.carriedForwardIntoDeploymentId)
	) {
		const nextGroup = findGroup(state, found.task.carriedForwardIntoDeploymentId);
		const nextTask = nextGroup?.tasks.find((task) => task.taskId === taskId) ?? null;
		// 只读展示的副本不是延续（旧版 record 曾把它也标成延续目标），结案不能落在它上面。
		if (!nextGroup || !nextTask || nextTask.includedAsReadOnlyBecauseTaskAlreadyInDoneColumnWhenDeploymentRecorded) {
			break;
		}
		visitedDeploymentIds.add(nextGroup.deploymentId);
		found = { group: nextGroup, task: nextTask };
	}
	return found;
}

function taskNotFoundError(deploymentId: string, taskId: string): string {
	return `任务未找到：deploymentId=${deploymentId} taskId=${taskId}`;
}

// custom 项工厂：构造纯 checkbox 型（kind=guided_manual，无 guidance/script/run/cleanup）验证项。
// 带脚本/引导的 authored 型由 materializeAuthoredVerificationItemsForWorkspaceTasks（Stage 2）单独构造，不走此工厂。
function buildGuidedManualChecklistItem(fields: {
	id: string;
	label: string;
	checked: boolean;
	source: RuntimePostDeployVerificationChecklistItemSource;
}): RuntimePostDeployVerificationChecklistItem {
	return {
		id: fields.id,
		label: fields.label,
		checked: fields.checked,
		source: fields.source,
		kind: "guided_manual",
		guidance: null,
		script: null,
		run: null,
		cleanup: null,
	};
}

export interface CreateDeploymentGroupInput {
	deploymentId: string;
	workspaceId: string;
	deployedSourceCommit: string;
	previousDeployedSourceCommit: string | null;
	sourceCheckoutPath: string;
	packageVersion: string;
	// 调用方在 state 锁外组装好的任务条目；其中延续来的那些在锁内还会按旧副本的当前状态重新落定（见下）。
	tasks: RuntimePostDeployVerificationTask[];
	// 延续来的任务 → 调用方无锁预读时那份旧副本所在组的 deploymentId（RVF-002）。锁内沿延续链找到旧副本的当前状态，
	// 按 reconcileCarriedForwardDeploymentGroupTaskAgainstPreviousCopyWithinStateLock 重新落定；缺省 = 没有延续任务。
	previousActiveGroupDeploymentIdObservedByUnlockedPreReadByCarriedForwardTaskId?: ReadonlyMap<string, string>;
}

/**
 * 记录一次部署：折叠该 workspace 之前的活跃组进历史、追加新组，并在同一次 state 锁内连带写 marker，避免半写。
 * 延续副本在锁内按旧副本的当前状态协调（RVF-002）：调用方无锁预读之后，门禁可能已在旧副本上写下在途授权 / 已结案，
 * CLI 可能已写下在途完成记录，面板可能又勾了几项——不协调的话，结案落到折叠旧副本，活跃组副本被对账误标 moved_out_manually。
 * 时间戳全部用调用方传入的 nowIso。
 */
export async function createDeploymentGroup(
	input: CreateDeploymentGroupInput,
	nowIso: string,
): Promise<{ group: RuntimePostDeployVerificationDeploymentGroup; marker: RuntimeDeploymentMarker }> {
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

	return await lockedFileSystem.withLock(getPostDeployVerificationStateLockRequest(), async () => {
		const state = await readPostDeployVerificationStateCorruptionTolerant(nowIso);
		const tasksOfNewGroup: RuntimePostDeployVerificationTask[] = [];
		for (const taskAssembledFromUnlockedPreRead of input.tasks) {
			const previousActiveGroupDeploymentId =
				input.previousActiveGroupDeploymentIdObservedByUnlockedPreReadByCarriedForwardTaskId?.get(
					taskAssembledFromUnlockedPreRead.taskId,
				);
			const previousCopyCurrentWithinStateLock =
				previousActiveGroupDeploymentId === undefined
					? null
					: (findPostDeployVerificationTaskFollowingCarriedForwardChain(
							state,
							previousActiveGroupDeploymentId,
							taskAssembledFromUnlockedPreRead.taskId,
						)?.task ?? null);
			if (previousCopyCurrentWithinStateLock === null) {
				tasksOfNewGroup.push(taskAssembledFromUnlockedPreRead);
				continue;
			}
			const reconciled = reconcileCarriedForwardDeploymentGroupTaskAgainstPreviousCopyWithinStateLock({
				deploymentId: input.deploymentId,
				taskAssembledFromUnlockedPreRead,
				previousCopyCurrentWithinStateLock,
			});
			switch (reconciled.carriedForwardTaskReconciliationOutcome) {
				case "carried_forward_with_previous_copy_current_progress_and_in_flight_closure":
					// 在途的授权 / token / CLI 完成记录已随副本搬进新组：旧副本不再持有，免得对账在两份上各结案一次。
					previousCopyCurrentWithinStateLock.pendingConfirmation = null;
					previousCopyCurrentWithinStateLock.doneEntryClosureAuthorizationInFlight = null;
					tasksOfNewGroup.push(reconciled.task);
					break;
				case "included_as_read_only_because_previous_copy_closed_into_done_before_deployment_group_written":
					tasksOfNewGroup.push(reconciled.task);
					break;
				case "excluded_because_previous_copy_no_longer_awaiting_verification_before_deployment_group_written":
					break;
			}
		}
		const group: RuntimePostDeployVerificationDeploymentGroup = {
			deploymentId: input.deploymentId,
			workspaceId: input.workspaceId,
			deployedSourceCommit: input.deployedSourceCommit,
			previousDeployedSourceCommit: input.previousDeployedSourceCommit,
			deployedAtIso: nowIso,
			foldedAtIso: null,
			tasks: tasksOfNewGroup,
		};
		// 只算新组里等核对的副本：只读展示（记录部署时已在 Done）不是延续，旧副本若还有在途结案要留在原处由对账补完，
		// 标成「已延续」会让按延续链定位的结案写到只读副本上。
		const taskIdsAwaitingVerificationInNewGroup = new Set(
			group.tasks.filter(isPostDeployVerificationTaskAwaitingVerification).map((task) => task.taskId),
		);
		for (const existing of state.deploymentGroups) {
			if (existing.workspaceId === input.workspaceId && existing.foldedAtIso === null) {
				existing.foldedAtIso = nowIso;
				// 被延续进新组的未结案任务：历史组里标记「已延续」，面板与计数不再把这份旧副本当待核对。
				for (const task of existing.tasks) {
					if (
						taskIdsAwaitingVerificationInNewGroup.has(task.taskId) &&
						isPostDeployVerificationTaskAwaitingVerification(task)
					) {
						task.carriedForwardIntoDeploymentId = input.deploymentId;
					}
				}
			}
		}
		state.deploymentGroups.push(group);
		const normalized = normalizeStateForPersistence(state, nowIso);
		// marker + state 同一次锁内写入（均 lock:null 跳过内层加锁，由外层 state 锁串行化）。
		await lockedFileSystem.writeJsonFileAtomic(getPostDeployVerificationStatePath(), normalized, { lock: null });
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
): Promise<RuntimePostDeployVerificationDeploymentGroup | null> {
	return await mutatePostDeployVerificationState(nowIso, (state) =>
		findActiveDeploymentGroupOfWorkspace(state, workspaceId),
	);
}

export interface PostDeployVerificationTaskMutationResult {
	ok: boolean;
	task: RuntimePostDeployVerificationTask | null;
	error?: string;
}

/**
 * 勾选 / 增删自定义 checklist 项。定位键 (deploymentId, taskId)；可删的只有 custom 项与通用兜底项
 * 「在已部署 build 上手工验证」（它不是真的由提交生成，见 GENERIC_MANUAL_SMOKE_TEST_ON_DEPLOYED_BUILD_CHECKLIST_ITEM_ID），
 * 且不能删掉最后一项（空 checklist 既无法全勾、也没有可给原因的未勾项）。
 */
export async function updateTaskChecklist(
	request: RuntimeUpdateVerificationChecklistRequest,
	nowIso: string,
): Promise<PostDeployVerificationTaskMutationResult> {
	return await mutatePostDeployVerificationState(
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
					// 不变量：自动脚本项的 checked 仅由脚本运行结果驱动（见 applyVerificationRunResult），
					// 手动切换一律拒绝——否则 CLI / tRPC 可把从未运行的自动项标 checked 绕过完成门控 every(checked)。
					if (item.kind === "automated_script") {
						return {
							ok: false,
							task,
							error: `自动脚本型验证项的勾选状态由脚本运行结果驱动，不可手动切换：${request.itemId}`,
						};
					}
					item.checked = request.checked;
					return { ok: true, task };
				}
				case "add_custom_checklist_item": {
					task.checklist.push(
						buildGuidedManualChecklistItem({
							id: randomUUID(),
							label: request.label,
							checked: false,
							source: "custom",
						}),
					);
					return { ok: true, task };
				}
				case "remove_custom_checklist_item": {
					const item = task.checklist.find((entry) => entry.id === request.itemId);
					if (!item) {
						return { ok: false, task, error: `checklist 项未找到：${request.itemId}` };
					}
					if (item.source !== "custom" && !isGenericManualSmokeTestOnDeployedBuildChecklistItem(item)) {
						return { ok: false, task, error: `仅可删除自定义 checklist 项：${request.itemId}` };
					}
					if (task.checklist.length === 1) {
						return { ok: false, task, error: `不能删除最后一个 checklist 项：${request.itemId}` };
					}
					task.checklist = task.checklist.filter((entry) => entry.id !== request.itemId);
					return { ok: true, task };
				}
			}
		},
		request.deploymentId,
	);
}

// 自动脚本运行前置 running 态（plan Stage 3）：并发护栏——已在 running 则拒绝再次运行。
// 返回 ok=false + error 表示定位失败 / 非自动脚本项 / 已在运行。
export async function setVerificationRunState(
	input: { deploymentId: string; taskId: string; itemId: string; startedAtIso: string },
	nowIso: string,
): Promise<PostDeployVerificationTaskMutationResult> {
	return await mutatePostDeployVerificationState(
		nowIso,
		(state) => {
			const task = findTask(state, input.deploymentId, input.taskId);
			if (!task) {
				return { ok: false, task: null, error: taskNotFoundError(input.deploymentId, input.taskId) };
			}
			const item = task.checklist.find((entry) => entry.id === input.itemId);
			if (!item) {
				return { ok: false, task, error: `checklist 项未找到：${input.itemId}` };
			}
			if (item.kind !== "automated_script" || item.script === null) {
				return { ok: false, task, error: `仅自动脚本型验证项可运行：${input.itemId}` };
			}
			if (item.run?.status === "running") {
				return { ok: false, task, error: `验证项正在运行中：${input.itemId}` };
			}
			item.run = {
				status: "running",
				exitCode: null,
				startedAtIso: input.startedAtIso,
				finishedAtIso: null,
				outputExcerpt: "",
			};
			// 重跑护栏：开始运行即清掉上一轮 passed 留下的 checked=true，避免「显示已通过但正在重跑」的
			// 短暂不一致；结果回来后由 applyVerificationRunResult 依据 run.status 重新决定 checked。
			item.checked = false;
			return { ok: true, task };
		},
		input.deploymentId,
	);
}

// 自动脚本运行完成后写入 run 结果（plan Stage 3）：pass 置 checked=true，fail/timed_out/errored 置 checked=false。
// checked 由 run 结果驱动（自动项 checkbox 不接受手动切换），完成门控 every(checked) 因而对自动项也成立。
export async function applyVerificationRunResult(
	input: { deploymentId: string; taskId: string; itemId: string; run: RuntimePostDeployVerificationRun },
	nowIso: string,
): Promise<PostDeployVerificationTaskMutationResult> {
	return await mutatePostDeployVerificationState(
		nowIso,
		(state) => {
			const task = findTask(state, input.deploymentId, input.taskId);
			if (!task) {
				return { ok: false, task: null, error: taskNotFoundError(input.deploymentId, input.taskId) };
			}
			const item = task.checklist.find((entry) => entry.id === input.itemId);
			if (!item) {
				return { ok: false, task, error: `checklist 项未找到：${input.itemId}` };
			}
			item.run = input.run;
			item.checked = input.run.status === "passed";
			return { ok: true, task };
		},
		input.deploymentId,
	);
}

/**
 * 持久化 pendingConfirmation（token/过期/需确认项/发放时列）。token 跨进程两步确认必须落盘、不能只放内存（plan Grilling #8）。
 * 沿延续链写到任务的最新副本（RVF-002）：调用方的 deploymentId 可能是建新组之前读到的旧组。
 */
export async function setPendingConfirmation(
	deploymentId: string,
	taskId: string,
	pendingConfirmation: RuntimePostDeployVerificationPendingConfirmation,
	nowIso: string,
): Promise<PostDeployVerificationTaskMutationResult> {
	return await mutatePostDeployVerificationState(
		nowIso,
		(state) => {
			const task = findPostDeployVerificationTaskFollowingCarriedForwardChain(state, deploymentId, taskId)?.task;
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
	task: RuntimePostDeployVerificationTask | null;
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
	return await mutatePostDeployVerificationState(
		nowIso,
		(state) => {
			const task = findPostDeployVerificationTaskFollowingCarriedForwardChain(state, deploymentId, taskId)?.task;
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
	task: RuntimePostDeployVerificationTask | null;
	failureReason?: ConsumePendingConfirmationFailureReason;
	// true = 任务此前已结案（全勾通过或带原因结案），本次为幂等命中（未再校验/消费 token），见 issue B。
	alreadyVerified?: boolean;
}

function buildClosedWithinStateLock(
	group: RuntimePostDeployVerificationDeploymentGroup,
	task: RuntimePostDeployVerificationTask,
	completionEvidence: PostDeployVerificationCompletionEvidence,
): PostDeployVerificationTaskClosedWithinStateLock {
	return {
		workspaceId: group.workspaceId,
		deploymentId: group.deploymentId,
		deployedSourceCommit: group.deployedSourceCommit,
		closedTask: structuredClone(task),
		completionEvidence,
	};
}

/**
 * 原子「消费 token + 结案」：在单次 state 锁内校验并一次性消费 pendingConfirmation token，随后立即写结案
 * （全勾 = 通过、置 verifiedAt；否则须已有在途授权的逐项原因，见下）。issue B：consume 与结案合并为一次读改写，
 * 消除「token 已消费但标记失败」的中间坏态。幂等：任务此前已结案直接返回 ok（confirm 成功但响应丢失 / 重复提交的恢复；
 * 2026-10-11 起 Web 移入 Done 时 taskCardAction 的门禁已在服务端结案，之后的 confirm 都走这条幂等分支）。
 * 仅更新 verification state，绝不移列（移列职责在 Web/CLI，见 plan 1d）。
 */
export async function consumePendingConfirmationAndMarkVerified(
	deploymentId: string,
	taskId: string,
	token: string,
	nowIso: string,
	completionEvidence: PostDeployVerificationCompletionEvidence = {
		postDeployVerificationCompletionPath: "web_ui_post_deploy_verification_panel_atomic_confirmation",
		confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag: false,
		confirmedAcknowledgements: [],
	},
): Promise<ConsumePendingConfirmationAndMarkVerifiedResult> {
	let closedWithinStateLock: PostDeployVerificationTaskClosedWithinStateLock | null = null;
	const result = await mutatePostDeployVerificationState(
		nowIso,
		(state): ConsumePendingConfirmationAndMarkVerifiedResult => {
			// 沿延续链结案在最新副本上（RVF-002）：面板手里的 deploymentId 可能是建新组之前的旧组，旧副本已被延续走。
			const found = findPostDeployVerificationTaskFollowingCarriedForwardChain(state, deploymentId, taskId);
			if (!found) {
				return { ok: false, task: null, failureReason: "task_not_found" as const };
			}
			const { group, task } = found;
			if (isPostDeployVerificationTaskClosed(task)) {
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
			applyPostDeployVerificationClosureToTaskWithinStateLock(
				task,
				{
					postDeployVerificationClosureOutcome: "all_checklist_items_checked",
					uncheckedChecklistItemClosureReasons: [],
					confirmedAcknowledgements: [...pending.requiredAcknowledgements],
					postDeployVerificationCompletionPath: completionEvidence.postDeployVerificationCompletionPath,
				},
				{ workspaceId: group.workspaceId, nowIso },
			);
			closedWithinStateLock = buildClosedWithinStateLock(group, task, completionEvidence);
			return { ok: true, task };
		},
		deploymentId,
	);
	// 仅在本次真正结案（非幂等命中）时记账、清理，避免重复对已清理项做无谓 fs/锁操作。
	if (closedWithinStateLock) {
		await runPostDeployVerificationClosureSideEffectsOutsideStateLock(closedWithinStateLock, nowIso);
	}
	return result;
}

/**
 * CLI 完成动词移入 Done 之后的结案（「PDV 通过」或带原因结案）。仅更新 verification state，绝不移列（plan 1d）。
 * 幂等：已结案（2026-10-11 起通常是 taskCardAction 门禁在移列时已结案）直接返回已结案的 task。
 * 未结案时由 runtime 自己判结局：全勾 → 通过；否则 uncheckedChecklistItemClosureReasons 必须覆盖全部未勾项，不然拒绝。
 */
export async function markTaskVerified(
	deploymentId: string,
	taskId: string,
	nowIso: string,
	completionEvidence: PostDeployVerificationCompletionEvidence = {
		postDeployVerificationCompletionPath: "kanban_cli_post_deploy_verification_completion_verb",
		confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag: false,
		confirmedAcknowledgements: [],
	},
	uncheckedChecklistItemClosureReasons: RuntimePostDeployVerificationUncheckedChecklistItemClosureReason[] = [],
): Promise<PostDeployVerificationTaskMutationResult> {
	let closedWithinStateLock: PostDeployVerificationTaskClosedWithinStateLock | null = null;
	const result = await mutatePostDeployVerificationState(
		nowIso,
		(state): PostDeployVerificationTaskMutationResult => {
			// 沿延续链结案在最新副本上（RVF-002）：CLI 手里的 deploymentId 可能是建新组之前的旧组；门禁已在活跃组副本上结案时
			// 这里是幂等命中，否则会在折叠旧副本上再结案一次（账本只追加，两条结案事件撤不掉）。
			const found = findPostDeployVerificationTaskFollowingCarriedForwardChain(state, deploymentId, taskId);
			if (!found) {
				return { ok: false, task: null, error: taskNotFoundError(deploymentId, taskId) };
			}
			const { group, task } = found;
			if (isPostDeployVerificationTaskClosed(task)) {
				return { ok: true, task };
			}
			const fullyChecked = isChecklistOfPostDeployVerificationTaskFullyChecked(task);
			const resolution = resolveUncheckedChecklistItemClosureReasonsForPostDeployVerificationTask(task, {
				uncheckedChecklistItemClosureReasons,
			});
			if (!fullyChecked && !resolution.uncheckedChecklistItemClosureReasonsCoverAllUncheckedItems) {
				return {
					ok: false,
					task,
					error: `checklist 未全部勾选，且以下未勾项缺少结案原因：${resolution.uncheckedChecklistItemsMissingClosureReason
						.map((item) => item.id)
						.join(", ")}`,
				};
			}
			applyPostDeployVerificationClosureToTaskWithinStateLock(
				task,
				{
					postDeployVerificationClosureOutcome: fullyChecked
						? "all_checklist_items_checked"
						: "closed_into_done_with_unchecked_items_reasoned",
					uncheckedChecklistItemClosureReasons:
						!fullyChecked && resolution.uncheckedChecklistItemClosureReasonsCoverAllUncheckedItems
							? resolution.resolvedReasons
							: [],
					confirmedAcknowledgements: [
						...completionEvidence.confirmedAcknowledgements,
					] as RuntimePostDeployVerificationAcknowledgement[],
					postDeployVerificationCompletionPath: completionEvidence.postDeployVerificationCompletionPath,
				},
				{ workspaceId: group.workspaceId, nowIso },
			);
			closedWithinStateLock = buildClosedWithinStateLock(group, task, completionEvidence);
			return { ok: true, task };
		},
		deploymentId,
	);
	if (closedWithinStateLock) {
		await runPostDeployVerificationClosureSideEffectsOutsideStateLock(closedWithinStateLock, nowIso);
	}
	return result;
}

export interface ReconcileGroupBoardTask {
	taskId: string;
	columnId: RuntimeBoardColumnId;
}

export interface ComputeTaskDeploymentAttributionsForDeploymentGroupInput {
	targetDeploymentGroup: RuntimePostDeployVerificationDeploymentGroup;
	// 同 workspace、部署时间早于 target 的保留组（升序），用于判定「早先部署已上线」与首次上线。
	retainedEarlierDeploymentGroupsInAscendingOrder: RuntimePostDeployVerificationDeploymentGroup[];
	taskIds: string[];
}

export type ComputeTaskDeploymentAttributionsForDeploymentGroup = (
	input: ComputeTaskDeploymentAttributionsForDeploymentGroupInput,
) => Promise<Map<string, TaskDeploymentAttributionComputation>>;

export interface ReconcileGroupInput {
	deploymentId: string;
	// 该组所属 workspace（用于给新进 validation 任务 materialize authored 验证定义）。
	workspaceId: string;
	// 当前看板上该 workspace 的任务快照；缺席某 taskId 即视为已删除。
	currentBoardTasks: ReconcileGroupBoardTask[];
	nowIso: string;
	// 由 runtime 注入（要用 workspace 的仓库路径起 git）；缺省 = 本轮不补算归属。
	computeTaskDeploymentAttributionsForDeploymentGroup?: ComputeTaskDeploymentAttributionsForDeploymentGroup;
}

// EXPERIMENT_NODE: CLI 已授权的在途完成记录写下后，runtime 至少等 60s 才自行补写 verifiedAt——给 CLI 自己的补记调用留出时间，
// 免得两边抢写、把「PDV 通过」的完成路径记成 runtime 对账；太长则 runtime 恢复后要多等一个轮询周期才补上。
const KANBAN_CLI_COMPLETION_AUTHORIZED_BUT_LEFT_IN_FLIGHT_RUNTIME_FINALIZATION_GRACE_MS = 60_000;

function listRetainedEarlierDeploymentGroupsOfWorkspaceInAscendingOrder(
	state: RuntimePostDeployVerificationState,
	targetDeploymentGroup: RuntimePostDeployVerificationDeploymentGroup,
): RuntimePostDeployVerificationDeploymentGroup[] {
	const targetDeployedAtMs = Date.parse(targetDeploymentGroup.deployedAtIso);
	return state.deploymentGroups
		.filter(
			(group) =>
				group.workspaceId === targetDeploymentGroup.workspaceId &&
				group.deploymentId !== targetDeploymentGroup.deploymentId &&
				Date.parse(group.deployedAtIso) < targetDeployedAtMs,
		)
		.sort((left, right) => Date.parse(left.deployedAtIso) - Date.parse(right.deployedAtIso));
}

function isTaskDeploymentAttributionDueForRecompute(task: RuntimePostDeployVerificationTask, nowMs: number): boolean {
	const attribution = task.taskDeploymentAttribution;
	if (attribution === null) {
		return true;
	}
	if (attribution.taskDeploymentAttributionZone !== "task_commits_not_yet_deployed_or_task_unattributable") {
		return false;
	}
	const computedAtMs = Date.parse(attribution.attributionComputedAtIso);
	return (
		!Number.isFinite(computedAtMs) ||
		nowMs - computedAtMs >= UNDEPLOYED_OR_UNATTRIBUTABLE_TASK_DEPLOYMENT_ATTRIBUTION_RECOMPUTE_INTERVAL_MS
	);
}

function applyTaskDeploymentAttributionComputation(
	task: RuntimePostDeployVerificationTask,
	computation: TaskDeploymentAttributionComputation,
): void {
	task.taskDeploymentAttribution = computation.taskDeploymentAttribution;
	task.matchedCommits = computation.taskDeploymentAttribution.matchedDeployedCommitsInThisDeploymentDelta.map(
		(match) => match.deployedCommitSha,
	);
	// 首次上线一旦确定就不再改写（跨部署延续的事实）；还没确定时取本次算出的。
	if (task.firstDeployedInDeploymentId === null && !task.firstDeploymentPredatesRetainedDeploymentRecords) {
		task.firstDeployedInDeploymentId = computation.firstDeployedInDeploymentId;
		task.firstDeployedAtIso = computation.firstDeployedAtIso;
		task.firstDeploymentPredatesRetainedDeploymentRecords =
			computation.firstDeploymentPredatesRetainedDeploymentRecords;
	}
}

/**
 * 双向 reconcile 当前组（plan「任务纳入规则」）：
 *  - 方向一：组内未结案任务已从看板删除 → droppedReason="task_deleted"；移回 backlog → "moved_out_manually"；
 *    出现在 Done 却没有结案也没有在途授权（门禁之外的绕过，正常不可达）→ 同样标 "moved_out_manually" 并告警。
 *  - 方向二：deploy 后新进 validation 列的任务动态加入本组（inclusionReason="validation_column"）。
 *  - 补算归属：未算过的、以及第三区里过了重算间隔的未结案任务（git 在 state 锁外跑，见 computeTaskDeploymentAttributionsForDeploymentGroup）。
 *  - 补 authored 项：晚于建组注册的验证定义合并进未结案任务；有 authored 项后去掉未勾的通用兜底项。
 * 在途授权（CLI 的、门禁的）的补完不在这里：所属组被新部署折叠后就不再走本函数，
 * 补完由 reconcileKanbanCliCompletionsAuthorizedButLeftInFlightAcrossWorkspaceDeploymentGroups 跨该 workspace 全部组进行。
 * 只由 runtime 调用。找不到组返回 null。
 */
export async function reconcileGroup(
	input: ReconcileGroupInput,
): Promise<RuntimePostDeployVerificationDeploymentGroup | null> {
	// authored 定义与归属都在 state 锁外预取（前者取 authored 定义文件的独立锁，后者起 git），同步的 mutator 内只做合并。
	// 预读组成员用锁外只读快照即可：快照后并发新加入的任务最多本轮没补齐，下一轮对账补上；mutator 内按 id 去重。
	const preReadState = await readPostDeployVerificationStateCorruptionTolerant(input.nowIso);
	const preReadGroup = findGroup(preReadState, input.deploymentId);
	if (!preReadGroup) {
		return null;
	}
	const nowMs = Date.parse(input.nowIso);
	const taskIdsAlreadyInGroup = new Set(preReadGroup.tasks.map((task) => task.taskId));
	const validationTaskIdsJoiningGroup = input.currentBoardTasks
		.filter((boardTask) => boardTask.columnId === "validation" && !taskIdsAlreadyInGroup.has(boardTask.taskId))
		.map((boardTask) => boardTask.taskId);
	const taskIdsAwaitingVerificationInGroup = preReadGroup.tasks
		.filter(isPostDeployVerificationTaskAwaitingVerification)
		.map((task) => task.taskId);
	const authoredItemsByTaskId = await materializeAuthoredVerificationItemsForWorkspaceTasks(
		input.workspaceId,
		[...taskIdsAwaitingVerificationInGroup, ...validationTaskIdsJoiningGroup],
		input.nowIso,
	);
	const taskIdsDueForAttribution = [
		...preReadGroup.tasks
			.filter(
				(task) =>
					isPostDeployVerificationTaskAwaitingVerification(task) &&
					isTaskDeploymentAttributionDueForRecompute(task, nowMs),
			)
			.map((task) => task.taskId),
		...validationTaskIdsJoiningGroup,
	];
	let attributionComputationsByTaskId = new Map<string, TaskDeploymentAttributionComputation>();
	if (input.computeTaskDeploymentAttributionsForDeploymentGroup && taskIdsDueForAttribution.length > 0) {
		try {
			attributionComputationsByTaskId = await input.computeTaskDeploymentAttributionsForDeploymentGroup({
				targetDeploymentGroup: preReadGroup,
				retainedEarlierDeploymentGroupsInAscendingOrder:
					listRetainedEarlierDeploymentGroupsOfWorkspaceInAscendingOrder(preReadState, preReadGroup),
				taskIds: taskIdsDueForAttribution,
			});
		} catch (error) {
			logDeploymentDiagnosticWarning(
				`[post-deploy-verification-state] 补算部署归属失败 deploymentId=${input.deploymentId}：${errorMessage(error)}`,
			);
		}
	}
	return await mutatePostDeployVerificationState(
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
				if (!isPostDeployVerificationTaskAwaitingVerification(task)) {
					continue;
				}
				const currentColumn = columnByTaskId.get(task.taskId);
				if (currentColumn === undefined) {
					task.droppedReason = "task_deleted";
					continue;
				}
				// confirmation 在途（pendingConfirmation !== null）= Web 已「先移入 trash、正要 confirm」，不算手动移出（finding #3）；
				// CLI 已授权的在途完成记录、门禁写下的在途授权同理：卡在 trash 时等跨组补完结案，不在这里标手动移出。
				const closureInFlight =
					task.pendingConfirmation !== null || task.doneEntryClosureAuthorizationInFlight !== null;
				if (currentColumn === "backlog" && !closureInFlight) {
					task.droppedReason = "moved_out_manually";
					continue;
				}
				if (currentColumn === "trash" && !closureInFlight) {
					task.droppedReason = "moved_out_manually";
					logDeploymentDiagnosticWarning(
						`[post-deploy-verification-state] 任务 ${task.taskId} 未经 Post-Deploy Verification 结案就出现在 Done（门禁之外的路径，如旧版客户端），已标记 moved_out_manually`,
					);
					continue;
				}
				// 结案在途（已授权、正等结案写盘）：checklist 必须保持授权时的样子，不再合并新项、不补兜底项——否则授权里的原因
				// 会不再覆盖全部未勾项，补完时被判缺原因。
				if (closureInFlight || currentColumn === "trash") {
					continue;
				}
				const computation = attributionComputationsByTaskId.get(task.taskId);
				if (computation) {
					applyTaskDeploymentAttributionComputation(task, computation);
				}
				mergeAuthoredChecklistItemsAndReconcileGenericManualSmokeTestItem(
					task.checklist,
					authoredItemsByTaskId.get(task.taskId) ?? [],
				);
			}

			const existingTaskIds = new Set(group.tasks.map((task) => task.taskId));
			for (const boardTask of input.currentBoardTasks) {
				if (boardTask.columnId !== "validation" || existingTaskIds.has(boardTask.taskId)) {
					continue;
				}
				group.tasks.push(
					assemblePostDeployVerificationTaskForDeploymentGroup({
						taskId: boardTask.taskId,
						columnIdAtMatch: boardTask.columnId,
						inclusionReason: "validation_column",
						deploymentId: group.deploymentId,
						unclosedTaskCarriedForwardFromPreviousActiveGroup: null,
						authoredChecklistItems: authoredItemsByTaskId.get(boardTask.taskId) ?? [],
						taskDeploymentAttributionComputation: attributionComputationsByTaskId.get(boardTask.taskId) ?? null,
						includedAsReadOnlyBecauseTaskAlreadyInDoneColumnWhenDeploymentRecorded: false,
					}).task,
				);
			}
			return group;
		},
		input.deploymentId,
	);
}

export interface ReconcileKanbanCliCompletionsAuthorizedButLeftInFlightAcrossWorkspaceDeploymentGroupsInput {
	workspaceId: string;
	// 当前看板上该 workspace 的任务快照；缺席某 taskId 即视为卡已不在看板。
	currentBoardTasks: ReconcileGroupBoardTask[];
	nowIso: string;
}

/**
 * 在途授权的 runtime 收尾，覆盖该 workspace 的**全部**部署组（活跃 + 已被新部署折叠）——记录所在组被折叠后不再走
 * reconcileGroup，只看活跃组会让它永远补不上（RVF-002）。两种在途授权：
 *  1. CLI 已授权、已移入 Done、却没来得及结案的在途完成记录（pendingConfirmation.kanbanCliCompletionAuthorizedBeforeMoveIntoDone，
 *     RVF-004 遗留）：卡在 Done 且过了宽限期 → 结案（全勾 = 通过；否则用授权里 CLI 解析好的逐项原因）；
 *  2. taskCardAction 门禁写下的在途授权（doneEntryClosureAuthorizationInFlight）：卡在 Done 且过了宽限期 → 按授权里的原因结案。
 * 两种都按**当前** checklist 重新核验结局（resolvePostDeployVerificationClosureProvableFromCurrentChecklist）；授权后出现了
 * 没有原因的未勾项、证明不了任何结局时，标 moved_out_manually 并清掉记录（卡已在 Done，不收尾就永远卡在待核对）。
 * 记录已过期、卡却不在 Done（移列从没成功）或已不在看板 → 清掉记录。普通待确认 token（无授权标记）一律不碰。
 * 锁外按 runtime 对账记账（取该任务所在组的 workspace / 部署信息）、写待观察记录并跑自动清理。
 * 由 runtime 的 getPostDeployVerificationState 每次轮询调用（不论有无活跃组）；只由 runtime 调用。
 */
export async function reconcileKanbanCliCompletionsAuthorizedButLeftInFlightAcrossWorkspaceDeploymentGroups(
	input: ReconcileKanbanCliCompletionsAuthorizedButLeftInFlightAcrossWorkspaceDeploymentGroupsInput,
): Promise<void> {
	const nowMs = Date.parse(input.nowIso);
	const columnByTaskId = new Map(input.currentBoardTasks.map((boardTask) => [boardTask.taskId, boardTask.columnId]));
	const tasksClosedByRuntimeFinalizingAuthorizationsLeftInFlight: PostDeployVerificationTaskClosedWithinStateLock[] =
		[];
	const isAuthorizationPastGrace = (authorizedAtIso: string, graceMs: number): boolean => {
		const authorizedAtMs = Date.parse(authorizedAtIso);
		return Number.isFinite(authorizedAtMs) && nowMs - authorizedAtMs >= graceMs;
	};
	await mutatePostDeployVerificationState(input.nowIso, (state) => {
		// mutate 的裁剪豁免只覆盖一个 deploymentId：本次写盘就会被历史组封顶裁掉的折叠组，改动会随整组一起丢失，
		// 照样补写就会在锁外记下盘上并不存在的结案。这类组整组消失、不留滞留记录，直接跳过。
		const foldedDeploymentIdsSurvivingRetentionTrim = new Set(
			selectFoldedDeploymentGroupsSurvivingRetentionTrim(state.deploymentGroups).map((group) => group.deploymentId),
		);
		for (const group of state.deploymentGroups) {
			if (group.workspaceId !== input.workspaceId) {
				continue;
			}
			if (group.foldedAtIso !== null && !foldedDeploymentIdsSurvivingRetentionTrim.has(group.deploymentId)) {
				continue;
			}
			for (const task of group.tasks) {
				if (isPostDeployVerificationTaskClosed(task)) {
					continue;
				}
				const currentColumn = columnByTaskId.get(task.taskId);
				const doneEntryAuthorization = task.doneEntryClosureAuthorizationInFlight;
				if (doneEntryAuthorization) {
					if (
						currentColumn === "trash" &&
						isAuthorizationPastGrace(
							doneEntryAuthorization.authorizedAtIso,
							DONE_ENTRY_CLOSURE_AUTHORIZED_BUT_LEFT_IN_FLIGHT_RUNTIME_FINALIZATION_GRACE_MS,
						)
					) {
						// 结局按当前 checklist 重新核验（授权后 checklist 仍可被改）；证明不了就按「未经结案进 Done」收尾。
						const provableClosure = resolvePostDeployVerificationClosureProvableFromCurrentChecklist(
							task,
							doneEntryAuthorization.uncheckedChecklistItemClosureReasons,
						);
						if (!provableClosure.postDeployVerificationClosureProvableFromCurrentChecklist) {
							markPostDeployVerificationTaskEnteredDoneWithoutProvableClosureWithinStateLock(task, {
								workspaceId: group.workspaceId,
								uncheckedChecklistItemsMissingClosureReason:
									provableClosure.uncheckedChecklistItemsMissingClosureReason,
								inFlightAuthorizationKindForDiagnostics: "门禁写下的在途授权",
							});
							continue;
						}
						// 授权由 CLI 完成动词发起（门禁据 CLI 在途完成记录推导）时，补完也记成「替 CLI 补完」，与改动前同一路径值。
						const completionPath: RuntimePostDeployVerificationCompletionPath =
							doneEntryAuthorization.postDeployVerificationCompletionPath ===
							"kanban_cli_post_deploy_verification_completion_verb"
								? "kanban_runtime_reconciliation_finalizing_kanban_cli_completion_authorized_but_left_in_flight"
								: "kanban_runtime_reconciliation_finalizing_done_entry_closure_authorized_but_left_in_flight";
						applyPostDeployVerificationClosureToTaskWithinStateLock(
							task,
							{
								postDeployVerificationClosureOutcome: provableClosure.postDeployVerificationClosureOutcome,
								uncheckedChecklistItemClosureReasons: provableClosure.uncheckedChecklistItemClosureReasons,
								confirmedAcknowledgements: doneEntryAuthorization.confirmedAcknowledgements,
								postDeployVerificationCompletionPath: completionPath,
							},
							{ workspaceId: group.workspaceId, nowIso: input.nowIso },
						);
						tasksClosedByRuntimeFinalizingAuthorizationsLeftInFlight.push(
							buildClosedWithinStateLock(group, task, {
								postDeployVerificationCompletionPath: completionPath,
								confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag:
									doneEntryAuthorization.confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag ??
									false,
								confirmedAcknowledgements: [...doneEntryAuthorization.confirmedAcknowledgements],
							}),
						);
						continue;
					}
					if (currentColumn !== "trash" && isExpired(doneEntryAuthorization.expiresAtIso, nowMs)) {
						task.doneEntryClosureAuthorizationInFlight = null;
					}
				}
				const inFlightCompletionRecord = task.pendingConfirmation;
				const kanbanCliCompletionAuthorization =
					inFlightCompletionRecord?.kanbanCliCompletionAuthorizedBeforeMoveIntoDone;
				if (!inFlightCompletionRecord || !kanbanCliCompletionAuthorization) {
					continue;
				}
				if (
					currentColumn === "trash" &&
					isAuthorizationPastGrace(
						kanbanCliCompletionAuthorization.authorizedAtIso,
						KANBAN_CLI_COMPLETION_AUTHORIZED_BUT_LEFT_IN_FLIGHT_RUNTIME_FINALIZATION_GRACE_MS,
					)
				) {
					const provableClosure = resolvePostDeployVerificationClosureProvableFromCurrentChecklist(
						task,
						kanbanCliCompletionAuthorization.uncheckedChecklistItemClosureReasons ?? [],
					);
					// 授权里的原因已不覆盖当前未勾项（授权后有人取消勾选 / 增项）：卡已在 Done、记录不会再按过期清，
					// 跳过就会让任务永远卡在待核对——按「未经结案进 Done」确定收尾。
					if (!provableClosure.postDeployVerificationClosureProvableFromCurrentChecklist) {
						markPostDeployVerificationTaskEnteredDoneWithoutProvableClosureWithinStateLock(task, {
							workspaceId: group.workspaceId,
							uncheckedChecklistItemsMissingClosureReason:
								provableClosure.uncheckedChecklistItemsMissingClosureReason,
							inFlightAuthorizationKindForDiagnostics: "CLI 完成动词写下的在途完成记录",
						});
						continue;
					}
					const completionPath: RuntimePostDeployVerificationCompletionPath =
						"kanban_runtime_reconciliation_finalizing_kanban_cli_completion_authorized_but_left_in_flight";
					applyPostDeployVerificationClosureToTaskWithinStateLock(
						task,
						{
							postDeployVerificationClosureOutcome: provableClosure.postDeployVerificationClosureOutcome,
							uncheckedChecklistItemClosureReasons: provableClosure.uncheckedChecklistItemClosureReasons,
							confirmedAcknowledgements: [...inFlightCompletionRecord.requiredAcknowledgements],
							postDeployVerificationCompletionPath: completionPath,
						},
						{ workspaceId: group.workspaceId, nowIso: input.nowIso },
					);
					tasksClosedByRuntimeFinalizingAuthorizationsLeftInFlight.push(
						buildClosedWithinStateLock(group, task, {
							postDeployVerificationCompletionPath: completionPath,
							confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag:
								readConfirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlagOfKanbanCliCompletionAuthorization(
									kanbanCliCompletionAuthorization,
								),
							confirmedAcknowledgements: [...inFlightCompletionRecord.requiredAcknowledgements],
						}),
					);
					continue;
				}
				if (currentColumn !== "trash" && isExpired(inFlightCompletionRecord.expiresAtIso, nowMs)) {
					task.pendingConfirmation = null;
				}
			}
		}
	});
	for (const closedWithinStateLock of tasksClosedByRuntimeFinalizingAuthorizationsLeftInFlight) {
		await runPostDeployVerificationClosureSideEffectsOutsideStateLock(closedWithinStateLock, input.nowIso);
	}
}
