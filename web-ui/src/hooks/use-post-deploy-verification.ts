import { type Dispatch, type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { countPostDeployVerificationTasksAwaitingVerification } from "@/components/post-deploy-verification/post-deploy-verification-active-deployment-group-tasks-grouped-by-deployment-attribution-zone";
import { useDocumentVisibility } from "@/hooks/use-document-visibility";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeConfirmVerificationCompleteRequest,
	RuntimeConfirmVerificationCompleteResponse,
	RuntimePostDeployVerificationDeploymentGroup,
	RuntimePostDeployVerificationTask,
	RuntimeRequestVerificationCompleteRequest,
	RuntimeRequestVerificationCompleteResponse,
} from "@/runtime/types";
import { LocalStorageKey } from "@/storage/local-storage-store";
import { useBooleanLocalStorageValue, useInterval } from "@/utils/react-use";

// MVP 无 WebSocket：30s 心跳轮询 + tab focus 时 immediate refresh（plan 数据流）。
const POST_DEPLOY_VERIFICATION_POLL_INTERVAL_MS = 30_000;

export interface PostDeployVerificationEntryNavigationReadModelRequest {
	workspaceId: string;
	requestId: number;
}

export interface UsePostDeployVerificationResult {
	// active 组 = 该 workspace 中 activeDeploymentId 指向的组（foldedAtIso === null 的最新组）；无则 null。
	activeGroup: RuntimePostDeployVerificationDeploymentGroup | null;
	// 折叠历史组，按 deploy 时间倒序（plan 面板三区之二）。
	historyGroups: RuntimePostDeployVerificationDeploymentGroup[];
	activeDeploymentId: string | null;
	loadError: string | null;
	// 首次成功加载前为 false——用于避免面板在数据到达前闪现空态。
	hasLoadedOnce: boolean;
	// 未加载或无部署记录时为 null；只有历史记录时为 0，保留顶栏唯一入口。
	pendingVerificationTaskCount: number | null;
	refresh: () => void;
	// 结案前等待权威快照；有在途写入或项目已变化时拒绝，不能把过期快照当成通过。
	refreshAndReadActiveGroup: (
		entryNavigationRequest?: PostDeployVerificationEntryNavigationReadModelRequest,
	) => Promise<RuntimePostDeployVerificationDeploymentGroup | null>;
	// 只有通过项目、读取顺序与本地写入守卫的快照，才可证明对应定位目标存在或缺失。
	entryNavigationReadModelRequest: PostDeployVerificationEntryNavigationReadModelRequest | null;
	isVerificationWriteInFlight: boolean;
	// 「保持最前」偏好（默认 true，见 plan 面板行为表）。
	stayInFront: boolean;
	setStayInFront: Dispatch<SetStateAction<boolean>>;
	// 面板隐藏偏好，隐藏后通过顶栏唯一入口展开。
	collapsed: boolean;
	setCollapsed: Dispatch<SetStateAction<boolean>>;
	toggleChecklistItem: (deploymentId: string, taskId: string, itemId: string, checked: boolean) => Promise<void>;
	addCustomChecklistItem: (deploymentId: string, taskId: string, label: string) => Promise<void>;
	removeCustomChecklistItem: (deploymentId: string, taskId: string, itemId: string) => Promise<void>;
	// 运行一个自动脚本型验证项：乐观置 running，mutation 阻塞到脚本完成后以返回的 task 替换（含 run 结果 + 自动勾选）。
	runVerificationItem: (deploymentId: string, taskId: string, itemId: string) => Promise<void>;
	// 完成流的两个 tRPC 步骤：orchestration（弹窗 + 移列时序）在 controller，本 hook 只暴露原子调用。
	requestComplete: (
		input: RuntimeRequestVerificationCompleteRequest,
	) => Promise<RuntimeRequestVerificationCompleteResponse | null>;
	confirmComplete: (
		input: RuntimeConfirmVerificationCompleteRequest,
	) => Promise<RuntimeConfirmVerificationCompleteResponse | null>;
}

// ---- 纯函数：本地乐观更新 deploymentGroups（不改后端，供勾选/替换任务用） ----

function replaceTaskInGroups(
	groups: RuntimePostDeployVerificationDeploymentGroup[],
	deploymentId: string,
	nextTask: RuntimePostDeployVerificationTask,
): RuntimePostDeployVerificationDeploymentGroup[] {
	return groups.map((group) => {
		if (group.deploymentId !== deploymentId) {
			return group;
		}
		return {
			...group,
			tasks: group.tasks.map((task) => (task.taskId === nextTask.taskId ? nextTask : task)),
		};
	});
}

function patchChecklistCheckedInGroups(
	groups: RuntimePostDeployVerificationDeploymentGroup[],
	deploymentId: string,
	taskId: string,
	itemId: string,
	checked: boolean,
): RuntimePostDeployVerificationDeploymentGroup[] {
	return groups.map((group) => {
		if (group.deploymentId !== deploymentId) {
			return group;
		}
		return {
			...group,
			tasks: group.tasks.map((task) => {
				if (task.taskId !== taskId) {
					return task;
				}
				return {
					...task,
					checklist: task.checklist.map((item) => (item.id === itemId ? { ...item, checked } : item)),
				};
			}),
		};
	});
}

// 乐观把某自动脚本项置 running（脚本运行期间按钮转圈）；mutation 返回后由 replaceTaskInGroups 覆盖真实结果。
function patchItemRunningInGroups(
	groups: RuntimePostDeployVerificationDeploymentGroup[],
	deploymentId: string,
	taskId: string,
	itemId: string,
): RuntimePostDeployVerificationDeploymentGroup[] {
	return groups.map((group) => {
		if (group.deploymentId !== deploymentId) {
			return group;
		}
		return {
			...group,
			tasks: group.tasks.map((task) => {
				if (task.taskId !== taskId) {
					return task;
				}
				return {
					...task,
					checklist: task.checklist.map((item) =>
						item.id === itemId
							? {
									...item,
									run: {
										status: "running" as const,
										exitCode: null,
										startedAtIso: item.run?.startedAtIso ?? null,
										finishedAtIso: null,
										outputExcerpt: item.run?.outputExcerpt ?? "",
									},
								}
							: item,
					),
				};
			}),
		};
	});
}

function resolveErrorMessage(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}

export function usePostDeployVerification(
	workspaceId: string | null,
	{
		pollingEnabled = true,
		showDeploymentNotifications = true,
	}: {
		pollingEnabled?: boolean;
		showDeploymentNotifications?: boolean;
	} = {},
): UsePostDeployVerificationResult {
	const isDocumentVisible = useDocumentVisibility();
	const [deploymentGroups, setDeploymentGroups] = useState<RuntimePostDeployVerificationDeploymentGroup[]>([]);
	const [activeDeploymentId, setActiveDeploymentId] = useState<string | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
	const [workspaceIdOfLoadedReadModel, setWorkspaceIdOfLoadedReadModel] = useState<string | null>(null);
	const [stayInFront, setStayInFront] = useBooleanLocalStorageValue(
		LocalStorageKey.PostDeployVerificationStayInFront,
		true,
	);
	const [collapsed, setCollapsed] = useBooleanLocalStorageValue(
		LocalStorageKey.PostDeployVerificationCollapsed,
		false,
	);

	const [entryNavigationReadModelRequest, setEntryNavigationReadModelRequest] =
		useState<PostDeployVerificationEntryNavigationReadModelRequest | null>(null);
	const pendingEntryNavigationReadModelRequestRef =
		useRef<PostDeployVerificationEntryNavigationReadModelRequest | null>(null);
	const nextReadRequestSequenceRef = useRef(0);
	const lastAppliedReadRequestSequenceRef = useRef(0);
	const isMountedRef = useRef(true);
	// 守护过期响应：workspace 切换后旧请求返回不得覆盖新 workspace 数据。
	const requestWorkspaceIdRef = useRef<string | null>(workspaceId);
	// 新 deploy 检测以 activeDeploymentId 变化为准（勿比对 SHA，同 commit 重部署 SHA 不变）。
	// undefined = 尚未首次加载（首帧不 toast）；null/string = 已知的上一次 active 组。
	const previousActiveDeploymentIdRef = useRef<string | null | undefined>(undefined);
	const wasDocumentVisibleRef = useRef(isDocumentVisible);

	// 过期轮询覆盖（stale-poll clobber）守卫：
	// 验证状态无 WebSocket 推送，refresh() 每拍做整表覆盖 setDeploymentGroups(...)；
	// 若某次轮询的服务端快照在用户点击前算出、却在乐观写入之后才返回，就会用点击前数据覆盖掉乐观值（勾选「弹回」）。
	// 以下两个 ref 界定每次本地验证写入的「在飞窗口」，供 refresh() 判定轮询快照是否可能早于本地写入而应丢弃。
	const [isVerificationWriteInFlight, setIsVerificationWriteInFlight] = useState(false);
	const inFlightVerificationWriteCountRef = useRef(0); // 当前在飞的验证写入 mutation 数。
	const verificationWriteCompletionSeqRef = useRef(0); // 每当一个验证写入 settle（成功/失败/回滚）自增，作为单调完成序号。
	// 写入追踪的 workspace 代际（generation）：把上面两个「在飞写入」ref 按 workspace 隔离。
	// 本 hook 是 App.tsx 持有的唯一实例，workspaceId 仅作参数变化、hook 不随 workspace remount，故这两个 ref 跨 workspace 切换持续存活。
	// 若不隔离：workspace A 的长时写入（尤其 runVerificationItem，await 到服务端脚本完成，可数秒至数十秒）在飞时切到 workspace B，
	// B 的首帧 refresh 会被「A 的写入仍在飞」误命中 refresh() 过期守卫而丢弃 → B 面板保持空白/loading。
	// 每次 workspace 切换自增此代际；trackVerificationWrite 进入时捕获当前代际，仅当 settle 时代际未变才回收 count / 推进 seq。
	const verificationWriteWorkspaceGenerationRef = useRef(0);

	useEffect(() => {
		isMountedRef.current = true;
		return () => {
			isMountedRef.current = false;
		};
	}, []);

	// 追踪一次验证写入的「在飞窗口」，供 refresh() 判定轮询快照是否可能早于本地写入。
	// 调用即同步执行到第一个 await 前，故 inFlightVerificationWriteCountRef 的自增发生在返回 promise 之前——
	// 只要在乐观 setDeploymentGroups 之后、同一同步 tick 内调用（二者间无 await），写入窗口就完整覆盖乐观更新。
	const trackVerificationWrite = useCallback(
		async <ResultType>(runMutation: () => Promise<ResultType>): Promise<ResultType> => {
			// 进入时捕获当前 workspace 代际：仅当 settle 时代际未变（仍属同一 workspace）才回收 count / 推进 seq。
			// 否则（写入在飞期间发生过 workspace 切换）跳过：旧 workspace 的写入 settle 既不能把已被切换归零的 count 减成负值，
			// 也不能推进 seq —— 后者会误使新 workspace 那次以切换后 seq 为基线发起的 refresh 命中「seq 已变」而丢弃其合法首帧快照。
			const writeWorkspaceGenerationAtLaunch = verificationWriteWorkspaceGenerationRef.current;
			inFlightVerificationWriteCountRef.current += 1;
			setIsVerificationWriteInFlight(true);
			try {
				return await runMutation();
			} finally {
				if (verificationWriteWorkspaceGenerationRef.current === writeWorkspaceGenerationAtLaunch) {
					inFlightVerificationWriteCountRef.current -= 1;
					verificationWriteCompletionSeqRef.current += 1;
					if (isMountedRef.current) setIsVerificationWriteInFlight(inFlightVerificationWriteCountRef.current > 0);
				}
			}
		},
		[],
	);

	const refreshAndReadActiveGroup = useCallback(
		async (entryNavigationRequest?: PostDeployVerificationEntryNavigationReadModelRequest) => {
			if (!workspaceId) throw new Error("未选择核对项目");
			if (entryNavigationRequest && entryNavigationRequest.workspaceId !== workspaceId) {
				throw new Error("定位项目与核对项目不一致，请等待项目切换完成");
			}
			if (entryNavigationRequest) pendingEntryNavigationReadModelRequestRef.current = entryNavigationRequest;
			const navigationRequestAtLaunch = pendingEntryNavigationReadModelRequestRef.current;
			const readRequestSequence = ++nextReadRequestSequenceRef.current;
			const workspaceGenerationAtLaunch = verificationWriteWorkspaceGenerationRef.current;
			const requestWorkspaceId = workspaceId;
			const writeCompletionSeqAtRefreshLaunch = verificationWriteCompletionSeqRef.current;
			try {
				if (inFlightVerificationWriteCountRef.current > 0) throw new Error("核对结果仍在保存或运行，请稍后继续");
				const response = await getRuntimeTrpcClient(
					requestWorkspaceId,
				).deployment.getPostDeployVerificationState.query({});
				if (
					!isMountedRef.current ||
					requestWorkspaceIdRef.current !== requestWorkspaceId ||
					verificationWriteWorkspaceGenerationRef.current !== workspaceGenerationAtLaunch
				) {
					throw new Error("核对项目已变化，请重新操作");
				}
				if (
					inFlightVerificationWriteCountRef.current > 0 ||
					verificationWriteCompletionSeqRef.current !== writeCompletionSeqAtRefreshLaunch
				) {
					throw new Error("核对状态正在更新，请稍后继续");
				}
				if (readRequestSequence < lastAppliedReadRequestSequenceRef.current) {
					throw new Error("已有更新的核对快照，已忽略迟到响应");
				}
				lastAppliedReadRequestSequenceRef.current = readRequestSequence;
				setEntryNavigationReadModelRequest(
					navigationRequestAtLaunch === pendingEntryNavigationReadModelRequestRef.current
						? navigationRequestAtLaunch
						: null,
				);
				setDeploymentGroups(response.deploymentGroups);
				setActiveDeploymentId(response.activeDeploymentId);
				setLoadError(null);
				setHasLoadedOnce(true);
				setWorkspaceIdOfLoadedReadModel(requestWorkspaceId);
				const previousActiveDeploymentId = previousActiveDeploymentIdRef.current;
				previousActiveDeploymentIdRef.current = response.activeDeploymentId;
				if (
					showDeploymentNotifications &&
					previousActiveDeploymentId !== undefined &&
					response.activeDeploymentId !== null &&
					response.activeDeploymentId !== previousActiveDeploymentId
				) {
					showAppToast({ intent: "primary", message: "检测到新部署 · 请核对 Post-Deploy Verification" });
					setCollapsed(false);
				}
				return (
					response.deploymentGroups.find(
						(group) =>
							group.deploymentId === response.activeDeploymentId && group.workspaceId === requestWorkspaceId,
					) ?? null
				);
			} catch (error) {
				if (
					isMountedRef.current &&
					requestWorkspaceIdRef.current === requestWorkspaceId &&
					verificationWriteWorkspaceGenerationRef.current === workspaceGenerationAtLaunch &&
					readRequestSequence >= lastAppliedReadRequestSequenceRef.current &&
					inFlightVerificationWriteCountRef.current === 0 &&
					verificationWriteCompletionSeqRef.current === writeCompletionSeqAtRefreshLaunch
				) {
					setLoadError(resolveErrorMessage(error, "加载 Post-Deploy Verification 状态失败"));
				}
				throw error;
			}
		},
		[workspaceId, setCollapsed, showDeploymentNotifications],
	);

	const refresh = useCallback(() => {
		if (!workspaceId) {
			setDeploymentGroups([]);
			setActiveDeploymentId(null);
			return;
		}
		void refreshAndReadActiveGroup().catch(() => {});
	}, [workspaceId, refreshAndReadActiveGroup]);

	// workspace 切换：重置检测基线与数据，立即拉取新 workspace 状态。
	useEffect(() => {
		requestWorkspaceIdRef.current = workspaceId;
		// 自增写入代际并把在飞计数归零：使旧 workspace 尚未 settle 的写入不再影响新 workspace 的过期轮询守卫
		// （旧写入的 settle 会因代际不符而在 trackVerificationWrite 的 finally 里被跳过，不再回收 count / 推进 seq）。
		verificationWriteWorkspaceGenerationRef.current += 1;
		inFlightVerificationWriteCountRef.current = 0;
		setIsVerificationWriteInFlight(false);
		previousActiveDeploymentIdRef.current = undefined;
		pendingEntryNavigationReadModelRequestRef.current = null;
		setEntryNavigationReadModelRequest(null);
		setHasLoadedOnce(false);
		setWorkspaceIdOfLoadedReadModel(null);
		setDeploymentGroups([]);
		setActiveDeploymentId(null);
		setLoadError(null);
		refresh();
	}, [workspaceId, refresh]);

	// 30s 心跳；tab 隐藏或无 workspace 时停表（省流并避免后台无谓请求）。
	useInterval(
		() => {
			if (!workspaceId || !isDocumentVisible) {
				return;
			}
			refresh();
		},
		pollingEnabled && workspaceId && isDocumentVisible ? POST_DEPLOY_VERIFICATION_POLL_INTERVAL_MS : null,
	);

	// tab 由隐藏转可见的边沿：立即刷新一次（focus immediate，见 plan 数据流）。
	useEffect(() => {
		if (pollingEnabled && isDocumentVisible && !wasDocumentVisibleRef.current && workspaceId) {
			refresh();
		}
		wasDocumentVisibleRef.current = isDocumentVisible;
	}, [isDocumentVisible, workspaceId, refresh, pollingEnabled]);

	const activeGroup = useMemo(
		() => deploymentGroups.find((group) => group.deploymentId === activeDeploymentId) ?? null,
		[deploymentGroups, activeDeploymentId],
	);

	const historyGroups = useMemo(
		() =>
			deploymentGroups
				.filter((group) => group.deploymentId !== activeDeploymentId)
				.sort((left, right) => Date.parse(right.deployedAtIso) - Date.parse(left.deployedAtIso)),
		[deploymentGroups, activeDeploymentId],
	);
	// 待核对 = 未结案（全勾通过或带原因结案都算结案）、未移除、不是「记录部署时已在 Done」的只读展示项。
	const pendingVerificationTaskCount =
		hasLoadedOnce && deploymentGroups.length > 0
			? activeGroup
				? countPostDeployVerificationTasksAwaitingVerification(activeGroup.tasks)
				: 0
			: null;

	const toggleChecklistItem = useCallback(
		async (deploymentId: string, taskId: string, itemId: string, checked: boolean): Promise<void> => {
			if (!workspaceId) {
				return;
			}
			// 乐观更新：先本地翻转，失败回滚，30s 轮询兜底对账。
			setDeploymentGroups((groups) => patchChecklistCheckedInGroups(groups, deploymentId, taskId, itemId, checked));
			try {
				const response = await trackVerificationWrite(() =>
					getRuntimeTrpcClient(workspaceId).deployment.updateVerificationChecklist.mutate({
						operation: "toggle_checklist_item",
						deploymentId,
						taskId,
						itemId,
						checked,
					}),
				);
				if (!isMountedRef.current) {
					return;
				}
				if (!response.ok) {
					setDeploymentGroups((groups) =>
						patchChecklistCheckedInGroups(groups, deploymentId, taskId, itemId, !checked),
					);
					showAppToast({ intent: "danger", message: response.error ?? "更新核对项失败" });
					return;
				}
				const nextTask = response.task;
				if (nextTask) {
					setDeploymentGroups((groups) => replaceTaskInGroups(groups, deploymentId, nextTask));
				}
			} catch (error) {
				if (!isMountedRef.current) {
					return;
				}
				setDeploymentGroups((groups) =>
					patchChecklistCheckedInGroups(groups, deploymentId, taskId, itemId, !checked),
				);
				showAppToast({ intent: "danger", message: resolveErrorMessage(error, "更新核对项失败") });
			}
		},
		[workspaceId, trackVerificationWrite],
	);

	const addCustomChecklistItem = useCallback(
		async (deploymentId: string, taskId: string, label: string): Promise<void> => {
			const trimmedLabel = label.trim();
			if (!workspaceId || !trimmedLabel) {
				return;
			}
			// 自定义项 id 由后端生成，无法乐观构造——直接以返回的 task 替换本地。
			try {
				const response = await trackVerificationWrite(() =>
					getRuntimeTrpcClient(workspaceId).deployment.updateVerificationChecklist.mutate({
						operation: "add_custom_checklist_item",
						deploymentId,
						taskId,
						label: trimmedLabel,
					}),
				);
				if (!isMountedRef.current) {
					return;
				}
				if (!response.ok) {
					showAppToast({ intent: "danger", message: response.error ?? "添加自定义核对项失败" });
					return;
				}
				const nextTask = response.task;
				if (nextTask) {
					setDeploymentGroups((groups) => replaceTaskInGroups(groups, deploymentId, nextTask));
				}
			} catch (error) {
				if (!isMountedRef.current) {
					return;
				}
				showAppToast({ intent: "danger", message: resolveErrorMessage(error, "添加自定义核对项失败") });
			}
		},
		[workspaceId, trackVerificationWrite],
	);

	const removeCustomChecklistItem = useCallback(
		async (deploymentId: string, taskId: string, itemId: string): Promise<void> => {
			if (!workspaceId) {
				return;
			}
			try {
				const response = await trackVerificationWrite(() =>
					getRuntimeTrpcClient(workspaceId).deployment.updateVerificationChecklist.mutate({
						operation: "remove_custom_checklist_item",
						deploymentId,
						taskId,
						itemId,
					}),
				);
				if (!isMountedRef.current) {
					return;
				}
				if (!response.ok) {
					showAppToast({ intent: "danger", message: response.error ?? "移除自定义核对项失败" });
					return;
				}
				const nextTask = response.task;
				if (nextTask) {
					setDeploymentGroups((groups) => replaceTaskInGroups(groups, deploymentId, nextTask));
				}
			} catch (error) {
				if (!isMountedRef.current) {
					return;
				}
				showAppToast({ intent: "danger", message: resolveErrorMessage(error, "移除自定义核对项失败") });
			}
		},
		[workspaceId, trackVerificationWrite],
	);

	const runVerificationItem = useCallback(
		async (deploymentId: string, taskId: string, itemId: string): Promise<void> => {
			if (!workspaceId) {
				return;
			}
			// 乐观置 running（按钮转圈）；mutation 阻塞到脚本完成。
			setDeploymentGroups((groups) => patchItemRunningInGroups(groups, deploymentId, taskId, itemId));
			try {
				const response = await trackVerificationWrite(() =>
					getRuntimeTrpcClient(workspaceId).deployment.runPostDeployVerificationItem.mutate({
						deploymentId,
						taskId,
						itemId,
					}),
				);
				if (!isMountedRef.current) {
					return;
				}
				if (!response.ok) {
					showAppToast({ intent: "danger", message: response.error ?? "运行验证脚本失败" });
				}
				const nextTask = response.task;
				if (nextTask) {
					setDeploymentGroups((groups) => replaceTaskInGroups(groups, deploymentId, nextTask));
				} else {
					// server 未返回 task（异常）：重新拉取真实状态对账。
					refresh();
				}
			} catch (error) {
				if (!isMountedRef.current) {
					return;
				}
				showAppToast({ intent: "danger", message: resolveErrorMessage(error, "运行验证脚本失败") });
				// 断线/超时：脚本可能已在 server 端写结果，刷新对账真实 run 状态。
				refresh();
			}
		},
		[workspaceId, refresh, trackVerificationWrite],
	);

	const requestComplete = useCallback(
		async (
			input: RuntimeRequestVerificationCompleteRequest,
		): Promise<RuntimeRequestVerificationCompleteResponse | null> => {
			if (!workspaceId) {
				return null;
			}
			try {
				return await trackVerificationWrite(() =>
					getRuntimeTrpcClient(workspaceId).deployment.requestVerificationComplete.mutate(input),
				);
			} catch (error) {
				showAppToast({ intent: "danger", message: resolveErrorMessage(error, "请求完成核对失败") });
				return null;
			}
		},
		[workspaceId, trackVerificationWrite],
	);

	const confirmComplete = useCallback(
		async (
			input: RuntimeConfirmVerificationCompleteRequest,
		): Promise<RuntimeConfirmVerificationCompleteResponse | null> => {
			if (!workspaceId) {
				return null;
			}
			try {
				return await trackVerificationWrite(() =>
					getRuntimeTrpcClient(workspaceId).deployment.confirmVerificationComplete.mutate(input),
				);
			} catch (error) {
				showAppToast({ intent: "danger", message: resolveErrorMessage(error, "确认完成核对失败") });
				return null;
			}
		},
		[workspaceId, trackVerificationWrite],
	);

	return {
		activeGroup,
		historyGroups,
		activeDeploymentId,
		loadError,
		hasLoadedOnce: hasLoadedOnce && workspaceIdOfLoadedReadModel === workspaceId,
		pendingVerificationTaskCount,
		refresh,
		refreshAndReadActiveGroup,
		entryNavigationReadModelRequest,
		isVerificationWriteInFlight,
		stayInFront,
		setStayInFront,
		collapsed,
		setCollapsed,
		toggleChecklistItem,
		addCustomChecklistItem,
		removeCustomChecklistItem,
		runVerificationItem,
		requestComplete,
		confirmComplete,
	};
}
