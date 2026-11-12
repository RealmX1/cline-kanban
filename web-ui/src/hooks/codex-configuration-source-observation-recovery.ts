import {
	batchCodexConfigurationAction,
	fetchCodexConfigurationMutationReceipt,
	fetchCodexConfigurationSourceObservation,
	fetchCodexConfigurationSyncState,
	notifyCodexConfigurationSyncUpdated,
} from "@/runtime/codex-configuration-sync-query";
import type {
	CodexConfigurationBatchActionRequest,
	CodexConfigurationBatchActionResult,
	CodexConfigurationSourceObservation,
	CodexConfigurationSyncState,
} from "@/runtime/types";
import { LocalStorageKey, readLocalStorageItem, writeLocalStorageItem } from "@/storage/local-storage-store";

const sourceObservationRequestBudgetMs = 15_000;
const persistedSourceActionsKey = LocalStorageKey.CodexConfigurationUnconfirmedSourceObservationActions;
type SourceAction = "confirm_source" | "defer";
type SourceActionItem = CodexConfigurationBatchActionRequest["items"][number];
interface PersistedSourceAction {
	workspaceId: string | null;
	action: SourceAction;
	item: SourceActionItem;
	observationFingerprint: string;
	automaticResendCount: number;
}
export interface SourceObservationPendingAction extends PersistedSourceAction {
	phase: "sending" | "verifying" | "unknown";
}
interface WorkspaceSnapshot {
	state: CodexConfigurationSyncState | null;
	sourceOperations: Readonly<Record<string, SourceObservationPendingAction>>;
	sourceActionMessages: Readonly<Record<string, string>>;
}
export interface CodexConfigurationSourceObservationRecoveryController {
	subscribe(listener: () => void): () => void;
	getSnapshot(): WorkspaceSnapshot;
	acceptState(
		state: CodexConfigurationSyncState,
		receivedSourceActionIdempotencyKey?: string,
	): CodexConfigurationSyncState | null;
	batch(
		action: SourceAction,
		items: Array<Omit<SourceActionItem, "idempotencyKey"> & { observation?: CodexConfigurationSourceObservation }>,
	): Promise<CodexConfigurationBatchActionResult["results"]>;
	resumeUnconfirmedActions(observationId?: string): void;
	resetForRuntimeReconnect(): void;
}

// 取消底层 HTTP 之外也结束逻辑等待，避免 transport 忽略取消时 Promise 一直挂起。
export async function runCodexConfigurationSyncRequestWithinBudget<T>(
	request: (signal: AbortSignal) => Promise<T>,
	lifecycleSignal: AbortSignal,
): Promise<T> {
	lifecycleSignal.throwIfAborted();
	const controller = new AbortController();
	const abortForLifecycle = () => controller.abort(lifecycleSignal.reason);
	lifecycleSignal.addEventListener("abort", abortForLifecycle, { once: true });
	let rejectOnAbort: () => void = () => {};
	const cancelled = new Promise<never>((_resolve, reject) => {
		rejectOnAbort = () => reject(controller.signal.reason);
		controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
	});
	const timer = setTimeout(
		() => controller.abort(new Error("配置请求超过界面等待预算。")),
		sourceObservationRequestBudgetMs,
	);
	try {
		return await Promise.race([request(controller.signal), cancelled]);
	} finally {
		clearTimeout(timer);
		controller.signal.removeEventListener("abort", rejectOnAbort);
		lifecycleSignal.removeEventListener("abort", abortForLifecycle);
	}
}

function readPersistedSourceActions(): PersistedSourceAction[] {
	try {
		const records: unknown = JSON.parse(readLocalStorageItem(persistedSourceActionsKey) ?? "[]");
		if (!Array.isArray(records)) return [];
		return records.filter((candidate: unknown): candidate is PersistedSourceAction => {
			if (!candidate || typeof candidate !== "object") return false;
			const {
				workspaceId,
				action,
				item: candidateItem,
				observationFingerprint,
				automaticResendCount,
			} = candidate as Record<string, unknown>;
			if (!candidateItem || typeof candidateItem !== "object") return false;
			const item = candidateItem as Record<string, unknown>;
			return (
				(workspaceId === null || typeof workspaceId === "string") &&
				(action === "confirm_source" || action === "defer") &&
				item?.entryKind === "source_observation" &&
				typeof item.changeId === "string" &&
				typeof item.expectedVersion === "number" &&
				Number.isSafeInteger(item.expectedVersion) &&
				item.expectedVersion > 0 &&
				typeof item.idempotencyKey === "string" &&
				item.idempotencyKey.length > 0 &&
				item.idempotencyKey.length <= 200 &&
				typeof observationFingerprint === "string" &&
				(automaticResendCount === 0 || automaticResendCount === 1)
			);
		});
	} catch {
		return [];
	}
}
const observationFingerprint = (observation: CodexConfigurationSourceObservation) =>
	JSON.stringify([
		observation.observationId,
		observation.firstObservedAt,
		observation.observedAt,
		observation.observationCount,
	]);

const workspaceControllers = new Map<string, WeakRef<CodexConfigurationSourceObservationRecoveryController>>();

export function getCodexConfigurationSourceObservationRecoveryController(workspaceId: string | null) {
	const key = JSON.stringify(workspaceId);
	let controller = workspaceControllers.get(key)?.deref();
	if (!controller) {
		// 无订阅不等于无持有者：禁用的 Hook 仍可再次订阅同一实例。
		for (const [workspaceKey, reference] of workspaceControllers)
			if (!reference.deref()) workspaceControllers.delete(workspaceKey);
		controller = createCodexConfigurationSourceObservationRecoveryController(workspaceId);
		workspaceControllers.set(key, new WeakRef(controller));
	}
	return controller;
}

export function createCodexConfigurationSourceObservationRecoveryController(
	workspaceId: string | null,
): CodexConfigurationSourceObservationRecoveryController {
	let snapshot: WorkspaceSnapshot = { state: null, sourceOperations: {}, sourceActionMessages: {} };
	let lifecycle = new AbortController();
	const listeners = new Set<() => void>();
	const runningOperations = new Map<string, Promise<CodexConfigurationBatchActionResult["results"]>>();
	const emit = (patch: Partial<WorkspaceSnapshot>) => {
		snapshot = { ...snapshot, ...patch };
		for (const listener of listeners) listener();
	};
	const isCurrent = (operation: PersistedSourceAction, signal: AbortSignal) =>
		!signal.aborted &&
		snapshot.sourceOperations[operation.item.changeId]?.item.idempotencyKey === operation.item.idempotencyKey;
	const persist = (operation: PersistedSourceAction, remove = false) => {
		const records = readPersistedSourceActions().filter(
			(record) =>
				record.workspaceId !== workspaceId ||
				record.item.changeId !== operation.item.changeId ||
				(remove && record.item.idempotencyKey !== operation.item.idempotencyKey),
		);
		if (!remove) {
			const { action, item, observationFingerprint, automaticResendCount } = operation;
			records.push({ workspaceId, action, item, observationFingerprint, automaticResendCount });
		}
		return writeLocalStorageItem(persistedSourceActionsKey, JSON.stringify(records));
	};
	const finish = (operation: PersistedSourceAction, message: string, signal: AbortSignal) => {
		if (!isCurrent(operation, signal)) return;
		persist(operation, true);
		const sourceOperations = { ...snapshot.sourceOperations };
		delete sourceOperations[operation.item.changeId];
		emit({
			sourceOperations,
			sourceActionMessages: { ...snapshot.sourceActionMessages, [operation.item.changeId]: message },
		});
	};
	const individuallyReadObservations = new Map<string, CodexConfigurationSourceObservation>();
	const classify = (operation: PersistedSourceAction) => {
		if (!snapshot.state) return "unknown";
		const observation = snapshot.state.sourceObservations.find(
			(entry) => entry.observationId === operation.item.changeId,
		);
		if (!observation) {
			const individuallyRead = individuallyReadObservations.get(operation.item.changeId);
			if (!individuallyRead)
				return snapshot.state.stateResponseScope === "active" || snapshot.state.stateResponseScope === "overview"
					? "unknown"
					: "superseded";
			return classifyObservation(individuallyRead, operation);
		}
		return classifyObservation(observation, operation);
	};
	const classifyObservation = (observation: CodexConfigurationSourceObservation, operation: PersistedSourceAction) => {
		if (observationFingerprint(observation) !== operation.observationFingerprint) return "superseded";
		if (observation.version < operation.item.expectedVersion) return "unknown";
		if (observation.version === operation.item.expectedVersion) return "unchanged";
		return observation.acknowledgedAt !== null &&
			observation.reminderDisposition === (operation.action === "defer" ? "deferred" : "confirmed")
			? "observed"
			: "superseded";
	};
	const acceptState = (state: CodexConfigurationSyncState, receivedSourceActionIdempotencyKey?: string) => {
		if (
			snapshot.state?.storageIdentity &&
			state.storageIdentity &&
			state.storageIdentity !== snapshot.state.storageIdentity
		) {
			notifyCodexConfigurationSyncUpdated("runtime_reconnected");
			return null;
		}
		if (
			lifecycle.signal.aborted ||
			(snapshot.state &&
				state.storageIdentity === snapshot.state.storageIdentity &&
				(state.storageGeneration !== undefined && snapshot.state.storageGeneration !== undefined
					? state.storageGeneration < snapshot.state.storageGeneration
					: state.revision < snapshot.state.revision))
		)
			return snapshot.state;
		emit({ state });
		for (const operation of Object.values(snapshot.sourceOperations)) {
			if (operation.item.idempotencyKey === receivedSourceActionIdempotencyKey) continue;
			const status = classify(operation);
			if (status === "observed" || status === "superseded")
				finish(
					operation,
					status === "observed" ? "已通过补读核验处理状态。" : "来源或处理状态已有更新，已保留最新事实。",
					lifecycle.signal,
				);
		}
		return snapshot.state;
	};
	const setPhase = (
		operation: PersistedSourceAction,
		phase: SourceObservationPendingAction["phase"],
		signal: AbortSignal,
	) => {
		if (isCurrent(operation, signal))
			emit({
				sourceOperations: { ...snapshot.sourceOperations, [operation.item.changeId]: { ...operation, phase } },
			});
	};
	const send = async (operation: PersistedSourceAction, signal: AbortSignal) => {
		const result = await runCodexConfigurationSyncRequestWithinBudget(
			(requestSignal) =>
				batchCodexConfigurationAction(
					workspaceId,
					{ action: operation.action, items: [operation.item] },
					requestSignal,
				),
			signal,
		);
		if (signal.aborted) return [];
		const receipt = result.results.find((entry) => entry.changeId === operation.item.changeId);
		if (!acceptState(result.state, receipt ? operation.item.idempotencyKey : undefined)) return [];
		if (!receipt) throw new Error("来源处理回执缺失。");
		finish(operation, receipt.message, signal);
		return result.results;
	};
	const waitBeforeRead = (delayMs: number, signal: AbortSignal) =>
		new Promise<void>((resolve, reject) => {
			const onAbort = () => {
				clearTimeout(timer);
				reject(signal.reason);
			};
			const timer = setTimeout(() => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			}, delayMs);
			signal.addEventListener("abort", onAbort, { once: true });
		});
	const run = (operation: PersistedSourceAction, sendBeforeReading: boolean) => {
		const key = operation.item.idempotencyKey;
		const existing = runningOperations.get(key);
		if (existing) return existing;
		const signal = lifecycle.signal;
		const promise = (async () => {
			if (sendBeforeReading) {
				try {
					return await send(operation, signal);
				} catch {
					/* 未确认回执先补读，不推断写入失败。 */
				}
			}
			setPhase(operation, "verifying", signal);
			for (const delayMs of [0, 1_000, 3_000]) {
				if (!isCurrent(operation, signal)) return [];
				try {
					if (delayMs) await waitBeforeRead(delayMs, signal);
					const latest: CodexConfigurationSyncState = await runCodexConfigurationSyncRequestWithinBudget(
						(requestSignal) => fetchCodexConfigurationSyncState(workspaceId, requestSignal),
						signal,
					);
					if (signal.aborted) return [];
					individuallyReadObservations.delete(operation.item.changeId);
					if (!acceptState(latest)) return [];
					if (!isCurrent(operation, signal)) return [];
					if (
						(latest.stateResponseScope === "active" || latest.stateResponseScope === "overview") &&
						!latest.sourceObservations.some((entry) => entry.observationId === operation.item.changeId)
					) {
						const receipt = await runCodexConfigurationSyncRequestWithinBudget(
							(requestSignal) =>
								fetchCodexConfigurationMutationReceipt(
									workspaceId,
									{
										idempotencyKey: operation.item.idempotencyKey,
										expectedAction: operation.action,
										expectedEntry: operation.item,
									},
									requestSignal,
								),
							signal,
						);
						if (receipt?.changeId === operation.item.changeId) {
							finish(operation, "已通过幂等回执核验处理状态。", signal);
							return [];
						}
						const observation = await runCodexConfigurationSyncRequestWithinBudget(
							(requestSignal) =>
								fetchCodexConfigurationSourceObservation(workspaceId, operation.item.changeId, requestSignal),
							signal,
						);
						if (observation) {
							individuallyReadObservations.set(observation.observationId, observation);
							const status = classify(operation);
							if (status === "observed" || status === "superseded") {
								finish(
									operation,
									status === "observed"
										? "已通过补读核验处理状态。"
										: "来源或处理状态已有更新，已保留最新事实。",
									signal,
								);
								return [];
							}
						}
					}
					if (classify(operation) === "unchanged" && operation.automaticResendCount === 0) {
						operation = { ...operation, automaticResendCount: 1 };
						if (!persist(operation)) break;
						setPhase(operation, "verifying", signal);
						return await send(operation, signal);
					}
				} catch {
					/* 本轮读回和唯一重送都有独立预算，剩余读回继续。 */
				}
			}
			setPhase(operation, "unknown", signal);
			return [];
		})().finally(() => {
			if (runningOperations.get(key) === promise) runningOperations.delete(key);
		});
		runningOperations.set(key, promise);
		return promise;
	};
	const resumeUnconfirmedActions = (observationId?: string) => {
		for (const operation of Object.values(snapshot.sourceOperations))
			if (operation.phase === "unknown" && (!observationId || operation.item.changeId === observationId))
				void run(operation, false);
	};
	const onOnline = () => resumeUnconfirmedActions();
	const onVisible = () => {
		if (document.visibilityState === "visible") resumeUnconfirmedActions();
	};
	const subscribe = (listener: () => void) => {
		listeners.add(listener);
		if (listeners.size === 1) {
			lifecycle = new AbortController();
			const sourceOperations: Record<string, SourceObservationPendingAction> = {};
			for (const operation of readPersistedSourceActions())
				if (operation.workspaceId === workspaceId)
					sourceOperations[operation.item.changeId] = { ...operation, phase: "unknown" };
			emit({ sourceOperations });
			window.addEventListener("online", onOnline);
			document.addEventListener("visibilitychange", onVisible);
			const signal = lifecycle.signal;
			queueMicrotask(() => {
				if (!signal.aborted) resumeUnconfirmedActions();
			});
		}
		return () => {
			listeners.delete(listener);
			if (listeners.size) return;
			lifecycle.abort(new Error("配置工作区已离开，未确认请求保留待补读。"));
			runningOperations.clear();
			snapshot = { state: null, sourceOperations: {}, sourceActionMessages: {} };
			window.removeEventListener("online", onOnline);
			document.removeEventListener("visibilitychange", onVisible);
		};
	};
	const batch = async (
		action: SourceAction,
		items: Array<Omit<SourceActionItem, "idempotencyKey"> & { observation?: CodexConfigurationSourceObservation }>,
	) => {
		const results = await Promise.all(
			items.map(({ observation: suppliedObservation, ...item }) => {
				if (snapshot.sourceOperations[item.changeId]) return [];
				const observation =
					suppliedObservation ??
					snapshot.state?.sourceObservations.find(
						(entry) => entry.observationId === item.changeId && entry.version === item.expectedVersion,
					);
				if (!observation) return [];
				const operation: SourceObservationPendingAction = {
					workspaceId,
					action,
					item: { ...item, idempotencyKey: crypto.randomUUID() },
					observationFingerprint: observationFingerprint(observation),
					automaticResendCount: 0,
					phase: "sending",
				};
				if (!persist(operation)) {
					emit({
						sourceActionMessages: {
							...snapshot.sourceActionMessages,
							[item.changeId]: "浏览器无法保存恢复记录，尚未发送；请恢复本地存储后重试。",
						},
					});
					return [];
				}
				emit({
					sourceOperations: { ...snapshot.sourceOperations, [item.changeId]: operation },
					sourceActionMessages: { ...snapshot.sourceActionMessages, [item.changeId]: "" },
				});
				return run(operation, true);
			}),
		);
		return results.flat();
	};
	return {
		subscribe,
		getSnapshot: () => snapshot,
		acceptState,
		batch,
		resumeUnconfirmedActions,
		resetForRuntimeReconnect: () => {
			lifecycle.abort(new Error("连接代际已变化，原操作身份保留待补证。"));
			lifecycle = new AbortController();
			runningOperations.clear();
			individuallyReadObservations.clear();
			emit({
				state: null,
				sourceOperations: Object.fromEntries(
					Object.entries(snapshot.sourceOperations).map(([key, operation]) => [
						key,
						{ ...operation, phase: "unknown" as const },
					]),
				),
			});
		},
	};
}
