import { useSyncExternalStore } from "react";
import type {
	RuntimeAgentDefinition,
	RuntimeAgentId,
	RuntimeTaskConversationSessionCreateRequest,
	RuntimeTaskSessionSummary,
} from "@/runtime/types";
import { LocalStorageKey, readLocalStorageItem, writeLocalStorageItem } from "@/storage/local-storage-store";
import type { BoardCard } from "@/types";
import { createRandomUuidV4WithInsecureContextFallback } from "@/utils/create-random-uuid-v4-with-insecure-context-fallback";

export interface SideSessionCreationWorkbenchTarget {
	workspaceId: string;
	task: BoardCard;
	mainSessionSummary: RuntimeTaskSessionSummary;
	agentId: RuntimeAgentId;
	agents?: RuntimeAgentDefinition[];
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	onCreated?: (sessionId: string) => void;
}
export interface SideSessionCreationWorkbenchDraft {
	draftId: string;
	request: RuntimeTaskConversationSessionCreateRequest;
	pendingSubmission?: RuntimeTaskConversationSessionCreateRequest;
}
let activeTarget: SideSessionCreationWorkbenchTarget | null = null;
const listeners = new Set<() => void>();
export function openSideSessionCreationWorkbench(target: SideSessionCreationWorkbenchTarget) {
	activeTarget = target;
	for (const listener of listeners) listener();
}
export function refreshSideSessionCreationWorkbenchContext(
	target: Pick<SideSessionCreationWorkbenchTarget, "workspaceId" | "task" | "mainSessionSummary" | "taskSessions">,
) {
	if (
		!activeTarget ||
		activeTarget.workspaceId !== target.workspaceId ||
		activeTarget.task.id !== target.task.id ||
		activeTarget.task.createdAt !== target.task.createdAt
	)
		return;
	if (
		activeTarget.mainSessionSummary === target.mainSessionSummary &&
		activeTarget.taskSessions === target.taskSessions
	)
		return;
	activeTarget = { ...activeTarget, mainSessionSummary: target.mainSessionSummary, taskSessions: target.taskSessions };
	for (const listener of listeners) listener();
}
export function closeSideSessionCreationWorkbench() {
	activeTarget = null;
	for (const listener of listeners) listener();
}
export function useSideSessionCreationWorkbenchTarget() {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		() => activeTarget,
		() => null,
	);
}
export function sideSessionCreationDraftIdentity(
	target: SideSessionCreationWorkbenchTarget,
	role: "task_collaborator" | "by_the_way",
	draftId?: string,
) {
	return JSON.stringify([
		target.workspaceId,
		target.task.id,
		target.task.createdAt,
		role,
		...(draftId ? [draftId] : []),
	]);
}
interface PersistedSideSessionCreationDrafts {
	schemaVersion: 2;
	activeDraftIdentityByCreationScope: Record<string, string>;
	draftsByIdentity: Record<string, SideSessionCreationWorkbenchDraft>;
}
function readDrafts(): PersistedSideSessionCreationDrafts {
	const raw = readLocalStorageItem(LocalStorageKey.SideSessionCreationWorkbenchDrafts);
	const empty: PersistedSideSessionCreationDrafts = {
		schemaVersion: 2,
		activeDraftIdentityByCreationScope: {},
		draftsByIdentity: {},
	};
	if (!raw) return empty;
	try {
		const value: unknown = JSON.parse(raw);
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("草稿格式不可读");
		if ("schemaVersion" in value) {
			if (
				value.schemaVersion !== 2 ||
				!("activeDraftIdentityByCreationScope" in value) ||
				!("draftsByIdentity" in value) ||
				!value.activeDraftIdentityByCreationScope ||
				typeof value.activeDraftIdentityByCreationScope !== "object" ||
				Array.isArray(value.activeDraftIdentityByCreationScope) ||
				!value.draftsByIdentity ||
				typeof value.draftsByIdentity !== "object" ||
				Array.isArray(value.draftsByIdentity)
			)
				throw new Error("草稿索引不可读");
			return value as PersistedSideSessionCreationDrafts;
		}
		// 保留旧草稿的原始请求与幂等身份，只迁移索引形态。
		for (const [scope, draft] of Object.entries(value as Record<string, SideSessionCreationWorkbenchDraft>)) {
			if (!draft?.draftId || !draft.request || draft.request.idempotencyKey !== draft.draftId)
				throw new Error("草稿身份不可读");
			const identity = JSON.stringify([...JSON.parse(scope), draft.draftId]);
			empty.activeDraftIdentityByCreationScope[scope] = identity;
			empty.draftsByIdentity[identity] = draft;
		}
		return empty;
	} catch {
		// 损坏记录独立留存；备份失败时禁止任何后续写入覆盖原文。
		const backup = readLocalStorageItem(LocalStorageKey.SideSessionCreationWorkbenchUnreadableDraftRecoveryCopies);
		if (
			!writeLocalStorageItem(
				LocalStorageKey.SideSessionCreationWorkbenchUnreadableDraftRecoveryCopies,
				JSON.stringify({ previousRecoveryCopies: backup, recoveredAtEpochMs: Date.now(), originalText: raw }),
			)
		)
			throw new Error("草稿不可读且备份失败，原记录已保留，请释放浏览器存储后重试。");
		if (!writeLocalStorageItem(LocalStorageKey.SideSessionCreationWorkbenchDrafts, JSON.stringify(empty)))
			throw new Error("草稿恢复索引未能写入，原文备份已保留。");
		return empty;
	}
}
export function readActiveSideSessionCreationDraft(
	target: SideSessionCreationWorkbenchTarget,
	role: "task_collaborator" | "by_the_way",
): SideSessionCreationWorkbenchDraft | null {
	const drafts = readDrafts();
	const activeIdentity = drafts.activeDraftIdentityByCreationScope[sideSessionCreationDraftIdentity(target, role)];
	const saved = activeIdentity ? drafts.draftsByIdentity[activeIdentity] : undefined;
	if (
		saved?.draftId &&
		saved.request?.idempotencyKey === saved.draftId &&
		saved.request.taskId === target.task.id &&
		saved.request.expectedTaskIncarnationCreatedAtEpochMs === target.task.createdAt &&
		saved.request.sessionRole === role
	)
		return saved;
	return null;
}
export function readOrCreateSideSessionCreationDraft(
	target: SideSessionCreationWorkbenchTarget,
	role: "task_collaborator" | "by_the_way",
	startInPlanMode: boolean,
): SideSessionCreationWorkbenchDraft {
	return (
		readActiveSideSessionCreationDraft(target, role) ?? createSideSessionCreationDraft(target, role, startInPlanMode)
	);
}
export function updatePersistedSideSessionCreationDraftRequest(
	target: SideSessionCreationWorkbenchTarget,
	role: "task_collaborator" | "by_the_way",
	draftId: string,
	patch: Partial<RuntimeTaskConversationSessionCreateRequest>,
): void {
	const drafts = readDrafts();
	const identity = sideSessionCreationDraftIdentity(target, role, draftId);
	const saved = drafts.draftsByIdentity[identity];
	if (!saved || saved.draftId !== draftId || saved.pendingSubmission) return;
	drafts.draftsByIdentity[identity] = { ...saved, request: { ...saved.request, ...patch } };
	if (!writeLocalStorageItem(LocalStorageKey.SideSessionCreationWorkbenchDrafts, JSON.stringify(drafts)))
		throw new Error("草稿未能持久保存，请保留当前窗口后重试。");
}
export function createSideSessionCreationDraft(
	target: SideSessionCreationWorkbenchTarget,
	role: "task_collaborator" | "by_the_way",
	startInPlanMode: boolean,
): SideSessionCreationWorkbenchDraft {
	const draftId = createRandomUuidV4WithInsecureContextFallback();
	return {
		draftId,
		request: {
			taskId: target.task.id,
			expectedTaskIncarnationCreatedAtEpochMs: target.task.createdAt,
			idempotencyKey: draftId,
			sessionRole: role,
			agentId: role === "by_the_way" && !["claude", "codex"].includes(target.agentId) ? "codex" : target.agentId,
			startInPlanMode,
			contextSource: "current_main",
			initialMessage: "",
			images: [],
			creationReason: "用户在共享创建工作台中创建侧会话",
			taskAgentPermissionMode: "bypass_all_permission_prompts",
			codexConfigurationPermissionSelectionSource: "task_local",
		},
	};
}
export function persistSideSessionCreationDraft(
	target: SideSessionCreationWorkbenchTarget,
	draft: SideSessionCreationWorkbenchDraft | null,
	role: "task_collaborator" | "by_the_way",
	expectedDraftId?: string,
) {
	const drafts = readDrafts();
	const scope = sideSessionCreationDraftIdentity(target, role);
	if (draft) {
		const identity = sideSessionCreationDraftIdentity(target, role, draft.draftId);
		drafts.activeDraftIdentityByCreationScope[scope] = identity;
		drafts.draftsByIdentity[identity] = draft;
	} else {
		const identity = expectedDraftId
			? sideSessionCreationDraftIdentity(target, role, expectedDraftId)
			: drafts.activeDraftIdentityByCreationScope[scope];
		if (identity) delete drafts.draftsByIdentity[identity];
		if (drafts.activeDraftIdentityByCreationScope[scope] === identity)
			delete drafts.activeDraftIdentityByCreationScope[scope];
	}
	if (!writeLocalStorageItem(LocalStorageKey.SideSessionCreationWorkbenchDrafts, JSON.stringify(drafts)))
		throw new Error("草稿未能持久保存，请保留当前窗口后重试。");
}
