import {
	createGlobalMarkdownDraftRecoveryTitle,
	globalMarkdownDraftCreateInputSchema,
	globalMarkdownDraftSaveIdentitySchema,
	globalMarkdownDraftUpdateInputSchema,
} from "@runtime-contract";
import { TRPCClientError } from "@trpc/client";
import {
	type GlobalMarkdownDraft,
	type GlobalMarkdownDraftCreateInput,
	type GlobalMarkdownDraftUpdateInput,
	globalMarkdownDraftApi,
} from "@/runtime/global-markdown-draft-query";
import {
	isKanbanWebUiPageLoadRequestOriginNonceUnknownToRuntimeError,
	isRuntimeTrpcTransportFailure,
} from "@/runtime/trpc-client";
import { createRandomUuidV4WithInsecureContextFallback as createDraftUuid } from "@/utils/create-random-uuid-v4-with-insecure-context-fallback";

const draftRecoveryStoragePrefix = "kanban.global-markdown-draft.recovery.";
const selectedDraftStorageKey = "kanban.global-markdown-draft.selected";
const maximumDraftSaveRetryDelayMs = 30_000;
const draftSaveRequestOptions = () => ({ signal: AbortSignal.timeout(15_000) });
export const untitledGlobalMarkdownDraftTitle = "未命名草稿";
type DraftContent = Pick<GlobalMarkdownDraft, "title" | "markdown">;
type FrozenDraftSave = GlobalMarkdownDraftCreateInput | GlobalMarkdownDraftUpdateInput;
type DraftSaveIdentity = Pick<GlobalMarkdownDraftUpdateInput, "saveRequestId" | "saveWriterId" | "saveSequence">;
type PendingDraftSave = {
	storageRevisionId: string;
	supersededStorageRevisionIds: string[];
	desiredSaveIdentity: DraftSaveIdentity;
	draft: GlobalMarkdownDraft;
	frozenSave?: FrozenDraftSave;
};

interface DraftBrowserSnapshot {
	drafts: GlobalMarkdownDraft[];
	selectedDraftId: string | null;
	pendingDraftIds: ReadonlySet<string>;
	deletingDraftIds: ReadonlySet<string>;
	listLoading: boolean;
	listFailed: boolean;
	saveFailed: boolean;
	recoveryStorageFailed: boolean;
	notice: string;
}

function legacyDraftSaveIdentity(saveRequestId: string): DraftSaveIdentity {
	return { saveRequestId, saveWriterId: saveRequestId, saveSequence: 1 };
}

const legacyFrozenDraftUpdateSchema = globalMarkdownDraftUpdateInputSchema.omit({
	saveWriterId: true,
	saveSequence: true,
});

function readStoredDraftSaves() {
	const recoveredRecords = new Map<string, PendingDraftSave>();
	const supersededRevisionIds = new Set<string>();
	for (const key of Object.keys(localStorage)) {
		if (!key.startsWith(draftRecoveryStoragePrefix)) continue;
		try {
			const record = JSON.parse(localStorage.getItem(key) ?? "null") as
				| (PendingDraftSave & {
						desiredSaveRequestId?: string;
						supersedesStorageRevisionId?: string;
				  })
				| null;
			if (
				!record ||
				key !== draftRecoveryStoragePrefix + record.storageRevisionId ||
				!globalMarkdownDraftCreateInputSchema.shape.id.safeParse(record.storageRevisionId).success ||
				!globalMarkdownDraftCreateInputSchema.safeParse(record.draft).success ||
				!Number.isSafeInteger(record.draft.version) ||
				record.draft.version < 0 ||
				!Number.isFinite(record.draft.updatedAt)
			)
				continue;
			const frozenUpdate = globalMarkdownDraftUpdateInputSchema.safeParse(record.frozenSave).data;
			const legacyUpdate = legacyFrozenDraftUpdateSchema.safeParse(record.frozenSave).data;
			const frozenCreate = globalMarkdownDraftCreateInputSchema.safeParse(record.frozenSave);
			const oldSaveRequestId = globalMarkdownDraftCreateInputSchema.shape.id.safeParse(record.desiredSaveRequestId);
			const desiredSaveIdentity = globalMarkdownDraftSaveIdentitySchema.safeParse(record.desiredSaveIdentity).data;
			const supersededStorageRevisionIds = Array.isArray(record.supersededStorageRevisionIds)
				? record.supersededStorageRevisionIds
				: record.supersedesStorageRevisionId
					? [record.supersedesStorageRevisionId]
					: [];
			const validSupersededIds = supersededStorageRevisionIds.filter(
				(revisionId) =>
					revisionId !== record.storageRevisionId &&
					globalMarkdownDraftCreateInputSchema.shape.id.safeParse(revisionId).success,
			);
			for (const revisionId of validSupersededIds) supersededRevisionIds.add(revisionId);
			recoveredRecords.set(record.storageRevisionId, {
				...record,
				supersededStorageRevisionIds: validSupersededIds,
				desiredSaveIdentity:
					desiredSaveIdentity ?? legacyDraftSaveIdentity(oldSaveRequestId.data ?? record.storageRevisionId),
				frozenSave:
					frozenUpdate ??
					(legacyUpdate
						? { ...legacyUpdate, ...legacyDraftSaveIdentity(legacyUpdate.saveRequestId) }
						: record.draft.version === 0
							? frozenCreate.data
							: undefined),
			});
		} catch {
			// 保留无法识别的浏览器副本，继续读取其他草稿。
		}
	}
	// 同一旧副本可产生多个独立后继。只淘汰明确被替换的版本，保留每个分支的末端。
	for (const revisionId of supersededRevisionIds) {
		if (recoveredRecords.delete(revisionId)) {
			try {
				localStorage.removeItem(draftRecoveryStoragePrefix + revisionId);
			} catch {
				// 分支末端已经持久保存，旧键残留可以在读取时再次过滤。
			}
		}
	}
	return { recoveredRecords, supersededRevisionIds };
}

function canAutomaticallyRetryDraftSave(error: unknown): boolean {
	return (
		isRuntimeTrpcTransportFailure(error) ||
		isKanbanWebUiPageLoadRequestOriginNonceUnknownToRuntimeError(error) ||
		(error instanceof TRPCClientError && (error.data?.httpStatus === 429 || error.data?.httpStatus >= 500))
	);
}

export class GlobalMarkdownDraftBrowserSession {
	private readonly listeners = new Set<() => void>();
	private readonly runtimeDrafts = new Map<string, GlobalMarkdownDraft>();
	private readonly pendingSaves = new Map<string, PendingDraftSave>();
	private readonly persistedRecoveryRevisionIds = new Map<string, string>();
	private readonly pausedSaveRevisionIds = new Map<string, string>();
	private readonly deletingDraftIds = new Set<string>();
	private snapshot: DraftBrowserSnapshot = {
		drafts: [],
		selectedDraftId: null,
		pendingDraftIds: new Set(),
		deletingDraftIds: new Set(),
		listLoading: true,
		listFailed: false,
		saveFailed: false,
		recoveryStorageFailed: false,
		notice: "",
	};
	private initialized = false;
	private recoveryStorageUnreadable = false;
	private readonly saveWriterId = createDraftUuid();
	private latestSaveSequence = 0;
	private saving = false;
	private saveTimer?: number;
	private retryDelayMs = 1_000;
	private runtimeMutationRevision = 0;
	private listRequestSequence = 0;

	getSnapshot = () => this.snapshot;
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	private publish(patch?: Partial<DraftBrowserSnapshot>) {
		const drafts = new Map(this.runtimeDrafts);
		const pendingDraftIds = new Set<string>();
		for (const { draft } of this.pendingSaves.values()) {
			drafts.set(draft.id, draft);
			pendingDraftIds.add(draft.id);
		}
		this.snapshot = {
			...this.snapshot,
			...patch,
			drafts: [...drafts.values()].sort((first, second) => second.updatedAt - first.updatedAt),
			pendingDraftIds,
			deletingDraftIds: new Set(this.deletingDraftIds),
			recoveryStorageFailed:
				this.recoveryStorageUnreadable ||
				[...this.pendingSaves].some(
					([slotId, record]) => this.persistedRecoveryRevisionIds.get(slotId) !== record.storageRevisionId,
				),
		};
		for (const listener of this.listeners) listener();
	}

	start = () => {
		if (this.initialized) return;
		this.initialized = true;
		try {
			this.restorePendingSaves();
			this.publish({ selectedDraftId: localStorage.getItem(selectedDraftStorageKey) });
		} catch {
			this.recoveryStorageUnreadable = true;
			this.publish();
		}
		window.addEventListener("online", this.retry);
		window.addEventListener("focus", this.retry);
		document.addEventListener("visibilitychange", () => {
			if (!document.hidden) this.retry();
		});
		if (this.pendingSaves.size) this.scheduleSave(0);
	};

	private restorePendingSaves() {
		try {
			const { recoveredRecords, supersededRevisionIds } = readStoredDraftSaves();
			if (!this.saving) {
				for (const [slotId, pending] of this.pendingSaves) {
					if (
						supersededRevisionIds.has(pending.storageRevisionId) &&
						this.persistedRecoveryRevisionIds.get(slotId) === pending.storageRevisionId
					) {
						this.pendingSaves.delete(slotId);
						this.persistedRecoveryRevisionIds.delete(slotId);
						this.pausedSaveRevisionIds.delete(slotId);
					}
				}
			}
			const knownRevisions = new Set(this.persistedRecoveryRevisionIds.values());
			for (const [revisionId, record] of recoveredRecords) {
				if (knownRevisions.has(revisionId)) continue;
				this.pendingSaves.set(revisionId, record);
				this.persistedRecoveryRevisionIds.set(revisionId, revisionId);
			}
			this.recoveryStorageUnreadable = false;
		} catch {
			this.recoveryStorageUnreadable = true;
		}
	}

	refresh = async (): Promise<void> => {
		this.start();
		this.restorePendingSaves();
		this.publish();
		if (this.pendingSaves.size && !this.saving && this.saveTimer === undefined) this.scheduleSave(0);
		const request = ++this.listRequestSequence;
		const mutationRevision = this.runtimeMutationRevision;
		try {
			const drafts = await globalMarkdownDraftApi.list.query(undefined, draftSaveRequestOptions());
			if (request !== this.listRequestSequence) return;
			if (mutationRevision !== this.runtimeMutationRevision) return this.refresh();
			this.runtimeDrafts.clear();
			for (const draft of drafts) this.runtimeDrafts.set(draft.id, draft);
			this.publish({ listLoading: false, listFailed: false });
		} catch {
			if (request === this.listRequestSequence) this.publish({ listLoading: false, listFailed: true });
		}
	};

	select = (id: string | null) => {
		try {
			if (id) localStorage.setItem(selectedDraftStorageKey, id);
			else localStorage.removeItem(selectedDraftStorageKey);
		} catch {
			// 选中状态仍可在当前页面恢复。
		}
		this.publish({ selectedDraftId: id });
	};

	create = () => {
		const id = createDraftUuid();
		this.edit({ id, title: untitledGlobalMarkdownDraftTitle, markdown: "", version: 0, updatedAt: Date.now() }, {});
		this.select(id);
		this.scheduleSave(0);
	};

	edit = (draft: GlobalMarkdownDraft, change: Partial<DraftContent>) => {
		if (this.deletingDraftIds.has(draft.id)) return;
		const [pendingSlotId, pending] =
			[...this.pendingSaves.entries()].reverse().find(([, record]) => record.draft.id === draft.id) ?? [];
		const edited = { ...(pending?.draft ?? draft), ...change };
		if (!pending && draft.version > 0 && edited.title === draft.title && edited.markdown === draft.markdown) return;
		const initialCreate =
			edited.version === 0 ? { id: edited.id, title: edited.title, markdown: edited.markdown } : undefined;
		this.replacePendingSave(
			pendingSlotId ?? createDraftUuid(),
			edited,
			{ saveRequestId: createDraftUuid(), saveWriterId: this.saveWriterId, saveSequence: ++this.latestSaveSequence },
			pending?.frozenSave ?? initialCreate,
		);
		this.retryDelayMs = 1_000;
		this.scheduleSave(450);
	};

	private replacePendingSave(
		slotId: string,
		draft: GlobalMarkdownDraft,
		desiredSaveIdentity: DraftSaveIdentity,
		frozenSave?: FrozenDraftSave,
	) {
		// 每一版副本用独立键。旧请求完成时只能清除自己读过的那一版。
		const previousPersistedRevisionId = this.persistedRecoveryRevisionIds.get(slotId);
		const supersededStorageRevisionIds = this.pendingSaves.get(slotId)?.supersededStorageRevisionIds ?? [];
		const record = {
			storageRevisionId: createDraftUuid(),
			supersededStorageRevisionIds:
				previousPersistedRevisionId && !supersededStorageRevisionIds.includes(previousPersistedRevisionId)
					? [...supersededStorageRevisionIds, previousPersistedRevisionId]
					: supersededStorageRevisionIds,
			desiredSaveIdentity,
			draft,
			frozenSave,
		};
		this.pendingSaves.set(slotId, record);
		try {
			localStorage.setItem(draftRecoveryStoragePrefix + record.storageRevisionId, JSON.stringify(record));
			this.persistedRecoveryRevisionIds.set(slotId, record.storageRevisionId);
			if (previousPersistedRevisionId)
				localStorage.removeItem(draftRecoveryStoragePrefix + previousPersistedRevisionId);
		} catch {
			// 界面从每个待同步版本与实际写入版本的差异派生恢复状态。
		}
		this.publish();
	}

	private scheduleSave(delayMs: number) {
		window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = undefined;
			void this.flush();
		}, delayMs);
	}

	retry = () => {
		this.retryDelayMs = 1_000;
		this.pausedSaveRevisionIds.clear();
		this.restorePendingSaves();
		this.publish();
		if (this.snapshot.listFailed) void this.refresh();
		if (this.pendingSaves.size) this.scheduleSave(0);
	};

	private async flush() {
		if (this.saving) return;
		this.restorePendingSaves();
		this.saving = true;
		let saveFailed = false;
		let retryableSaveFailed = false;
		let hasRebasedSave = false;
		for (const [slotId, pending] of this.pendingSaves) {
			if (this.pausedSaveRevisionIds.get(slotId) === pending.storageRevisionId) {
				saveFailed = true;
				continue;
			}
			try {
				const { id, title, markdown, version } = pending.draft;
				const save =
					pending.frozenSave ??
					(version > 0
						? {
								id,
								title,
								markdown,
								expectedVersion: version,
								...pending.desiredSaveIdentity,
							}
						: { id, title, markdown });
				// 当前持久副本已足以重建相同请求。之后有新编辑时才额外保存冻结正文。
				if (!pending.frozenSave) this.pendingSaves.set(slotId, { ...pending, frozenSave: save });
				if ("expectedVersion" in save) {
					const result = await globalMarkdownDraftApi.update.mutate(save, draftSaveRequestOptions());
					if (result.status === "recovered") {
						if (result.currentDraft) this.runtimeDrafts.set(id, result.currentDraft);
						else this.runtimeDrafts.delete(id);
					}
					this.completeSave(slotId, save, result.draft, result.status === "recovered");
				} else {
					this.completeSave(
						slotId,
						save,
						await globalMarkdownDraftApi.create.mutate(save, draftSaveRequestOptions()),
						false,
					);
				}
				hasRebasedSave ||= this.pendingSaves.has(slotId);
			} catch (error) {
				saveFailed = true;
				if (canAutomaticallyRetryDraftSave(error)) retryableSaveFailed = true;
				else this.pausedSaveRevisionIds.set(slotId, pending.storageRevisionId);
				this.publish({ saveFailed });
			}
		}
		this.saving = false;
		this.publish({ saveFailed });
		if (hasRebasedSave) {
			this.scheduleSave(0);
		} else if (saveFailed) {
			if (retryableSaveFailed && navigator.onLine && !document.hidden) {
				this.scheduleSave(this.retryDelayMs);
				this.retryDelayMs = Math.min(maximumDraftSaveRetryDelayMs, this.retryDelayMs * 2);
			}
		} else {
			this.retryDelayMs = 1_000;
			if (this.pendingSaves.size) this.scheduleSave(0);
		}
	}

	private completeSave(slotId: string, save: FrozenDraftSave, saved: GlobalMarkdownDraft | null, recovered: boolean) {
		const pending = this.pendingSaves.get(slotId);
		if (!pending) return;
		this.runtimeMutationRevision++;
		if (saved) this.runtimeDrafts.set(saved.id, saved);
		else if (!recovered) this.runtimeDrafts.delete(save.id);
		const { title, markdown } = pending.draft;
		const hasNewerLocalEdits = title !== save.title || markdown !== save.markdown;
		const nextDraftId = saved?.id ?? (hasNewerLocalEdits ? pending.desiredSaveIdentity.saveRequestId : null);
		if (hasNewerLocalEdits && nextDraftId) {
			const nextDraft = {
				id: nextDraftId,
				version: saved ? (recovered || !("expectedVersion" in save) ? 1 : save.expectedVersion + 1) : 0,
				updatedAt: Date.now(),
				title: recovered
					? title === save.title && saved
						? saved.title
						: createGlobalMarkdownDraftRecoveryTitle(title)
					: title,
				markdown,
			};
			this.replacePendingSave(
				slotId,
				nextDraft,
				pending.desiredSaveIdentity,
				saved
					? undefined
					: {
							id: nextDraft.id,
							title: nextDraft.title,
							markdown: nextDraft.markdown,
						},
			);
		} else {
			this.pendingSaves.delete(slotId);
			this.pausedSaveRevisionIds.delete(slotId);
			const recoveryRevisionId = this.persistedRecoveryRevisionIds.get(slotId);
			this.persistedRecoveryRevisionIds.delete(slotId);
			try {
				if (recoveryRevisionId) localStorage.removeItem(draftRecoveryStoragePrefix + recoveryRevisionId);
			} catch {
				// 服务端已有确认回执，残留副本可以安全重试。
			}
		}
		if (this.snapshot.selectedDraftId === save.id && nextDraftId !== save.id) this.select(nextDraftId);
		this.publish({
			...(recovered && saved ? { notice: "同步发生版本冲突，本次编辑已保存为恢复草稿。" } : {}),
		});
	}

	delete = async (draft: GlobalMarkdownDraft) => {
		if (this.snapshot.pendingDraftIds.has(draft.id) || this.deletingDraftIds.has(draft.id)) return;
		this.deletingDraftIds.add(draft.id);
		this.publish({ notice: "" });
		try {
			const result = await globalMarkdownDraftApi.delete.mutate(
				{ id: draft.id, expectedVersion: draft.version },
				draftSaveRequestOptions(),
			);
			this.runtimeMutationRevision++;
			if (result.status === "conflict") {
				this.runtimeDrafts.set(draft.id, result.currentDraft);
				this.publish({ notice: "草稿已更新。请核对新版本后再次删除。" });
			} else {
				this.runtimeDrafts.delete(draft.id);
				if (this.snapshot.selectedDraftId === draft.id) this.select(null);
			}
		} catch {
			this.publish({ notice: "删除结果尚未确认，请重试。" });
		} finally {
			this.deletingDraftIds.delete(draft.id);
			this.publish();
		}
	};
}

export const globalMarkdownDraftBrowserSession = new GlobalMarkdownDraftBrowserSession();
