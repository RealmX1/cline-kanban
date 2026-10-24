// session-manager 对「一条 PTY 子进程」的全部操作面。
//
// 为什么抽成接口：今天 PTY master 由 runtime 进程内的 node-pty 持有（PtySession），runtime 一退出
// agent 就随 SIGHUP 死掉。热重启方案（.plan/docs/agent-session-pty-host-hot-restart-implementation-plan.md）
// 把 master 移到独立长驻的 agent session PTY host 进程，runtime 经 Unix socket 远程操作它。
// 两种实现对 session-manager 必须不可区分，所以 ActiveProcessState 只认这个接口，不认具体类。
//
// 只放进程级操作；输出与退出经 spawn 时注册的回调送达，不在接口上。

export interface TerminalPtyProcessExitEvent {
	exitCode: number;
	signal?: number;
}

export interface TerminalPtyProcessHandle {
	readonly pid: number;
	// hosted 会话的真实创建时间来自 host；旧句柄与进程内 PTY 缺省时由调用方沿用本地时间。
	readonly hostedTerminalPtySessionSpawnedAtEpochMs?: number;
	write(data: string | Buffer): void;
	resize(cols: number, rows: number, pixelWidth?: number, pixelHeight?: number): void;
	// 流控：暂停 / 恢复读取 PTY 输出（背压一路传到 agent 的写阻塞）。
	pause(): void;
	resume(): void;
	// interrupted：标记这次停止是用户 / 系统主动打断，退出时据此把会话记成 interrupted 而非正常退出。
	// force：直接 SIGKILL，而不是先 SIGTERM。
	stop(options?: { interrupted?: boolean; force?: boolean }): void;
	hasExited(): boolean;
	wasInterrupted(): boolean;
	// 仅 hosted 句柄实现：把热重启接管记录推给 PTY host 保管（runtime 被 kill -9 后新 runtime 从 host 取回）。
	publishTerminalSessionAdoptionRecordForRuntimeRestart?(adoptionRecord: unknown): void;
}

export type HostedTerminalPtySessionKind = "task_agent_session" | "shell_session";

// 交给 agent session PTY host 代为 spawn 的请求。与 SpawnPtySessionRequest 的差别：
// - 不带 Windows cmd 包装（host 模式在 win32 上强制关闭）；
// - 不记 pty 创建归因探针：那个探针对账的是 runtime 进程自己持有的 pty 资源，hosted pty 不在 runtime 里；
// - 带会话身份，host 用它列出与诊断。
export interface HostedTerminalPtyProcessSpawnRequest {
	taskId: string;
	hostedSessionKind: HostedTerminalPtySessionKind;
	binary: string;
	args: string[];
	cwd: string;
	// 已由 buildTerminalEnvironment 算好的完整环境；值为 undefined 的键不会传给 agent。
	env: Record<string, string | undefined>;
	cols: number;
	rows: number;
	onData: (chunk: Buffer) => void;
	onExit: (event: TerminalPtyProcessExitEvent) => void;
}

// 每个 workspace 一个（由 workspace registry 注入 TerminalSessionManager）。存在即表示 host 模式已启用，
// session-manager 改为 await 它来 spawn；不存在时保持同步的 PtySession.spawn。
export interface HostedTerminalPtyProcessSpawner {
	spawnHostedTerminalPtyProcess(request: HostedTerminalPtyProcessSpawnRequest): Promise<TerminalPtyProcessHandle>;
}

// 新 runtime 启动时，PTY host 里仍在跑（或在 runtime 缺席期间已退出、退出记录尚未确认）的一条会话。
// session-manager 据此决定接管（装回 entry.active）还是拒绝（fail closed：终止进程并按旧路径归零）。
export interface HostedTerminalPtySessionAdoptionCandidate {
	taskId: string;
	hostedSessionKind: HostedTerminalPtySessionKind;
	pid: number;
	spawnedAtEpochMs: number;
	cols: number;
	rows: number;
	exitedWhileRuntimeWasAbsent: boolean;
	// 上一个 runtime 推给 host 的接管记录原文；由 session-manager 解析（见 terminal-session-adoption-record-for-runtime-restart.ts）。
	terminalSessionAdoptionRecord: unknown;
	// 订阅输出并返回句柄。返回之前，环形缓冲里的历史输出经 onCatchUpOutput 交付（只该喂给 mirror，
	// 绝不进字节流检测与查询应答）；之后的实时输出经 onData、退出经 onExit。
	adoptHostedTerminalPtyProcess(callbacks: {
		onCatchUpOutput: (bytes: Buffer) => void;
		onData: (chunk: Buffer) => void;
		onExit: (event: TerminalPtyProcessExitEvent) => void;
	}): Promise<TerminalPtyProcessHandle>;
	terminateHostedTerminalPtyProcessAfterRefusedAdoption(): void;
}
