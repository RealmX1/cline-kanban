import { useCallback, useEffect, useRef, useState } from "react";
import { saveAgentRaisedPendingUserDecisionAnswerDraftToRuntime } from "@/runtime/agent-raised-pending-user-decision-answer-draft-query";
import type {
	RuntimeAgentRaisedPendingUserDecision,
	RuntimeAgentRaisedPendingUserDecisionAnswerDraft,
	RuntimePendingUserDecisionQuestionAnswerDraft,
} from "@/runtime/types";
import { LocalStorageKey, readLocalStorageItem, writeLocalStorageItem } from "@/storage/local-storage-store";
import { useInterval, useWindowEvent } from "@/utils/react-use";
import {
	runtimeAgentRaisedPendingUserDecisionAnswerDraftSchema,
	runtimePendingUserDecisionQuestionAnswerDraftSchema,
} from "../../../src/core/api-contract";

const browserAnswerDraftBackupStorageKey = LocalStorageKey.AgentRaisedPendingUserDecisionAnswerDrafts;
const pendingAnswerDraftSaveChainByDecisionIdentity = new Map<string, Promise<unknown>>();
let mostRecentlyGeneratedBrowserAnswerDraftEditVersion = 0;
type BrowserAnswerDraftBackup = Omit<RuntimeAgentRaisedPendingUserDecisionAnswerDraft, "savedAt">;
const browserAnswerDraftBackupSchema = runtimeAgentRaisedPendingUserDecisionAnswerDraftSchema.omit({ savedAt: true });

function readBrowserAnswerDraftBackups(): Record<string, BrowserAnswerDraftBackup> {
	try {
		const parsed: unknown = JSON.parse(readLocalStorageItem(browserAnswerDraftBackupStorageKey) ?? "{}");
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const validEntries: Record<string, BrowserAnswerDraftBackup> = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (Array.isArray(value)) {
				const result = runtimePendingUserDecisionQuestionAnswerDraftSchema.array().safeParse(value);
				if (result.success) validEntries[key] = { orderedQuestionAnswers: result.data, answerDraftEditVersion: 0 };
			} else {
				const result = browserAnswerDraftBackupSchema.safeParse(value);
				if (result.success) validEntries[key] = result.data;
			}
		}
		return validEntries;
	} catch {
		return {};
	}
}

function buildPendingUserDecisionAnswerDraftIdentity(
	workspaceId: string | null,
	taskId: string,
	decisionId: string,
): string {
	return JSON.stringify([workspaceId, taskId, decisionId]);
}

function restoreOrderedQuestionAnswerDrafts(
	decision: RuntimeAgentRaisedPendingUserDecision,
	restoredAnswers: RuntimePendingUserDecisionQuestionAnswerDraft[],
): RuntimePendingUserDecisionQuestionAnswerDraft[] {
	return decision.orderedQuestions.map(
		(question) =>
			restoredAnswers.find((answer) => answer.decisionQuestionId === question.decisionQuestionId) ?? {
				decisionQuestionId: question.decisionQuestionId,
				selectedOptionIds: [],
				freeformText: "",
			},
	);
}

// 仅删除这项任务已经了结 / 被替代的问题备份，不能碰其它项目的同号任务。
export function discardBrowserAnswerDraftsForTaskExceptPendingDecision(
	workspaceId: string,
	taskId: string,
	pendingDecisionId: string | null,
): void {
	const browserAnswerDraftBackups = readBrowserAnswerDraftBackups();
	for (const key of Object.keys(browserAnswerDraftBackups)) {
		try {
			const [savedWorkspaceId, savedTaskId, savedDecisionId] = JSON.parse(key);
			if (savedWorkspaceId === workspaceId && savedTaskId === taskId && savedDecisionId !== pendingDecisionId)
				delete browserAnswerDraftBackups[key];
		} catch {
			/* 损坏身份不是当前任务的草稿。 */
		}
	}
	writeLocalStorageItem(browserAnswerDraftBackupStorageKey, JSON.stringify(browserAnswerDraftBackups));
}

// 身份变化由调用方的 key 重挂载；查询刷新只更新尚未被用户编辑的初值。
export function useAgentRaisedPendingUserDecisionAnswerDraft({
	workspaceId,
	decision,
	onDecisionNoLongerPending,
}: {
	workspaceId: string | null;
	decision: RuntimeAgentRaisedPendingUserDecision;
	onDecisionNoLongerPending?: () => void;
}) {
	const identity = buildPendingUserDecisionAnswerDraftIdentity(workspaceId, decision.taskId, decision.decisionId);
	const [restoredBrowserAnswerDraftBackup] = useState(() => {
		const browserAnswerDraftBackup = readBrowserAnswerDraftBackups()[identity];
		return browserAnswerDraftBackup &&
			(browserAnswerDraftBackup.answerDraftEditVersion ?? 0) >
				(decision.pendingAnswerDraft?.answerDraftEditVersion ?? -1)
			? browserAnswerDraftBackup
			: undefined;
	});
	const [questionAnswerDrafts, setQuestionAnswerDrafts] = useState(() => {
		const restoredOrderedQuestionAnswers =
			restoredBrowserAnswerDraftBackup?.orderedQuestionAnswers ??
			decision.pendingAnswerDraft?.orderedQuestionAnswers ??
			[];
		return restoreOrderedQuestionAnswerDrafts(decision, restoredOrderedQuestionAnswers);
	});
	const latestAnswersRef = useRef(questionAnswerDrafts);
	const hasUnsavedDraftRef = useRef(Boolean(restoredBrowserAnswerDraftBackup));
	const hasUserEditedDraftRef = useRef(hasUnsavedDraftRef.current);
	const isDecisionClosedRef = useRef(decision.recordedAnswerQuestionAnswers !== null);
	const isMountedRef = useRef(true);
	const answerDraftEditVersionRef = useRef(
		restoredBrowserAnswerDraftBackup?.answerDraftEditVersion ??
			decision.pendingAnswerDraft?.answerDraftEditVersion ??
			0,
	);
	const didBrowserAnswerDraftBackupSucceedRef = useRef(true);
	const onDecisionNoLongerPendingRef = useRef(onDecisionNoLongerPending);
	onDecisionNoLongerPendingRef.current = onDecisionNoLongerPending;
	const [saveStatus, setSaveStatus] = useState<"unchanged" | "saving" | "saved" | "failed">(
		hasUnsavedDraftRef.current ? "saving" : decision.pendingAnswerDraft ? "saved" : "unchanged",
	);

	const discardAnswerDraft = useCallback(() => {
		isDecisionClosedRef.current = true;
		hasUnsavedDraftRef.current = false;
		const browserAnswerDraftBackups = readBrowserAnswerDraftBackups();
		delete browserAnswerDraftBackups[identity];
		writeLocalStorageItem(browserAnswerDraftBackupStorageKey, JSON.stringify(browserAnswerDraftBackups));
	}, [identity]);

	const flushAnswerDraft = useCallback(() => {
		if (!workspaceId || !hasUnsavedDraftRef.current || isDecisionClosedRef.current) return;
		const orderedQuestionAnswersForSave = latestAnswersRef.current;
		const capturedAnswerDraftEditVersion = answerDraftEditVersionRef.current;
		const previousPendingSave = pendingAnswerDraftSaveChainByDecisionIdentity.get(identity) ?? Promise.resolve();
		const currentPendingSave = previousPendingSave
			.catch(() => undefined)
			.then(async () => {
				if (isDecisionClosedRef.current || !hasUnsavedDraftRef.current) return;
				try {
					const response = await saveAgentRaisedPendingUserDecisionAnswerDraftToRuntime(workspaceId, {
						taskId: decision.taskId,
						decisionId: decision.decisionId,
						orderedQuestionAnswers: orderedQuestionAnswersForSave,
						answerDraftEditVersion: capturedAnswerDraftEditVersion,
					});
					if (response.decisionIsNoLongerPending) {
						discardAnswerDraft();
						if (isMountedRef.current) onDecisionNoLongerPendingRef.current?.();
						return;
					}
					if (!response.ok) throw new Error(response.error ?? "草稿保存失败");
					if (isDecisionClosedRef.current) return;
					if (answerDraftEditVersionRef.current === capturedAnswerDraftEditVersion) {
						const confirmedAnswerDraftEditVersion =
							response.pendingAnswerDraft?.answerDraftEditVersion ?? capturedAnswerDraftEditVersion;
						// 清理与保存状态使用同一编辑版本；写入失败遗留的旧备份也属于已确认内容的历史。
						const browserAnswerDraftBackups = readBrowserAnswerDraftBackups();
						if (
							(browserAnswerDraftBackups[identity]?.answerDraftEditVersion ?? 0) <=
							confirmedAnswerDraftEditVersion
						) {
							delete browserAnswerDraftBackups[identity];
							writeLocalStorageItem(
								browserAnswerDraftBackupStorageKey,
								JSON.stringify(browserAnswerDraftBackups),
							);
						}
						// 服务端可能已保留更晚版本；回显实际确认的内容，不能替未落盘的请求宣称已保存。
						if (response.pendingAnswerDraft) {
							latestAnswersRef.current = restoreOrderedQuestionAnswerDrafts(
								decision,
								response.pendingAnswerDraft.orderedQuestionAnswers,
							);
							answerDraftEditVersionRef.current = confirmedAnswerDraftEditVersion;
							if (isMountedRef.current) setQuestionAnswerDrafts(latestAnswersRef.current);
						}
						hasUnsavedDraftRef.current = false;
						if (isMountedRef.current) setSaveStatus("saved");
					}
				} catch {
					if (
						isMountedRef.current &&
						!isDecisionClosedRef.current &&
						answerDraftEditVersionRef.current === capturedAnswerDraftEditVersion
					)
						setSaveStatus("failed");
				}
			});
		pendingAnswerDraftSaveChainByDecisionIdentity.set(identity, currentPendingSave);
		void currentPendingSave.finally(() => {
			if (pendingAnswerDraftSaveChainByDecisionIdentity.get(identity) === currentPendingSave)
				pendingAnswerDraftSaveChainByDecisionIdentity.delete(identity);
		});
	}, [workspaceId, identity, decision.taskId, decision.decisionId, discardAnswerDraft]);

	const updateQuestionAnswerDraft = (
		decisionQuestionId: string,
		questionAnswerDraftPatch: Partial<
			Pick<RuntimePendingUserDecisionQuestionAnswerDraft, "selectedOptionIds" | "freeformText">
		>,
	) => {
		if (isDecisionClosedRef.current) return;
		const nextOrderedQuestionAnswerDrafts = latestAnswersRef.current.map((answer) =>
			answer.decisionQuestionId === decisionQuestionId ? { ...answer, ...questionAnswerDraftPatch } : answer,
		);
		latestAnswersRef.current = nextOrderedQuestionAnswerDrafts;
		hasUnsavedDraftRef.current = true;
		hasUserEditedDraftRef.current = true;
		answerDraftEditVersionRef.current = Math.max(
			Date.now(),
			answerDraftEditVersionRef.current + 1,
			mostRecentlyGeneratedBrowserAnswerDraftEditVersion + 1,
		);
		mostRecentlyGeneratedBrowserAnswerDraftEditVersion = answerDraftEditVersionRef.current;
		didBrowserAnswerDraftBackupSucceedRef.current = writeLocalStorageItem(
			browserAnswerDraftBackupStorageKey,
			JSON.stringify({
				...readBrowserAnswerDraftBackups(),
				[identity]: {
					orderedQuestionAnswers: nextOrderedQuestionAnswerDrafts,
					answerDraftEditVersion: answerDraftEditVersionRef.current,
				},
			}),
		);
		setQuestionAnswerDrafts(nextOrderedQuestionAnswerDrafts);
		setSaveStatus("saving");
	};

	useEffect(() => {
		if (decision.recordedAnswerQuestionAnswers !== null) {
			discardAnswerDraft();
		} else if (!hasUserEditedDraftRef.current && decision.pendingAnswerDraft) {
			latestAnswersRef.current = restoreOrderedQuestionAnswerDrafts(
				decision,
				decision.pendingAnswerDraft.orderedQuestionAnswers,
			);
			setQuestionAnswerDrafts(latestAnswersRef.current);
			answerDraftEditVersionRef.current =
				decision.pendingAnswerDraft.answerDraftEditVersion ?? answerDraftEditVersionRef.current;
			setSaveStatus("saved");
		}
	}, [decision, discardAnswerDraft]);

	useEffect(() => {
		const timer = setTimeout(flushAnswerDraft, 400);
		return () => clearTimeout(timer);
	}, [flushAnswerDraft, questionAnswerDrafts]);
	useEffect(() => {
		isMountedRef.current = true;
		return () => {
			isMountedRef.current = false;
			flushAnswerDraft();
		};
	}, [flushAnswerDraft]);
	useWindowEvent("online", flushAnswerDraft);
	useInterval(flushAnswerDraft, saveStatus === "failed" ? 5000 : null);

	return {
		questionAnswerDrafts,
		updateQuestionAnswerDraft,
		discardAnswerDraft,
		draftSaveStatusText:
			saveStatus === "unchanged"
				? null
				: saveStatus === "saved"
					? "已保存"
					: saveStatus === "saving"
						? "保存中"
						: didBrowserAnswerDraftBackupSucceedRef.current
							? "保存失败，已保留本地草稿"
							: "保存失败，本地备份也未成功",
	};
}
