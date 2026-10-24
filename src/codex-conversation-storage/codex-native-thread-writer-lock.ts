import { spawn } from "node:child_process";
import { type FileHandle, mkdir, open } from "node:fs/promises";
import { join } from "node:path";

export interface CodexNativeConversationFamilyWriterLockGuard {
	assertWriterLocksStillValid: () => void;
}

// 与 Codex 0.164 的 POSIX flock 使用同一把内核锁。文件存在与否、会话处于 idle 均不是停写证据。
// Windows 没有 fcntl，迁移保守拒绝；新增会话隔离不依赖此辅助程序。
export async function withStoppedCodexNativeThreadWriterLock<T>(
	homeDirectoryPath: string,
	nativeSessionId: string,
	operation: (writerLockGuard: CodexNativeConversationFamilyWriterLockGuard) => Promise<T>,
): Promise<T> {
	return withStoppedCodexNativeConversationFamilyWriterLocks(homeDirectoryPath, [nativeSessionId], operation);
}

export async function withStoppedCodexNativeConversationFamilyWriterLocks<T>(
	homeDirectoryPath: string,
	nativeSessionIds: readonly string[],
	operation: (writerLockGuard: CodexNativeConversationFamilyWriterLockGuard) => Promise<T>,
): Promise<T> {
	if (process.platform === "win32") throw new Error("此平台尚不支持核验 Codex 原生写锁，未迁移任何会话。");
	const lockFileHandles: FileHandle[] = [];
	try {
		const writerLockDirectoryPath = join(homeDirectoryPath, "thread-writer-locks");
		await mkdir(writerLockDirectoryPath, { recursive: true });
		for (const nativeSessionId of nativeSessionIds)
			lockFileHandles.push(await open(join(writerLockDirectoryPath, `${nativeSessionId}.lock`), "a+"));
		return await withInheritedCodexNativeWriterLockFileDescriptors(lockFileHandles, operation);
	} finally {
		await Promise.all(lockFileHandles.map((handle) => handle.close()));
	}
}

async function withInheritedCodexNativeWriterLockFileDescriptors<T>(
	lockFileHandles: readonly FileHandle[],
	operation: (writerLockGuard: CodexNativeConversationFamilyWriterLockGuard) => Promise<T>,
): Promise<T> {
	const script = [
		"import fcntl, sys",
		"for descriptor in sys.argv[1:]:",
		" try: fcntl.flock(int(descriptor), fcntl.LOCK_EX | fcntl.LOCK_NB)",
		" except BlockingIOError: sys.exit(73)",
		"print('CODEX_NATIVE_WRITER_LOCK_ACQUIRED',flush=True)",
		"sys.stdin.buffer.read()",
	].join("\n");
	// flock 属于共享的 open file description；父进程保留同一 fd，辅助进程死亡也不会释放在途操作的锁。
	const child = spawn("python3", ["-u", "-c", script, ...lockFileHandles.map((_handle, index) => String(index + 3))], {
		stdio: ["pipe", "pipe", "ignore", ...lockFileHandles.map((handle) => handle.fd)],
		env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT },
	});
	let helperExitExpected = false;
	let writerLockFailure: Error | null = null;
	const invalidateWriterLockGuard = () => {
		if (!helperExitExpected)
			writerLockFailure ??= new Error("Codex 写锁辅助进程异常退出或连接断开，已停止迁移或回退。");
	};
	child.once("error", invalidateWriterLockGuard);
	child.once("exit", invalidateWriterLockGuard);
	child.stdin?.on("error", invalidateWriterLockGuard);
	const writerLockGuard: CodexNativeConversationFamilyWriterLockGuard = {
		assertWriterLocksStillValid() {
			if (child.exitCode !== null || child.signalCode !== null) invalidateWriterLockGuard();
			if (writerLockFailure) throw writerLockFailure;
		},
	};
	let exited = false;
	const exit = new Promise<void>((resolveExit) =>
		child.once("close", () => {
			invalidateWriterLockGuard();
			exited = true;
			resolveExit();
		}),
	);
	let result: T;
	try {
		await new Promise<void>((resolveReady, rejectReady) => {
			const timer = setTimeout(() => rejectReady(new Error("核验 Codex 写锁超时，未迁移会话。")), 5_000);
			child.once("error", () => {
				clearTimeout(timer);
				rejectReady(new Error("无法运行 python3/fcntl 写锁核验，未迁移会话。"));
			});
			child.once("close", () => {
				clearTimeout(timer);
				rejectReady(new Error("原生会话仍被写入或写锁状态未知，已延后迁移。"));
			});
			child.stdout?.once("data", (chunk: Buffer) => {
				clearTimeout(timer);
				if (chunk.toString().trim() === "CODEX_NATIVE_WRITER_LOCK_ACQUIRED") resolveReady();
				else rejectReady(new Error("无法确认原生写锁身份，未迁移会话。"));
			});
		});
		writerLockGuard.assertWriterLocksStillValid();
		// 不以 Promise.race 提前返回：回调及其已开始的异步写入必须先收口，父进程才关闭持锁 fd。
		result = await operation(writerLockGuard);
		writerLockGuard.assertWriterLocksStillValid();
	} finally {
		helperExitExpected = true;
		child.stdin?.end();
		const timer = setTimeout(() => {
			if (!exited) child.kill("SIGKILL");
		}, 2_000);
		await exit;
		clearTimeout(timer);
	}
	// 退出事件可能晚于最后一次有效性检查；只有收口后确认正常退出，才允许调用方收到成功。
	if (writerLockFailure || child.exitCode !== 0 || child.signalCode !== null)
		throw writerLockFailure ?? new Error("Codex 写锁辅助进程未正常退出，无法确认迁移或回退成功。");
	return result;
}
