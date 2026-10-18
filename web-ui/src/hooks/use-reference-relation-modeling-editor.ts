import type { WebUiUserDecisionClientCharacteristics } from "@runtime-work-unit-relation-assertion-write-api-contract";
import type {
	ReferenceRelationModelingDraft,
	ReferenceRelationModelingEditorDraft,
	RelationModelingPreviewResponse,
} from "@runtime-work-unit-relation-modeling-api-contract";
import { referenceRelationModelingEditorDraftSchema } from "@runtime-work-unit-relation-modeling-api-contract";
import isDeepEqual from "fast-deep-equal";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	applyReferenceRelationModelingChangesFromExplicitUserGesture,
	persistRelationModelingEditorDraft,
	readRelationModelingEditorDraft,
	readRelationModelingPreview,
} from "@/runtime/work-unit-relation-modeling-query";
import { createRandomUuidV4WithInsecureContextFallback } from "@/utils/create-random-uuid-v4-with-insecure-context-fallback";

function emptyDraft(): ReferenceRelationModelingEditorDraft {
	return {
		referenceRelationDrafts: [],
		relationRevocations: [],
		createdTaskId: null,
		createdTaskCardSnapshot: null,
		modelingSubmissionId: createRandomUuidV4WithInsecureContextFallback(),
		creationPrompt: "",
		creationTitle: "",
	};
}
function browserDraftOwnerId() {
	const key = "reference-relation-modeling-browser-tab-identity";
	const existing = sessionStorage.getItem(key);
	if (existing) return existing;
	const identity = createRandomUuidV4WithInsecureContextFallback();
	sessionStorage.setItem(key, identity);
	return identity;
}

export function useReferenceRelationModelingEditor(input: {
	workspaceId: string | null;
	taskId: string | null;
	draftTaskTitle?: string;
	active?: boolean;
}) {
	const [ownerId] = useState(browserDraftOwnerId);
	const draftScopeId = `${input.taskId ?? "task-being-created"}:${ownerId}`;
	const mirrorKey = `reference-relation-modeling:${input.workspaceId}:${draftScopeId}`;
	const currentScopeRef = useRef(mirrorKey);
	currentScopeRef.current = mirrorKey;
	const [draft, setDraft] = useState<ReferenceRelationModelingEditorDraft>(emptyDraft);
	const [ready, setReady] = useState(false);
	const [hydratedScope, setHydratedScope] = useState<string | null>(null);
	const [writeError, setWriteError] = useState<string | null>(null);
	const [preview, setPreview] = useState<RelationModelingPreviewResponse | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [draftPersistenceError, setDraftPersistenceError] = useState<string | null>(null);
	const [draftScopesWithApplyInFlight, setDraftScopesWithApplyInFlight] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const saving = draftScopesWithApplyInFlight.has(mirrorKey);
	const [depth, setDepth] = useState<1 | 2 | 3>(2);
	const [refreshSequence, setRefreshSequence] = useState(0);
	const saveTail = useRef<Promise<unknown>>(Promise.resolve());
	const draftRef = useRef(draft);
	draftRef.current = draft;

	useEffect(() => {
		let current = true;
		setReady(false);
		setPreview(null);
		setWriteError(null);
		setError(null);
		if (!input.workspaceId || input.active === false) return;
		let mirror: ReferenceRelationModelingEditorDraft | null = null;
		try {
			const saved = localStorage.getItem(mirrorKey);
			if (saved) {
				const parsed = referenceRelationModelingEditorDraftSchema.safeParse(JSON.parse(saved));
				if (parsed.success) mirror = parsed.data;
			}
		} catch {
			/* 服务端仍可恢复草稿。 */
		}
		const workspaceId = input.workspaceId;
		// 重开前先完成已排队的保存与放弃删除，避免旧草稿被恢复并再次自动保存。
		const persistedDraftAfterQueuedWrites = saveTail.current
			.catch(() => undefined)
			.then(() => readRelationModelingEditorDraft(workspaceId, draftScopeId));
		persistedDraftAfterQueuedWrites.then(
			(saved) => {
				if (current) {
					setDraft(mirror ?? saved ?? emptyDraft());
					setHydratedScope(mirrorKey);
					setReady(true);
				}
			},
			(failure: unknown) => {
				if (current) {
					setDraft(mirror ?? emptyDraft());
					setHydratedScope(mirrorKey);
					setReady(true);
					setDraftPersistenceError(
						`草稿暂时只保存在此浏览器：${failure instanceof Error ? failure.message : String(failure)}`,
					);
				}
			},
		);
		return () => {
			current = false;
		};
	}, [input.workspaceId, input.active, draftScopeId, mirrorKey]);
	const persist = useCallback(
		(value: ReferenceRelationModelingEditorDraft | null) => {
			if (!input.workspaceId) return Promise.resolve();
			const workspaceId = input.workspaceId;
			saveTail.current = saveTail.current
				.catch(() => undefined)
				.then(() => persistRelationModelingEditorDraft(workspaceId, draftScopeId, value));
			return saveTail.current;
		},
		[input.workspaceId, draftScopeId],
	);
	useEffect(() => {
		if (!ready || hydratedScope !== mirrorKey) return;
		const persistableDraft =
			draft.referenceRelationDrafts.length || draft.relationRevocations.length || draft.createdTaskId ? draft : null;
		if (persistableDraft) localStorage.setItem(mirrorKey, JSON.stringify(persistableDraft));
		else localStorage.removeItem(mirrorKey);
		const timeout = setTimeout(() => {
			void persist(persistableDraft).then(
				() => setDraftPersistenceError(null),
				(failure: unknown) =>
					setDraftPersistenceError(
						`草稿暂未同步到运行时：${failure instanceof Error ? failure.message : String(failure)}`,
					),
			);
		}, 250);
		return () => clearTimeout(timeout);
	}, [draft, ready, mirrorKey, persist, hydratedScope]);
	useEffect(() => {
		if (!ready || hydratedScope !== mirrorKey || !input.workspaceId || input.active === false) return;
		let current = true;
		const workspaceId = input.workspaceId;
		const taskId = input.taskId ?? draft.createdTaskId;
		const timeout = setTimeout(() => {
			void readRelationModelingPreview(workspaceId, {
				workUnit: taskId
					? { workUnitSelectorKind: "kanban_board_card_by_bare_task_id", bareTaskId: taskId, workspaceId }
					: null,
				draftTaskTitle: input.draftTaskTitle ?? "待创建任务",
				relationNeighborhoodDepth: depth,
				referenceRelationDrafts: draft.referenceRelationDrafts,
				relationRevocations: draft.relationRevocations,
			}).then(
				(result) => {
					if (current) {
						setPreview(result);
						setError(null);
					}
				},
				(failure: unknown) => {
					if (current) setError(failure instanceof Error ? failure.message : String(failure));
				},
			);
		}, 150);
		return () => {
			current = false;
			clearTimeout(timeout);
		};
	}, [
		input.workspaceId,
		input.taskId,
		input.active,
		input.draftTaskTitle,
		depth,
		draft,
		ready,
		refreshSequence,
		hydratedScope,
		mirrorKey,
	]);
	const updateDraft = useCallback(
		(change: Partial<ReferenceRelationModelingEditorDraft>) => {
			const next = {
				...draftRef.current,
				...change,
				modelingSubmissionId:
					change.referenceRelationDrafts || change.relationRevocations
						? createRandomUuidV4WithInsecureContextFallback()
						: draftRef.current.modelingSubmissionId,
			};
			draftRef.current = next;
			setDraft(next);
			localStorage.setItem(mirrorKey, JSON.stringify(next));
		},
		[mirrorKey],
	);
	const addDraft = useCallback((value: ReferenceRelationModelingDraft) => {
		setDraft((previous) => ({
			...previous,
			modelingSubmissionId: createRandomUuidV4WithInsecureContextFallback(),
			referenceRelationDrafts: [
				...previous.referenceRelationDrafts.filter(
					(entry) =>
						entry.draftId !== value.draftId &&
						(!value.replacesRelationId || entry.replacesRelationId !== value.replacesRelationId),
				),
				value,
			],
			relationRevocations: previous.relationRevocations.filter(
				(entry) => entry.relationId !== value.replacesRelationId,
			),
		}));
	}, []);
	const applyToTask = async (taskId: string, characteristics: WebUiUserDecisionClientCharacteristics) => {
		if (!input.workspaceId) throw new Error("请先选择项目。");
		const isStillCurrentScope = () => currentScopeRef.current === mirrorKey;
		setDraftScopesWithApplyInFlight((previous) => new Set(previous).add(mirrorKey));
		setWriteError(null);
		try {
			const snapshot = { ...draftRef.current, ...(!input.taskId ? { createdTaskId: taskId } : {}) };
			draftRef.current = snapshot;
			setDraft(snapshot);
			localStorage.setItem(mirrorKey, JSON.stringify(snapshot));
			await persist(snapshot);
			await applyReferenceRelationModelingChangesFromExplicitUserGesture(input.workspaceId, {
				workUnit: {
					workUnitSelectorKind: "kanban_board_card_by_bare_task_id",
					bareTaskId: taskId,
					workspaceId: input.workspaceId,
				},
				modelingSubmissionId: snapshot.modelingSubmissionId,
				referenceRelationDrafts: snapshot.referenceRelationDrafts,
				relationRevocations: snapshot.relationRevocations,
				webUiUserDecisionClientCharacteristics: characteristics,
			});
			const latestDraftForSubmittedScope = isStillCurrentScope() ? draftRef.current : snapshot;
			const cleared = {
				...emptyDraft(),
				...(!input.taskId
					? {
							createdTaskId: taskId,
							createdTaskCardSnapshot: latestDraftForSubmittedScope.createdTaskCardSnapshot,
							creationPrompt: latestDraftForSubmittedScope.creationPrompt,
							creationTitle: latestDraftForSubmittedScope.creationTitle,
						}
					: {}),
				// 只清除此请求提交的条目；在途回调新增或改写的草稿继续保留。
				referenceRelationDrafts: latestDraftForSubmittedScope.referenceRelationDrafts.filter(
					(candidate) => !snapshot.referenceRelationDrafts.some((submitted) => isDeepEqual(submitted, candidate)),
				),
				relationRevocations: latestDraftForSubmittedScope.relationRevocations.filter(
					(candidate) => !snapshot.relationRevocations.some((submitted) => isDeepEqual(submitted, candidate)),
				),
				...(latestDraftForSubmittedScope.modelingSubmissionId !== snapshot.modelingSubmissionId
					? { modelingSubmissionId: latestDraftForSubmittedScope.modelingSubmissionId }
					: {}),
			};
			if (isStillCurrentScope()) {
				draftRef.current = cleared;
				setDraft(cleared);
				setRefreshSequence((value) => value + 1);
			}
			localStorage.setItem(mirrorKey, JSON.stringify(cleared));
			const hasRemainingRelationChanges =
				cleared.referenceRelationDrafts.length + cleared.relationRevocations.length > 0;
			await persist(input.taskId && !hasRemainingRelationChanges ? null : cleared);
		} catch (failure) {
			if (isStillCurrentScope()) setWriteError(failure instanceof Error ? failure.message : String(failure));
			throw failure;
		} finally {
			setDraftScopesWithApplyInFlight((previous) => {
				const remaining = new Set(previous);
				remaining.delete(mirrorKey);
				return remaining;
			});
		}
	};
	return {
		draft,
		ready: ready && hydratedScope === mirrorKey,
		preview,
		error: writeError ?? error,
		draftPersistenceError,
		saving,
		depth,
		setDepth,
		addDraft,
		updateDraft,
		applyToTask,
		readLatestDraft: () => draftRef.current,
		persistDraftNow: () => persist(draftRef.current),
		refresh: () => {
			setWriteError(null);
			setRefreshSequence((value) => value + 1);
		},
		hasChanges: draft.referenceRelationDrafts.length + draft.relationRevocations.length > 0,
		discard: () => {
			const cleared = emptyDraft();
			draftRef.current = cleared;
			setDraft(cleared);
			localStorage.removeItem(mirrorKey);
			void persist(null).catch((failure: unknown) =>
				setDraftPersistenceError(failure instanceof Error ? failure.message : String(failure)),
			);
		},
	};
}
export type ReferenceRelationModelingEditorController = ReturnType<typeof useReferenceRelationModelingEditor>;
