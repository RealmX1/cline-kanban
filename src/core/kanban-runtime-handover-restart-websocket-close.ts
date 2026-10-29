// 计划内 handover 重启时，runtime 关闭浏览器 WebSocket 用的关闭码与原因。
// 1012 Service Restart 是 RFC 6455 的注册码：服务端正在重启，客户端应当稍后重连。web-ui 据此显示「正在热重启」，
// 并把重连退避重置到最短（新 runtime 通常几秒内就开始监听）。web-ui 侧按同一个协议数值判定，不 import 本文件。
export const WEBSOCKET_CLOSE_CODE_SERVICE_RESTART = 1012;
export const WEBSOCKET_CLOSE_REASON_KANBAN_RUNTIME_HANDOVER_RESTART = "Kanban runtime is restarting.";
