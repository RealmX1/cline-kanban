import { useCallback, useLayoutEffect, useRef } from "react";
import { showAppToast } from "@/components/app-toaster";
import type { TerminalControlKeyDefinition } from "@/terminal/terminal-control-key-sequences";
import { getTerminalController } from "@/terminal/terminal-controller-registry";

/** 复合虚拟键按真实按键节奏投递；目标或用户操作变化后不补发遗留按键。 */
export function useTerminalVirtualControlKeyDispatch({
	taskId,
	terminalInputTargetIdentity,
	isInteractive,
}: {
	taskId: string;
	terminalInputTargetIdentity: string;
	isInteractive: boolean;
}): (definition: TerminalControlKeyDefinition) => void {
	const pendingDispatchRef = useRef<{ keyId: string; timeoutId: number } | null>(null);
	const currentInputTargetRef = useRef({ taskId, terminalInputTargetIdentity, isInteractive });
	const cancelPendingDispatch = useCallback(() => {
		if (pendingDispatchRef.current) window.clearTimeout(pendingDispatchRef.current.timeoutId);
		pendingDispatchRef.current = null;
	}, []);
	useLayoutEffect(() => {
		// 页签树保留挂载，因此身份和交互状态变化也必须取消，不能只依赖 unmount。
		cancelPendingDispatch();
		currentInputTargetRef.current = { taskId, terminalInputTargetIdentity, isInteractive };
		return cancelPendingDispatch;
	}, [taskId, terminalInputTargetIdentity, isInteractive, cancelPendingDispatch]);
	useLayoutEffect(() => {
		const cancelWhenHidden = () => {
			if (document.visibilityState === "hidden") cancelPendingDispatch();
		};
		document.addEventListener("visibilitychange", cancelWhenHidden);
		document.addEventListener("keydown", cancelPendingDispatch, true);
		document.addEventListener("input", cancelPendingDispatch, true);
		// xterm 会把物理及虚拟滚轮编码为 PTY 输入，须在它消费事件前取消。
		document.addEventListener("wheel", cancelPendingDispatch, true);
		window.addEventListener("blur", cancelPendingDispatch);
		return () => {
			document.removeEventListener("visibilitychange", cancelWhenHidden);
			document.removeEventListener("keydown", cancelPendingDispatch, true);
			document.removeEventListener("input", cancelPendingDispatch, true);
			document.removeEventListener("wheel", cancelPendingDispatch, true);
			window.removeEventListener("blur", cancelPendingDispatch);
		};
	}, [cancelPendingDispatch]);

	return useCallback(
		(definition: TerminalControlKeyDefinition) => {
			if (!isInteractive || document.visibilityState === "hidden") return;
			if (pendingDispatchRef.current?.keyId === definition.id) return;
			cancelPendingDispatch();
			const inputTarget = currentInputTargetRef.current;
			const controller = getTerminalController(taskId);
			const warnDisconnected = () =>
				showAppToast({ intent: "warning", message: "终端尚未连接。" }, "virtual-key-not-connected");
			const dispatchStep = (index: number) => {
				pendingDispatchRef.current = null;
				if (document.visibilityState === "hidden" || currentInputTargetRef.current !== inputTarget) return;
				if (!controller || getTerminalController(taskId) !== controller) return warnDisconnected();
				const sequence = definition.inputSequences[index];
				if (sequence === undefined) return;
				if (!controller.input(sequence)) return warnDisconnected();
				if (index + 1 < definition.inputSequences.length) {
					pendingDispatchRef.current = {
						keyId: definition.id,
						timeoutId: window.setTimeout(() => dispatchStep(index + 1), definition.interSequenceDelayMs ?? 0),
					};
				}
			};
			dispatchStep(0);
		},
		[taskId, isInteractive, cancelPendingDispatch],
	);
}
