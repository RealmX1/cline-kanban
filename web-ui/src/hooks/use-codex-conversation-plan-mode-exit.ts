import { isAgentAwaitingModalUserDecision, resolveSessionFacets } from "@runtime-session-activity";
import { useEffect, useRef, useState } from "react";
import { showAppToast } from "@/components/app-toaster";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";

export function useCodexConversationPlanModeExit(input: {
	workspaceId: string | null;
	taskConversationSessionId: string;
	summary: RuntimeTaskSessionSummary | null;
	isSessionReadOnly: boolean;
}) {
	const { workspaceId, taskConversationSessionId, summary, isSessionReadOnly } = input;
	const incarnationId = summary?.runtimeSessionIncarnationId;
	const nativeSessionId = summary?.agentNativeConversationSessionIdentity?.nativeSessionId;
	const codexNativeSessionControlEndpoint = summary?.codexNativeSessionControlEndpoint;
	const modeExitSessionSelectionIdentityKey = JSON.stringify([workspaceId, taskConversationSessionId]);
	const modeExitTargetIdentityKey = JSON.stringify([
		workspaceId,
		taskConversationSessionId,
		summary?.taskId,
		summary?.taskConversationSessionMetadata?.workspaceTaskId,
		summary?.workspacePath,
		summary?.pid,
		incarnationId,
		nativeSessionId,
		summary?.agentNativeConversationSessionIdentity?.sourceAgentId,
		codexNativeSessionControlEndpoint?.workspaceId,
		codexNativeSessionControlEndpoint?.conversationSessionId,
		codexNativeSessionControlEndpoint?.runtimeSessionIncarnationId,
		codexNativeSessionControlEndpoint?.socketPath,
	]);
	const currentExecutableModeExitTargetIdentityKey = useRef<string | null>(null);
	const inFlightModeExitRequestsByTargetIdentityKey = useRef(
		new Map<string, { sessionSelectionIdentityKey: string; isReceiptValid: boolean }>(),
	);
	const [pendingModeExitTargetIdentityKeys, setPendingModeExitTargetIdentityKeys] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const isMounted = useRef(false);
	useEffect(() => {
		isMounted.current = true;
		return () => {
			isMounted.current = false;
		};
	}, []);
	const isAvailable = summary?.agentId === "codex" && workspaceId !== null && !isSessionReadOnly;
	const facets = summary ? resolveSessionFacets(summary) : null;
	const disabledReason =
		!incarnationId ||
		!nativeSessionId ||
		!summary?.pid ||
		!codexNativeSessionControlEndpoint ||
		facets?.liveness !== "live"
			? "请先恢复 Codex 会话，再退出计划模式。"
			: facets.turnOwner === "agent" || isAgentAwaitingModalUserDecision(facets)
				? "请先结束或中断当前回合，并处理原生待答问题。"
				: null;
	currentExecutableModeExitTargetIdentityKey.current =
		isAvailable && disabledReason === null ? modeExitTargetIdentityKey : null;
	// 切换会话保留各自等待；同一会话一旦失去资格或绑定改变，恢复后也不能复活旧回执。
	for (const [targetIdentityKey, request] of inFlightModeExitRequestsByTargetIdentityKey.current) {
		if (
			request.sessionSelectionIdentityKey === modeExitSessionSelectionIdentityKey &&
			currentExecutableModeExitTargetIdentityKey.current !== targetIdentityKey
		)
			request.isReceiptValid = false;
	}
	const exitPlanMode = async () => {
		if (
			!isAvailable ||
			!workspaceId ||
			disabledReason ||
			!incarnationId ||
			!nativeSessionId ||
			currentExecutableModeExitTargetIdentityKey.current !== modeExitTargetIdentityKey ||
			inFlightModeExitRequestsByTargetIdentityKey.current.has(modeExitTargetIdentityKey)
		)
			return;
		const modeExitRequest = {
			sessionSelectionIdentityKey: modeExitSessionSelectionIdentityKey,
			isReceiptValid: true,
		};
		inFlightModeExitRequestsByTargetIdentityKey.current.set(modeExitTargetIdentityKey, modeExitRequest);
		setPendingModeExitTargetIdentityKeys((pendingIdentityKeys) =>
			new Set(pendingIdentityKeys).add(modeExitTargetIdentityKey),
		);
		const canShowModeExitReceipt = () =>
			isMounted.current &&
			modeExitRequest.isReceiptValid &&
			currentExecutableModeExitTargetIdentityKey.current === modeExitTargetIdentityKey;
		try {
			const response = await getRuntimeTrpcClient(
				workspaceId,
			).runtime.exitCodexTaskConversationSessionPlanMode.mutate({
				taskConversationSessionId,
				expectedRuntimeSessionIncarnationId: incarnationId,
				expectedNativeConversationSessionId: nativeSessionId,
			});
			if (!canShowModeExitReceipt()) return;
			showAppToast(
				"error" in response
					? { intent: "danger", message: response.error, timeout: 10000 }
					: { intent: "success", message: response.status === "exited" ? "已退出计划模式" : "当前已是默认模式" },
			);
		} catch (error) {
			if (canShowModeExitReceipt())
				showAppToast({
					intent: "danger",
					message: `退出结果尚未确认，可重试：${error instanceof Error ? error.message : String(error)}`,
					timeout: 10000,
				});
		} finally {
			if (inFlightModeExitRequestsByTargetIdentityKey.current.get(modeExitTargetIdentityKey) === modeExitRequest) {
				inFlightModeExitRequestsByTargetIdentityKey.current.delete(modeExitTargetIdentityKey);
				if (isMounted.current)
					setPendingModeExitTargetIdentityKeys((pendingIdentityKeys) => {
						const remainingPendingIdentityKeys = new Set(pendingIdentityKeys);
						remainingPendingIdentityKeys.delete(modeExitTargetIdentityKey);
						return remainingPendingIdentityKeys;
					});
			}
		}
	};
	return {
		isAvailable,
		disabledReason,
		isExiting: pendingModeExitTargetIdentityKeys.has(modeExitTargetIdentityKey),
		exitPlanMode,
	};
}
