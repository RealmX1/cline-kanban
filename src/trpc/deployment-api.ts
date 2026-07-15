// Post-Deploy Verification 的 tRPC handler 层（plan「tRPC / API 契约」+ 1d 移列分工）。
// 纯委托：读写 verification state 交给 src/deployment/post-deploy-verification-state.ts，
// 看板当前列 / agent 回复预览由 runtime-server 经 DI 注入。
// 硬约束（plan 1d）：confirmVerificationComplete **只更新 verification state，绝不移列** —— Web 侧移列由
// completePostDeployVerificationMoveToDone 负责、CLI 走 trashTaskById 链；本层不触碰 board.json。
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type {
	RuntimeConfirmVerificationCompleteRequest,
	RuntimeConfirmVerificationCompleteResponse,
	RuntimeGetPostDeployVerificationStateRequest,
	RuntimeGetPostDeployVerificationStateResponse,
	RuntimePostDeployVerificationState,
	RuntimePostDeployVerificationTask,
	RuntimeRequestVerificationCompleteRequest,
	RuntimeRequestVerificationCompleteResponse,
	RuntimeRunPostDeployVerificationItemRequest,
	RuntimeRunPostDeployVerificationItemResponse,
	RuntimeUpdateVerificationChecklistRequest,
	RuntimeUpdateVerificationChecklistResponse,
} from "../core/api-contract";
import { parsePostDeployVerificationState } from "../core/api-validation";
import type {
	ConsumePendingConfirmationFailureReason,
	ReconcileGroupBoardTask,
} from "../deployment/post-deploy-verification-state";
import {
	applyVerificationRunResult,
	computeRequiredAcknowledgementsForColumn,
	consumePendingConfirmationAndMarkVerified,
	getActiveGroup,
	getPostDeployVerificationStatePath,
	reconcileGroup,
	setPendingConfirmation,
	setVerificationRunState,
	updateTaskChecklist,
} from "../deployment/post-deploy-verification-state";
import { runVerificationScript, toRunSnapshot } from "../deployment/verification-script-runner";
import { logDeploymentDiagnosticWarning } from "../diagnostics/deployment-diagnostics-logger";
import type { RuntimeTrpcContext, RuntimeTrpcWorkspaceScope } from "./app-router";

// pendingConfirmation token 有效期（plan Grilling #8：一次性 + 短期过期）。
const PENDING_CONFIRMATION_TTL_MS = 15 * 60 * 1000;
// 确认框展示的 agent 回复统一截断上限（plan Grilling #5）。
const AGENT_RESPONSE_PREVIEW_MAX_CHARS = 2000;

export interface CreateDeploymentApiDependencies {
	// 当前看板上该 workspace 的任务（taskId + 列）；供 reconcile、完成前列判定、confirm 的「已在 trash」校验。
	loadBoardTasksForWorkspace: (scope: RuntimeTrpcWorkspaceScope) => Promise<ReconcileGroupBoardTask[]>;
	// 任务最近一条 agent 回复预览（Cline=最后 assistant / 终端 agent=latestHookActivity.finalMessage），无则 null。
	loadTaskAgentResponsePreview: (scope: RuntimeTrpcWorkspaceScope, taskId: string) => Promise<string | null>;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isEnoentError(error: unknown): boolean {
	return (
		typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT"
	);
}

// 只读快照：直接读盘 + schema 校验。ENOENT（尚无 state）与损坏都降级为空组 —— 损坏文件的隔离 + 重建由
// state 模块的写路径（mutate 骨架 / getActiveGroup）负责，查询侧不重复实现隔离逻辑。
async function readPostDeployVerificationStateSnapshot(): Promise<RuntimePostDeployVerificationState> {
	try {
		const raw = await readFile(getPostDeployVerificationStatePath(), "utf8");
		return parsePostDeployVerificationState(JSON.parse(raw));
	} catch (error) {
		if (!isEnoentError(error)) {
			logDeploymentDiagnosticWarning(
				`[deployment-api] 读取 post-deploy-verification-state 失败，降级为空组：${errorMessage(error)}`,
			);
		}
		return { deploymentGroups: [] };
	}
}

// checklist 非空且全部勾选才算可完成核对（seed 保证至少一项，空数组防御性判为未完成）。
function isChecklistFullyChecked(task: RuntimePostDeployVerificationTask): boolean {
	return task.checklist.length > 0 && task.checklist.every((item) => item.checked);
}

function truncateAgentResponsePreview(text: string): string {
	return text.length > AGENT_RESPONSE_PREVIEW_MAX_CHARS ? `${text.slice(0, AGENT_RESPONSE_PREVIEW_MAX_CHARS)}…` : text;
}

function taskNotFoundMessage(deploymentId: string, taskId: string): string {
	return `任务未找到：deploymentId=${deploymentId} taskId=${taskId}`;
}

function describeConsumeFailure(reason: ConsumePendingConfirmationFailureReason | undefined): string {
	switch (reason) {
		case "task_not_found":
			return "任务未找到";
		case "no_pending_confirmation":
			return "无待确认 token（可能已过期被回收或已确认）";
		case "token_mismatch":
			return "确认 token 不匹配";
		case "expired":
			return "确认 token 已过期，请重新发起完成核对";
		default:
			return "确认失败";
	}
}

export function createDeploymentApi(deps: CreateDeploymentApiDependencies): RuntimeTrpcContext["deploymentApi"] {
	return {
		getPostDeployVerificationState: async (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeGetPostDeployVerificationStateRequest,
		): Promise<RuntimeGetPostDeployVerificationStateResponse> => {
			const nowIso = new Date().toISOString();
			// active 组选取顺带触发 state 模块的损坏隔离 + 过期 token GC（读时经 mutate 骨架）。
			const activeGroup = await getActiveGroup(scope.workspaceId, nowIso);
			if (activeGroup) {
				// 每次轮询对当前组做双向 reconcile：新进 validation 任务动态加入 + 悬挂任务标 droppedReason（plan 数据流）。
				const boardTasks = await deps.loadBoardTasksForWorkspace(scope);
				await reconcileGroup({
					deploymentId: activeGroup.deploymentId,
					workspaceId: scope.workspaceId,
					currentBoardTasks: boardTasks,
					nowIso,
				});
			}
			// getActiveGroup 已确保盘上为合法 JSON，可安全直读全量并按当前 workspaceId 过滤。
			const snapshot = await readPostDeployVerificationStateSnapshot();
			const workspaceGroups = snapshot.deploymentGroups.filter((group) => group.workspaceId === scope.workspaceId);
			const activeDeploymentId = activeGroup?.deploymentId ?? null;
			const deploymentGroups = input.activeOnly
				? workspaceGroups.filter((group) => group.deploymentId === activeDeploymentId)
				: workspaceGroups;
			return { deploymentGroups, activeDeploymentId };
		},

		// ponytail: 不做逐 mutation 的 workspace 归属校验 —— deploymentId 是 uuid，客户端只能从 workspace 过滤后的
		// getPostDeployVerificationState 得知自己组的 id，本地单用户 dogfood 下跨 workspace 越权无实际意义。
		updateVerificationChecklist: async (
			_scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeUpdateVerificationChecklistRequest,
		): Promise<RuntimeUpdateVerificationChecklistResponse> => {
			// PostDeployVerificationTaskMutationResult 与响应契约同形，直接返回（router output schema 兜底校验）。
			return await updateTaskChecklist(input, new Date().toISOString());
		},

		// 运行一个自动脚本型验证项（plan Stage 3）：置 running（并发护栏）→ spawn 脚本 await 完成 → 写结果。
		// 选择「await 到完成」而非 WS 推送：本地 dogfood ≤timeout 可接受，断线由面板 30s 轮询兜底对账。
		runPostDeployVerificationItem: async (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeRunPostDeployVerificationItemRequest,
		): Promise<RuntimeRunPostDeployVerificationItemResponse> => {
			// workspace 归属校验（与 requestVerificationComplete/confirmVerificationComplete 同形）：run 会 spawn 执行
			// agent 编写的脚本，风险远高于勾选 checkbox，跨 workspace 的 deploymentId 一律在置 running 前拒绝、不触发脚本。
			const snapshot = await readPostDeployVerificationStateSnapshot();
			const group = snapshot.deploymentGroups.find((entry) => entry.deploymentId === input.deploymentId);
			if (!group || group.workspaceId !== scope.workspaceId) {
				return { ok: false, task: null, error: `部署组未找到：deploymentId=${input.deploymentId}` };
			}
			const startedAtIso = new Date().toISOString();
			// 置 running 并取回目标项的 script（并发护栏在此判定：已 running 则拒绝）。
			const started = await setVerificationRunState(
				{ deploymentId: input.deploymentId, taskId: input.taskId, itemId: input.itemId, startedAtIso },
				startedAtIso,
			);
			if (!started.ok || started.task === null) {
				return { ok: false, task: started.task, error: started.error ?? "无法开始运行验证脚本" };
			}
			const item = started.task.checklist.find((entry) => entry.id === input.itemId);
			if (!item || item.script === null) {
				return { ok: false, task: started.task, error: `验证项缺少脚本：${input.itemId}` };
			}

			const outcome = await runVerificationScript({
				verificationId: item.id.startsWith("authored:") ? item.id.slice("authored:".length) : item.id,
				script: item.script,
				startedAtIso,
				finishedAtIsoProvider: () => new Date().toISOString(),
			});
			const applied = await applyVerificationRunResult(
				{
					deploymentId: input.deploymentId,
					taskId: input.taskId,
					itemId: input.itemId,
					run: toRunSnapshot(outcome),
				},
				new Date().toISOString(),
			);
			return { ok: applied.ok, task: applied.task, error: applied.error };
		},

		requestVerificationComplete: async (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeRequestVerificationCompleteRequest,
		): Promise<RuntimeRequestVerificationCompleteResponse> => {
			const nowIso = new Date().toISOString();
			const boardTasks = await deps.loadBoardTasksForWorkspace(scope);
			const currentColumn = boardTasks.find((task) => task.taskId === input.taskId)?.columnId ?? null;
			if (currentColumn === null) {
				return { needsConfirmation: false, error: `任务未在看板上：taskId=${input.taskId}（可能已删除）` };
			}

			const snapshot = await readPostDeployVerificationStateSnapshot();
			const group = snapshot.deploymentGroups.find((entry) => entry.deploymentId === input.deploymentId);
			if (!group || group.workspaceId !== scope.workspaceId) {
				return { needsConfirmation: false, error: `部署组未找到：deploymentId=${input.deploymentId}` };
			}
			const task = group.tasks.find((entry) => entry.taskId === input.taskId);
			if (!task) {
				return { needsConfirmation: false, error: taskNotFoundMessage(input.deploymentId, input.taskId) };
			}
			if (task.droppedReason !== null) {
				return { needsConfirmation: false, error: `任务已从本次部署核对中移除（${task.droppedReason}）` };
			}
			if (!isChecklistFullyChecked(task)) {
				return { needsConfirmation: false, error: "checklist 未全部勾选，无法完成核对" };
			}

			// 按「当前列」重算需确认项（非 columnIdAtMatch 快照）：match 后移列时以此刻实际所在列为准（plan 1d）。
			const requiredAcknowledgements = computeRequiredAcknowledgementsForColumn(currentColumn);
			if (requiredAcknowledgements === null) {
				return { needsConfirmation: false, error: `任务当前列 "${currentColumn}" 不支持完成核对` };
			}

			// 统一「移列先于标记」不变量（issue A）：所有合法来源列（validation/review/in_progress）都发放一次性 token 且
			// **绝不在此落 verifiedAt**；controller 移列成功后才经 confirm 消费 token 并标记完成，移列失败则不标记。
			// validation 仅是 requiredAcknowledgements 为空 → needsConfirmation=false（不弹确认框），但同样走 token+confirm 标记路径，
			// 因此 confirm 恒需有效 token，不给 review/in_progress 留 tokenless 绕过 ack 的后门。
			const needsConfirmation = requiredAcknowledgements.length > 0;
			const token = randomUUID();
			const expiresAtIso = new Date(Date.parse(nowIso) + PENDING_CONFIRMATION_TTL_MS).toISOString();
			const persisted = await setPendingConfirmation(
				input.deploymentId,
				input.taskId,
				{ token, expiresAtIso, requiredAcknowledgements, columnIdAtIssuance: currentColumn },
				nowIso,
			);
			if (!persisted.ok) {
				return { needsConfirmation: false, error: persisted.error ?? "发放确认 token 失败" };
			}
			// 仅确认框需要 agent 回复预览；validation 无弹窗则不取预览。
			const preview = needsConfirmation ? await deps.loadTaskAgentResponsePreview(scope, input.taskId) : null;
			return {
				needsConfirmation,
				confirmationToken: token,
				requiredAcknowledgements,
				...(preview !== null ? { agentResponsePreview: truncateAgentResponsePreview(preview) } : {}),
			};
		},

		confirmVerificationComplete: async (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeConfirmVerificationCompleteRequest,
		): Promise<RuntimeConfirmVerificationCompleteResponse> => {
			const nowIso = new Date().toISOString();
			const boardTasks = await deps.loadBoardTasksForWorkspace(scope);
			const currentColumn = boardTasks.find((task) => task.taskId === input.taskId)?.columnId ?? null;

			const snapshot = await readPostDeployVerificationStateSnapshot();
			const group = snapshot.deploymentGroups.find((entry) => entry.deploymentId === input.deploymentId);
			if (!group || group.workspaceId !== scope.workspaceId) {
				return { ok: false, task: null, error: `部署组未找到：deploymentId=${input.deploymentId}` };
			}
			const task = group.tasks.find((entry) => entry.taskId === input.taskId);
			if (!task) {
				return { ok: false, task: null, error: taskNotFoundMessage(input.deploymentId, input.taskId) };
			}
			// Web 时序为「先移列后 confirm」：确认时任务应已在 Done（trash）列（plan 1d / Grilling #8）。
			if (currentColumn !== "trash") {
				return {
					ok: false,
					task,
					error: `确认要求任务已移入 Done（trash），当前列：${currentColumn ?? "未在看板"}`,
				};
			}
			// 幂等恢复（issue B）：任务已在 trash 且此前已 verified —— confirm 成功但响应丢失 / 用户重复提交 → 直接返回成功，
			// 不再要求 token（避免「移列成功、标记成功但客户端未收到响应」时 requestVerificationComplete 对 trash 列拒发新 token 造成死角）。
			if (task.verifiedAt !== null) {
				return { ok: true, task };
			}
			if (!isChecklistFullyChecked(task)) {
				return { ok: false, task, error: "checklist 未全部勾选" };
			}
			const pending = task.pendingConfirmation;
			if (!pending) {
				return { ok: false, task, error: "无待确认 token（可能已过期被回收或已确认）" };
			}
			// acks 必须覆盖发放时记录的 requiredAcknowledgements（UI 顺序对话框逐项收集）。
			const missingAcks = pending.requiredAcknowledgements.filter((ack) => !input.acks.includes(ack));
			if (missingAcks.length > 0) {
				return {
					ok: false,
					task,
					error: `缺少确认项：${missingAcks.join(", ")}`,
					requiredAcknowledgements: pending.requiredAcknowledgements,
				};
			}
			// 原子「消费 token + 标记完成」（issue B）：token 校验/过期判定与置 verifiedAt/boardMovedToDoneAt 在单次写盘内完成，
			// 消除「token 已消费但随后 markTaskVerified 失败」的不可恢复中间态。仅更新 verification state，绝不移列。
			const marked = await consumePendingConfirmationAndMarkVerified(
				input.deploymentId,
				input.taskId,
				input.token,
				nowIso,
			);
			if (!marked.ok) {
				return { ok: false, task: marked.task, error: describeConsumeFailure(marked.failureReason) };
			}
			return { ok: true, task: marked.task };
		},
	};
}
