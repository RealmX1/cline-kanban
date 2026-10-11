// 终止一条 PTY 子进程及其整个进程组的信号策略。
//
// node-pty 以 setsid 启动子进程，子进程是新进程组的组长（pgid = pid）。agent 会再拉起 MCP 服务器、
// shell 工具等孙进程，只对组长发信号会把它们留成孤儿，所以每次都同时给 -pid（整个进程组）发同一个信号。
//
// 从 pty-session.ts 抽出来，是因为 runtime 进程内的 PtySession 与独立的 agent session PTY host
// 进程（热重启方案）必须用同一套策略终止会话；host 侧的孤儿回收还需要「SIGTERM 后限时升级 SIGKILL」。

export interface PtyProcessTerminationTarget {
	readonly pid: number;
	// node-pty IPty.kill 的形状：不带参数时 node-pty 在 Unix 上发 SIGHUP（Windows 不接受信号参数）。
	kill(signal?: string): void;
}

export interface PtyProcessGroupTerminationOptions {
	// true：组长与进程组都直接 SIGKILL。否则组长收 node-pty 的默认信号（Unix 上是 SIGHUP），进程组收 SIGTERM。
	force?: boolean;
	// 仅在非 force 时生效：SIGTERM 发出后过这么久进程仍未退出，就对进程与进程组补发 SIGKILL。
	// 未设置则不升级（与抽出前的行为一致）。
	escalateToSigkillAfterMs?: number;
	// 升级前用来判断进程是否已经退出；未提供时视为未退出，到点无条件补发（对已死进程发信号会被吞掉）。
	hasProcessExited?: () => boolean;
}

function sendSignalToPtyProcessGroupBestEffort(pid: number, signal: NodeJS.Signals): void {
	if (process.platform === "win32" || !Number.isFinite(pid) || pid <= 0) {
		return;
	}
	try {
		process.kill(-pid, signal);
	} catch {
		// Best effort: process group may already be gone or inaccessible.
	}
}

function sendSignalToPtyProcessBestEffort(target: PtyProcessTerminationTarget, signal: NodeJS.Signals | null): void {
	try {
		if (signal === null) {
			target.kill();
		} else {
			target.kill(signal);
		}
	} catch {
		// Process already exited or PTY already torn down; nothing to do.
	}
}

// 返回升级定时器的取消函数（没有安排升级时返回空操作）。调用方在确认退出后可以提前取消。
export function terminatePtyProcessGroup(
	target: PtyProcessTerminationTarget,
	options: PtyProcessGroupTerminationOptions = {},
): () => void {
	const pid = target.pid;
	if (options.force) {
		sendSignalToPtyProcessBestEffort(target, "SIGKILL");
		sendSignalToPtyProcessGroupBestEffort(pid, "SIGKILL");
		return () => {};
	}
	// 组长用 node-pty 的默认信号（与抽出前完全一致），进程组统一发 SIGTERM。
	sendSignalToPtyProcessBestEffort(target, null);
	sendSignalToPtyProcessGroupBestEffort(pid, "SIGTERM");
	const escalateToSigkillAfterMs = options.escalateToSigkillAfterMs;
	if (escalateToSigkillAfterMs === undefined) {
		return () => {};
	}
	const escalationTimer = setTimeout(() => {
		if (options.hasProcessExited?.() === true) {
			return;
		}
		sendSignalToPtyProcessBestEffort(target, "SIGKILL");
		sendSignalToPtyProcessGroupBestEffort(pid, "SIGKILL");
	}, escalateToSigkillAfterMs);
	escalationTimer.unref?.();
	return () => clearTimeout(escalationTimer);
}
