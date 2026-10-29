// runtime 计划内 handover（热重启）时以 1012 Service Restart（RFC 6455 注册码）关闭浏览器 WebSocket，见运行时
// src/core/kanban-runtime-handover-restart-websocket-close.ts。这里按同一个协议数值判定，不 import 运行时源码。
// agent 会话在热重启期间照常运行，新 runtime 通常几秒内开始监听：提示用户「只是在重启」，并把重连退避重置到最短。

export const WEBSOCKET_CLOSE_CODE_SERVICE_RESTART = 1012;

export const KANBAN_RUNTIME_HOT_RESTART_RECONNECTING_MESSAGE =
	"Kanban is hot-restarting; agent sessions keep running. Reconnecting...";

export function isWebSocketClosedBecauseKanbanRuntimeIsHotRestarting(closeEvent: Pick<CloseEvent, "code">): boolean {
	return closeEvent.code === WEBSOCKET_CLOSE_CODE_SERVICE_RESTART;
}
