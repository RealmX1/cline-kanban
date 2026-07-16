// [fs-lock] 诊断日志。与 tui-freeze-logger 同款范式：直接写 process.stderr，使消息绕过 no-console
// lint 规则、并在 Kanban 服务器日志中可见，而无需接入可选的 cline-runtime-logger 管道。
//
// 存在意义：advisory 文件锁被判 compromised（多因事件循环停摆导致 mtime 刷新定时器错过）本身是可恢复的，
// 绝不应升级为整个进程退出。此处把这类事件降级为日志记录，让运维仍能看见频率与路径，而不牺牲可用性。
//
// 两档可见度：
//  - warn：可预期、良性的锁事件（compromise 本身、compromise 善后导致的 release() 良性拒绝）。
//  - error：意外但依旧【不得崩溃服务器】的锁事件（例如锁文件真的删不掉的 EACCES/EIO/EPERM），
//    用更醒目的级别让运维察觉遗留的陈旧锁文件（可经 staleMs 自愈），但绝不因此抛出。

function emitLine(prefix: string, payload: string): void {
	try {
		process.stderr.write(`${prefix} ${payload}\n`);
	} catch {
		// Best-effort diagnostic logging only.
	}
}

export function logFileLockWarning(payload: string): void {
	emitLine("[warn] [fs-lock]", payload);
}

export function logFileLockError(payload: string): void {
	emitLine("[error] [fs-lock]", payload);
}
