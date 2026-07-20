import { type Dispatch, type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
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

export interface UsePostDeployVerificationResult {
	// active 组 = 该 workspace 中 activeDeploymentId 指向的组（foldedAtIso === null 的最新组）；无则 null。
	activeGroup: RuntimePostDeployVerificationDeploymentGroup | null;
	// 折叠历史组，按 deploy 时间倒序（plan 面板三区之二）。
	historyGroups: RuntimePostDeployVerificationDeploymentGroup[];
	activeDeploymentId: string | null;
	loadError: string | null;
	// 首次成功加载前为 false——用于避免面板在数据到达前闪现空态。
	hasLoadedOnce: boolean;
	refresh: () => void;
	// 「保持最前」偏好（默认 true，见 plan 面板行为表）。
	stayInFront: boolean;
	setStayInFront: Dispatch<SetStateAction<boolean>>;
	// 折叠为右下角 badge 的偏好。
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

export function usePostDeployVerification(workspaceId: string | null): UsePostDeployVerificationResult {
	const isDocumentVisible = useDocumentVisibility();
	const [deploymentGroups, setDeploymentGroups] = useState<RuntimePostDeployVerificationDeploymentGroup[]>([]);
	const [activeDeploymentId, setActiveDeploymentId] = useState<string | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
	const [stayInFront, setStayInFront] = useBooleanLocalStorageValue(
		LocalStorageKey.PostDeployVerificationStayInFront,
		true,
	);
	const [collapsed, setCollapsed] = useBooleanLocalStorageValue(
		LocalStorageKey.PostDeployVerificationCollapsed,
		false,
	);

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
			try {
				return await runMutation();
			} finally {
				if (verificationWriteWorkspaceGenerationRef.current === writeWorkspaceGenerationAtLaunch) {
					inFlightVerificationWriteCountRef.current -= 1;
					verificationWriteCompletionSeqRef.current += 1;
				}
			}
		},
		[],
	);

	const refresh = useCallback(() => {
		if (!workspaceId) {
			setDeploymentGroups([]);
			setActiveDeploymentId(null);
			return;
		}
		const requestWorkspaceId = workspaceId;
		// 同步捕获基线：本次轮询发起时的写入完成序号。响应返回后若序号已变，说明有本地写入在此轮询窗口内完成。
		const writeCompletionSeqAtRefreshLaunch = verificationWriteCompletionSeqRef.current;
		void (async () => {
			try {
				const client = getRuntimeTrpcClient(requestWorkspaceId);
				const response = await client.deployment.getPostDeployVerificationState.query({});
				if (!isMountedRef.current || requestWorkspaceIdRef.current !== requestWorkspaceId) {
					return;
				}
				if (
					inFlightVerificationWriteCountRef.current > 0 ||
					verificationWriteCompletionSeqRef.current !== writeCompletionSeqAtRefreshLaunch
				) {
					// 本次轮询在飞期间有本地写入在飞/已完成，服务端快照可能早于该写入；丢弃以免回退乐观状态。
					// 被影响项的乐观 + mutation 响应本地已是正确值，下一次轮询（≤30s）再做全量对账。
					return;
				}
				setDeploymentGroups(response.deploymentGroups);
				setActiveDeploymentId(response.activeDeploymentId);
				setLoadError(null);
				setHasLoadedOnce(true);
				const previousActiveDeploymentId = previousActiveDeploymentIdRef.current;
				previousActiveDeploymentIdRef.current = response.activeDeploymentId;
				// 首帧（undefined）不提醒；此后 active 组 id 变为新的非空值 = 一次新 deploy。
				if (
					previousActiveDeploymentId !== undefined &&
					response.activeDeploymentId !== null &&
					response.activeDeploymentId !== previousActiveDeploymentId
				) {
					showAppToast({ intent: "primary", message: "检测到新部署 · 请核对 Post-Deploy Verification" });
					setCollapsed(false);
				}
			} catch (error) {
				if (!isMountedRef.current || requestWorkspaceIdRef.current !== requestWorkspaceId) {
					return;
				}
				setLoadError(resolveErrorMessage(error, "加载 Post-Deploy Verification 状态失败"));
			}
		})();
	}, [workspaceId, setCollapsed]);

	// workspace 切换：重置检测基线与数据，立即拉取新 workspace 状态。
	useEffect(() => {
		requestWorkspaceIdRef.current = workspaceId;
		// 自增写入代际并把在飞计数归零：使旧 workspace 尚未 settle 的写入不再影响新 workspace 的过期轮询守卫
		// （旧写入的 settle 会因代际不符而在 trackVerificationWrite 的 finally 里被跳过，不再回收 count / 推进 seq）。
		verificationWriteWorkspaceGenerationRef.current += 1;
		inFlightVerificationWriteCountRef.current = 0;
		previousActiveDeploymentIdRef.current = undefined;
		setHasLoadedOnce(false);
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
		workspaceId && isDocumentVisible ? POST_DEPLOY_VERIFICATION_POLL_INTERVAL_MS : null,
	);

	// tab 由隐藏转可见的边沿：立即刷新一次（focus immediate，见 plan 数据流）。
	useEffect(() => {
		if (isDocumentVisible && !wasDocumentVisibleRef.current && workspaceId) {
			refresh();
		}
		wasDocumentVisibleRef.current = isDocumentVisible;
	}, [isDocumentVisible, workspaceId, refresh]);

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
		hasLoadedOnce,
		refresh,
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
