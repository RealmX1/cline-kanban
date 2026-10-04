// runtime 把第二个 SIGINT 当作强退（src/core/graceful-shutdown.ts），所以本 hook 至多发一次 SIGINT，
// 避免「先收到 shutdown 消息、随后 IPC 断开」时打断正在进行的优雅关停。
let runtimeGracefulShutdownRequestedThroughShutdownIpcHook = false;

// 长于 runtime 自身 10s 的优雅关停超时；unref 不让兜底计时器本身吊住进程。
const PARENT_DISCONNECTED_FALLBACK_EXIT_DELAY_MS = 15_000;

function emitSigintOnceToStartRuntimeGracefulShutdown() {
	if (runtimeGracefulShutdownRequestedThroughShutdownIpcHook) {
		return;
	}
	runtimeGracefulShutdownRequestedThroughShutdownIpcHook = true;
	process.emit("SIGINT");
}

function scheduleFallbackExitAfterParentDisconnected() {
	setTimeout(() => {
		process.exit(1);
	}, PARENT_DISCONNECTED_FALLBACK_EXIT_DELAY_MS).unref();
}

process.on("message", (message) => {
	if (!message || typeof message !== "object") {
		return;
	}

	if (message.type !== "kanban.shutdown") {
		return;
	}

	emitSigintOnceToStartRuntimeGracefulShutdown();
});

// IPC 断开 = 父进程（vitest worker）已死或已放手。不处理的话，空闲 runtime 只有写 pipe 时才会 EPIPE 退出，
// 一直不写就成为 ppid=1 的长寿孤儿。
process.on("disconnect", () => {
	if (runtimeGracefulShutdownRequestedThroughShutdownIpcHook) {
		scheduleFallbackExitAfterParentDisconnected();
		return;
	}
	// runtime 的 SIGINT 处理器在打印启动 banner 之后才安装；启动期间没人响应 SIGINT，直接退出。
	if (process.listenerCount("SIGINT") === 0) {
		process.exit(1);
		return;
	}
	emitSigintOnceToStartRuntimeGracefulShutdown();
	scheduleFallbackExitAfterParentDisconnected();
});
