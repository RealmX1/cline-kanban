import type { WebUiUserDecisionClientCharacteristics } from "@runtime-work-unit-relation-assertion-write-api-contract";
import type {
	ReferenceRelationModelingDraft,
	ReferenceRelationModelingEditorDraft,
	RelationModelingPreviewResponse,
} from "@runtime-work-unit-relation-modeling-api-contract";
import { referenceRelationModelingEditorDraftSchema } from "@runtime-work-unit-relation-modeling-api-contract";
import isDeepEqual from "fast-deep-equal";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRecoverableForegroundRead } from "@/expanded-foreground-view/use-recoverable-foreground-read";
import {
	applyReferenceRelationModelingChangesFromExplicitUserGesture,
	persistRelationModelingEditorDraft,
	readRelationModelingEditorDraft,
	readRelationModelingPreview,
	requestReferenceRelationModelingSuggestions,
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
	taskIncarnationCreatedAtEpochMs?: number;
	draftTaskTitle?: string;
	draftTaskPrompt?: string;
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
	const previewRoot = preview?.workUnits.find((entry) => entry.workUnitKey === preview.rootWorkUnitKey);
	const canUseExistingDraftForQualifiedRoot =
		input.taskIncarnationCreatedAtEpochMs === undefined ||
		(previewRoot?.workUnit.workUnitType === "kanban_board_card" &&
			previewRoot.workUnit.workspaceId === input.workspaceId &&
			previewRoot.workUnit.taskId === input.taskId &&
			previewRoot.workUnit.taskIncarnationCreatedAtEpochMs === input.taskIncarnationCreatedAtEpochMs &&
			previewRoot.kanbanBoardCardIdentity?.permanentlyRemovedFromBoardAt === null);
	const [error, setError] = useState<string | null>(null);
	const [draftPersistenceError, setDraftPersistenceError] = useState<string | null>(null);
	const [draftScopesWithApplyInFlight, setDraftScopesWithApplyInFlight] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const saving = draftScopesWithApplyInFlight.has(mirrorKey);
	const [depth, setDepth] = useState<1 | 2 | 3>(2);
	const [refreshSequence, setRefreshSequence] = useState(0);
	const [suggestions, setSuggestions] = useState<Awaited<
		ReturnType<typeof requestReferenceRelationModelingSuggestions>
	> | null>(null);
	const [suggestionsLoading, setSuggestionsLoading] = useState(false);
	const [suggestionsError, setSuggestionsError] = useState<string | null>(null);
	const suggestionsRequestIdentityRef = useRef<symbol | null>(null);
	const saveTail = useRef<Promise<unknown>>(Promise.resolve());
	const draftRef = useRef(draft);
	const draftWasEditedInCurrentScope = useRef(false);
	draftRef.current = draft;
	useEffect(() => {
		suggestionsRequestIdentityRef.current = null;
		setSuggestions(null);
		setSuggestionsLoading(false);
		setSuggestionsError(null);
	}, [mirrorKey, input.draftTaskTitle, input.draftTaskPrompt]);

	useEffect(() => {
		let current = true;
		setReady(false);
		draftWasEditedInCurrentScope.current = false;
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
	}, [input.workspaceId, input.active, input.taskIncarnationCreatedAtEpochMs, draftScopeId, mirrorKey]);
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
		if (!ready || hydratedScope !== mirrorKey || !canUseExistingDraftForQualifiedRoot) return;
		const persistableDraft =
			draft.referenceRelationDrafts.length || draft.relationRevocations.length || draft.createdTaskId ? draft : null;
		if (!persistableDraft && !draftWasEditedInCurrentScope.current) return;
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
	}, [draft, ready, mirrorKey, persist, hydratedScope, canUseExistingDraftForQualifiedRoot]);
	const shouldOverlayDraftOnPreview =
		canUseExistingDraftForQualifiedRoot &&
		(draft.referenceRelationDrafts.length > 0 || draft.relationRevocations.length > 0);
	const readPreview = useCallback(
		(signal: AbortSignal) => {
			if (!input.workspaceId) return Promise.reject(new Error("缺少项目归属。"));
			const taskId = input.taskId ?? draft.createdTaskId;
			return readRelationModelingPreview(
				input.workspaceId,
				{
					workUnit: taskId
						? input.taskIncarnationCreatedAtEpochMs !== undefined
							? {
									workUnitSelectorKind: "kanban_board_card_by_qualified_reference",
									kanbanBoardCard: {
										workUnitType: "kanban_board_card",
										workspaceId: input.workspaceId,
										taskId,
										taskIncarnationCreatedAtEpochMs: input.taskIncarnationCreatedAtEpochMs,
									},
								}
							: {
									workUnitSelectorKind: "kanban_board_card_by_bare_task_id",
									bareTaskId: taskId,
									workspaceId: input.workspaceId,
								}
						: null,
					draftTaskTitle: input.draftTaskTitle ?? "待创建任务",
					relationNeighborhoodDepth: depth,
					referenceRelationDrafts: shouldOverlayDraftOnPreview ? draft.referenceRelationDrafts : [],
					relationRevocations: shouldOverlayDraftOnPreview ? draft.relationRevocations : [],
				},
				signal,
			);
		},
		[
			input.workspaceId,
			input.taskId,
			input.taskIncarnationCreatedAtEpochMs,
			input.draftTaskTitle,
			draft,
			depth,
			shouldOverlayDraftOnPreview,
		],
	);
	const previewRead = useRecoverableForegroundRead({
		identity: `${mirrorKey}:${refreshSequence}`,
		read: readPreview,
		initialReadDebounceMs: 150,
		enabled: ready && hydratedScope === mirrorKey && input.workspaceId !== null && input.active !== false,
	});
	useEffect(() => {
		if (previewRead.value) setPreview(previewRead.value);
		setError(previewRead.error);
	}, [previewRead.value, previewRead.error]);
	const updateDraft = useCallback(
		(change: Partial<ReferenceRelationModelingEditorDraft>) => {
			draftWasEditedInCurrentScope.current = true;
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
		draftWasEditedInCurrentScope.current = true;
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
				workUnit:
					input.taskIncarnationCreatedAtEpochMs !== undefined
						? {
								workUnitSelectorKind: "kanban_board_card_by_qualified_reference",
								kanbanBoardCard: {
									workUnitType: "kanban_board_card",
									workspaceId: input.workspaceId,
									taskId,
									taskIncarnationCreatedAtEpochMs: input.taskIncarnationCreatedAtEpochMs,
								},
							}
						: {
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
		suggestions,
		suggestionsLoading,
		suggestionsError,
		requestSuggestions: async () => {
			if (!input.workspaceId || suggestionsRequestIdentityRef.current) return;
			const requestIdentity = Symbol("relation-suggestion-request");
			suggestionsRequestIdentityRef.current = requestIdentity;
			setSuggestionsLoading(true);
			setSuggestionsError(null);
			setSuggestions(null);
			try {
				const taskId = input.taskId ?? draftRef.current.createdTaskId;
				const result = await requestReferenceRelationModelingSuggestions(input.workspaceId, {
					workUnit: taskId
						? {
								workUnitSelectorKind: "kanban_board_card_by_bare_task_id",
								bareTaskId: taskId,
								workspaceId: input.workspaceId,
							}
						: null,
					draftTaskTitle: input.draftTaskTitle ?? draftRef.current.creationTitle ?? "待创建任务",
					draftTaskPrompt: input.draftTaskPrompt ?? draftRef.current.creationPrompt,
					relationNeighborhoodDepth: depth,
					referenceRelationDrafts: [],
					relationRevocations: [],
				});
				if (suggestionsRequestIdentityRef.current === requestIdentity && currentScopeRef.current === mirrorKey)
					setSuggestions(result);
			} catch (failure) {
				if (suggestionsRequestIdentityRef.current === requestIdentity && currentScopeRef.current === mirrorKey)
					setSuggestionsError(failure instanceof Error ? failure.message : String(failure));
			} finally {
				if (suggestionsRequestIdentityRef.current === requestIdentity) {
					suggestionsRequestIdentityRef.current = null;
					setSuggestionsLoading(false);
				}
			}
		},
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
