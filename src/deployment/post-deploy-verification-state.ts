import { randomUUID } from "node:crypto";
import { access, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type {
	RuntimeBoardColumnId,
	RuntimeDeploymentMarker,
	RuntimePostDeployVerificationAcknowledgement,
	RuntimePostDeployVerificationChecklistItem,
	RuntimePostDeployVerificationChecklistItemSource,
	RuntimePostDeployVerificationDeploymentGroup,
	RuntimePostDeployVerificationInclusionReason,
	RuntimePostDeployVerificationPendingConfirmation,
	RuntimePostDeployVerificationRun,
	RuntimePostDeployVerificationState,
	RuntimePostDeployVerificationTask,
	RuntimeUpdateVerificationChecklistRequest,
} from "../core/api-contract";
import { parsePostDeployVerificationState } from "../core/api-validation";
import { logDeploymentDiagnosticWarning } from "../diagnostics/deployment-diagnostics-logger";
import type { LockRequest } from "../fs/locked-file-system";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "../state/workspace-state";
import {
	AUTHORED_VERIFICATION_ITEM_ID_PREFIX,
	materializeAuthoredVerificationItemsForTask,
	removeAuthoredVerificationDefinition,
} from "./authored-verification-definitions";
import { writeDeployMarker } from "./deploy-marker";
import { cleanupVerificationAssets } from "./verification-assets";

// ~/.cline/kanban/post-deploy-verification-state.json —— 跨 workspace 的单一全局文件（plan 1c）。
const POST_DEPLOY_VERIFICATION_STATE_FILENAME = "post-deploy-verification-state.json";
// Legacy 文件名（Post-Deploy Verification 全量重命名前叫 Guided Verification）。仅用于读时一次性迁移：
// 新文件缺失且旧文件在场时 rename 旧→新，无数据丢失；迁移后旧路径消失，后续读走新文件。
const LEGACY_GUIDED_VERIFICATION_STATE_FILENAME = "guided-verification-state.json";
// 历史（已折叠）组封顶；未折叠的活跃组恒保留、不参与裁剪。
const MAX_RETAINED_FOLDED_DEPLOYMENT_GROUPS = 20;
// validation 列任务无 commit 关联时 seed 的通用手工验证项 id（稳定值，勾选状态跨 reconcile 保留）。
const MANUAL_VERIFICATION_CHECKLIST_ITEM_ID = "manual-smoke-test-on-deployed-build";

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
async function readPostDeployVerificationStateCorruptionTolerant(
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

// 写盘前归一化：GC 过期 pendingConfirmation + 裁剪历史组至封顶（活跃组永不裁剪）。
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
async function mutatePostDeployVerificationState<ResultType>(
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

function findTask(
	state: RuntimePostDeployVerificationState,
	deploymentId: string,
	taskId: string,
): RuntimePostDeployVerificationTask | null {
	return findGroup(state, deploymentId)?.tasks.find((task) => task.taskId === taskId) ?? null;
}

function taskNotFoundError(deploymentId: string, taskId: string): string {
	return `任务未找到：deploymentId=${deploymentId} taskId=${taskId}`;
}

// commit/manual/custom 项统一工厂：构造纯 checkbox 型（kind=guided_manual，无 guidance/script/run/cleanup）验证项。
// 带脚本/引导的 authored 型由 materializeAuthoredItemsForTask（Stage 2）单独构造，不走此工厂。
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

/**
 * 构造带 seed checklist 的验证任务（未勾）。record 建组与 reconcile 动态加入 validation 任务共用，
 * 保证 checklist seed 策略一致；checklist 跨 deploy 不继承由「每次进新组都新建任务」天然满足（plan Grilling #7）。
 */
export function createPostDeployVerificationTaskWithSeededChecklist(input: {
	taskId: string;
	columnIdAtMatch: RuntimeBoardColumnId;
	matchedCommits: string[];
	inclusionReason: RuntimePostDeployVerificationInclusionReason;
	// 可选 sha → 简短标题，用于 commit 项标签；缺省用短 sha。
	commitChecklistLabels?: Record<string, string>;
}): RuntimePostDeployVerificationTask {
	const checklist: RuntimePostDeployVerificationChecklistItem[] = input.matchedCommits.map((sha) =>
		buildGuidedManualChecklistItem({
			id: `commit:${sha}`,
			label: input.commitChecklistLabels?.[sha] ?? `验证提交 ${sha.slice(0, 8)}`,
			checked: false,
			source: "commit",
		}),
	);
	// 无 commit 项（如 validation 列纯纳入）时 seed 一条通用手工验证项，避免空 checklist 永远无法「全勾完成」。
	if (checklist.length === 0) {
		checklist.push(
			buildGuidedManualChecklistItem({
				id: MANUAL_VERIFICATION_CHECKLIST_ITEM_ID,
				label: "在已部署 build 上手工验证",
				checked: false,
				source: "commit",
			}),
		);
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
	tasks: RuntimePostDeployVerificationTask[];
}

/**
 * 记录一次部署：折叠该 workspace 之前的活跃组进历史、追加新组，并在同一次 state 锁内连带写 marker，避免半写。
 * 时间戳全部用调用方传入的 nowIso。
 */
export async function createDeploymentGroup(
	input: CreateDeploymentGroupInput,
	nowIso: string,
): Promise<{ group: RuntimePostDeployVerificationDeploymentGroup; marker: RuntimeDeploymentMarker }> {
	const group: RuntimePostDeployVerificationDeploymentGroup = {
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

	return await lockedFileSystem.withLock(getPostDeployVerificationStateLockRequest(), async () => {
		const state = await readPostDeployVerificationStateCorruptionTolerant(nowIso);
		for (const existing of state.deploymentGroups) {
			if (existing.workspaceId === input.workspaceId && existing.foldedAtIso === null) {
				existing.foldedAtIso = nowIso;
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
	return await mutatePostDeployVerificationState(nowIso, (state) => {
		const active = state.deploymentGroups
			.filter((group) => group.workspaceId === workspaceId && group.foldedAtIso === null)
			.sort((left, right) => Date.parse(right.deployedAtIso) - Date.parse(left.deployedAtIso));
		return active[0] ?? null;
	});
}

export interface PostDeployVerificationTaskMutationResult {
	ok: boolean;
	task: RuntimePostDeployVerificationTask | null;
	error?: string;
}

/**
 * 勾选 / 增删自定义 checklist 项。定位键 (deploymentId, taskId)；commit 项不可删（仅 custom 可删）。
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
	task: RuntimePostDeployVerificationTask | null;
	failureReason?: ConsumePendingConfirmationFailureReason;
}

// 核对完成后对该任务下 cleanup.mode==="automatic" 的 authored 项做 per-verification 清理（plan Stage 5）：
// 删资产目录（护栏限于 verifications 根下）+ 注销 pending 定义。manual/retain 一律跳过。
// 在 state 锁外调用（fs + authored 锁），清理失败只 warn，绝不回滚已完成的核对。
async function runAutomaticCleanupForVerifiedTask(
	task: RuntimePostDeployVerificationTask,
	nowIso: string,
): Promise<void> {
	for (const item of task.checklist) {
		if (item.cleanup?.mode !== "automatic" || !item.id.startsWith(AUTHORED_VERIFICATION_ITEM_ID_PREFIX)) {
			continue;
		}
		const verificationId = item.id.slice(AUTHORED_VERIFICATION_ITEM_ID_PREFIX.length);
		try {
			const cleanupResult = await cleanupVerificationAssets(verificationId);
			// 越界护栏拒删（symlink 逃逸等）时资产仍在场：保留 pending 定义不注销，避免「资产残留却已注销定义」
			// 且前端凭 taskVerified 假报已自动清理。already-absent / assets-root-missing / removed 均视为资产已不在场，正常注销。
			if (cleanupResult.skippedReason === "out-of-bounds") {
				logDeploymentDiagnosticWarning(
					`[post-deploy-verification-state] 自动清理被越界护栏拒删，保留 pending 定义不注销 verificationId=${verificationId}`,
				);
				continue;
			}
			await removeAuthoredVerificationDefinition(verificationId, nowIso);
		} catch (error) {
			logDeploymentDiagnosticWarning(
				`[post-deploy-verification-state] 自动清理验证资产失败 verificationId=${verificationId}：${errorMessage(error)}`,
			);
		}
	}
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
	task: RuntimePostDeployVerificationTask | null;
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
	const result = await mutatePostDeployVerificationState(
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
	// 仅在本次真正完成核对（非幂等命中）时触发自动清理，避免重复对已清理项做无谓 fs/锁操作。
	if (result.ok && result.task && result.alreadyVerified !== true) {
		await runAutomaticCleanupForVerifiedTask(result.task, nowIso);
	}
	return result;
}

/**
 * 标记任务已核对完成：置 verifiedAt / boardMovedToDoneAt 为 nowIso，并清 pendingConfirmation。
 * 仅更新 verification state，绝不移列（移列职责在 Web/CLI，见 plan 1d）。
 */
export async function markTaskVerified(
	deploymentId: string,
	taskId: string,
	nowIso: string,
): Promise<PostDeployVerificationTaskMutationResult> {
	const result = await mutatePostDeployVerificationState(
		nowIso,
		(state) => {
			const task = findTask(state, deploymentId, taskId);
			if (!task) {
				return { ok: false, task: null, error: taskNotFoundError(deploymentId, taskId) };
			}
			// 已 verified 则不重复触发清理（幂等），下方以 verifiedAt===nowIso 判定本次是否真正转移。
			const wasAlreadyVerified = task.verifiedAt !== null;
			task.verifiedAt = nowIso;
			task.boardMovedToDoneAt = nowIso;
			task.pendingConfirmation = null;
			// 核对完成宽容清除 droppedReason（finding #3）：Web「先移入 trash 后 confirm」的时间窗里，
			// reconcile 可能已把在途任务误标 moved_out_manually；已核对完成的任务绝不应再带 droppedReason，
			// 否则会被 verification-summary 的 liveTasks(droppedReason===null) 过滤器排除出 done 计数。
			task.droppedReason = null;
			return { ok: true, task, wasAlreadyVerified };
		},
		deploymentId,
	);
	if (result.ok && result.task && result.wasAlreadyVerified !== true) {
		await runAutomaticCleanupForVerifiedTask(result.task, nowIso);
	}
	return { ok: result.ok, task: result.task, ...(result.error ? { error: result.error } : {}) };
}

export interface ReconcileGroupBoardTask {
	taskId: string;
	columnId: RuntimeBoardColumnId;
}

export interface ReconcileGroupInput {
	deploymentId: string;
	// 该组所属 workspace（用于给新进 validation 任务 materialize authored 验证定义）。
	workspaceId: string;
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
): Promise<RuntimePostDeployVerificationDeploymentGroup | null> {
	// 在 state 锁外预取本次可能新进的 validation 任务的 authored items（materialize 会取 authored 定义文件的独立锁，
	// 提前到 state 锁外避免锁嵌套）。同步的 mutator 内只做去重追加。
	// 只为「尚不在组内」的 validation 任务预取：组内任务本就会被 mutator 跳过，为它们逐个读 authored 定义文件
	// 会让 30s 轮询产生随 validation 任务数线性增长的无谓 fs 读。预读组成员用锁外只读快照即可——
	// 组内任务只增不减，快照时已在组内的任务到 mutator 时刻仍在组内；快照后并发新加入的任务最多多预取一次，
	// mutator 的 existingTaskIds 去重保证正确性不受影响。
	const preReadState = await readPostDeployVerificationStateCorruptionTolerant(input.nowIso);
	const taskIdsAlreadyInGroup = new Set(
		findGroup(preReadState, input.deploymentId)?.tasks.map((task) => task.taskId) ?? [],
	);
	const authoredItemsByTaskId = new Map<string, RuntimePostDeployVerificationChecklistItem[]>();
	for (const boardTask of input.currentBoardTasks) {
		if (boardTask.columnId !== "validation" || taskIdsAlreadyInGroup.has(boardTask.taskId)) {
			continue;
		}
		authoredItemsByTaskId.set(
			boardTask.taskId,
			await materializeAuthoredVerificationItemsForTask(input.workspaceId, boardTask.taskId, input.nowIso),
		);
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
				const seededTask = createPostDeployVerificationTaskWithSeededChecklist({
					taskId: boardTask.taskId,
					columnIdAtMatch: boardTask.columnId,
					matchedCommits: [],
					inclusionReason: "validation_column",
				});
				// 追加该任务预取的 authored items（按 id 去重，不覆盖 seed 的 commit/manual 项）。
				const authoredItems = authoredItemsByTaskId.get(boardTask.taskId) ?? [];
				for (const item of authoredItems) {
					if (!seededTask.checklist.some((existing) => existing.id === item.id)) {
						seededTask.checklist.push(item);
					}
				}
				group.tasks.push(seededTask);
			}
			return group;
		},
		input.deploymentId,
	);
}
