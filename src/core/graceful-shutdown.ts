/*
Kanban has to shut down cleanly across several launch shapes:

- `kanban`
- `npx kanban`
- `cline --kanban`
- `npx cline --kanban`

Those are not equivalent from a signal-delivery perspective.

When the user presses Ctrl+C, the terminal sends SIGINT to the foreground process
group, not just to "the real app". In wrapper-based launches, Kanban can receive:

1. the original SIGINT directly from the terminal process group
2. an immediate second SIGINT replayed by a wrapper such as `npx` or `npm exec`

That means one physical Ctrl+C can look like two SIGINTs by the time it reaches
Kanban. A generic graceful-shutdown helper cannot tell whether the second signal
was:

- a true second Ctrl+C from the user
- a duplicate forwarded by a parent wrapper during its own shutdown

We used to rely on a generic helper with the common policy "first signal starts
graceful shutdown, second signal force exits". That works for direct launches,
but it breaks under wrapper launches because the replayed SIGINT gets mistaken
for an intentional force-quit request. The result is that Kanban can bail out
mid-cleanup even though the user only pressed Ctrl+C once.

This module keeps the shutdown logic local so we can encode the one piece of
context a generic library does not have: some launch environments are known to
replay signals. We detect those environments conservatively, then suppress only
an immediate duplicate copy of the same signal while shutdown is already in
progress.

Important design constraints:

- We only suppress duplicates for wrapper-style launches, not normal direct runs.
- We only suppress the same signal as the one that started shutdown.
- We only suppress duplicates for a short window.
- A later second Ctrl+C still force exits.
- Timeout behavior is preserved so a stuck shutdown cannot hang forever.

The small tradeoff is intentional: in wrapper launches, a human pressing Ctrl+C
twice extremely quickly may have the second press treated as a wrapper replay if
it lands inside the duplicate window. In practice that is much less harmful than
the old behavior, where a single Ctrl+C under `npx` or `cline --kanban` could be
misread as a double interrupt and force exit immediately.
*/
import {
	RUNTIME_PLANNED_HANDOVER_RESTART_PROCESS_SIGNAL,
	RUNTIME_SHUTDOWN_PROCESS_SIGNALS,
	type RuntimeShutdownTrigger,
	resolveRuntimeProcessTerminationAfterShutdown,
} from "./runtime-shutdown-trigger";

/*
Hot restart (agent session PTY host) adds two non-signal ways to shut down, and the
signal itself no longer decides what happens to agent sessions:

- every shutdown is described by a RuntimeShutdownTrigger (src/core/runtime-shutdown-trigger.ts);
- SIGUSR2 starts a planned handover restart when the caller accepts it;
- `requestShutdown(trigger)` starts a handover / explicit stop requested over tRPC;
- how the process ends afterwards (re-raise the signal, or exit 75 for handover)
  is resolved per trigger, so supervisors keep seeing 130 / 143 for signal stops.
*/
const DEFAULT_HANDLED_SIGNALS = RUNTIME_SHUTDOWN_PROCESS_SIGNALS;
const DEFAULT_DUPLICATE_SIGNAL_WINDOW_MS = 750;
const TRANSIENT_CLI_CACHE_PATH_MARKERS = [
	"/.npm/_npx/",
	"/npm/_npx/",
	"/npm-cache/_npx/",
	"/.npx/",
	"/pnpm/dlx/",
	"/.yarn/cache/",
	"/bunx-",
] as const;

export type HandledShutdownSignal = (typeof DEFAULT_HANDLED_SIGNALS)[number];

type ListenedProcessSignal = HandledShutdownSignal | typeof RUNTIME_PLANNED_HANDOVER_RESTART_PROCESS_SIGNAL;

export interface GracefulShutdownProcess {
	on(signal: ListenedProcessSignal, listener: () => void): unknown;
	off(signal: ListenedProcessSignal, listener: () => void): unknown;
}

interface GracefulShutdownOptions {
	// 信号触发的停止的期限；其余触发的期限由 resolveShutdownDeadlineMs 给出（缺省同样用它）。
	delayMs: number;
	resolveShutdownDeadlineMs?: (trigger: RuntimeShutdownTrigger) => number;
	onShutdown: (trigger: RuntimeShutdownTrigger) => Promise<void>;
	onShutdownError?: (error: unknown) => void;
	onSecondSignal?: (signal: HandledShutdownSignal) => void;
	onTimeout?: (delayMs: number) => void;
	process: GracefulShutdownProcess;
	exit: (code: number) => void;
	reraiseSignal?: (signal: HandledShutdownSignal) => void;
	suppressImmediateDuplicateSignals?: boolean;
	duplicateSignalWindowMs?: number;
	now?: () => number;
	// 提供时才监听 SIGUSR2：返回 true 则按计划内 handover 停止，false 则忽略这个信号（例如 host 模式没开，
	// handover 只会打断全部会话）并调用 onPlannedHandoverRestartSignalIgnored。
	acceptPlannedHandoverRestartSignal?: () => boolean;
	onPlannedHandoverRestartSignalIgnored?: () => void;
}

export type GracefulShutdownRequestOutcome = "shutdown_started" | "shutdown_already_in_progress";

function resolveExitCodeAfterCompletedShutdown(trigger: RuntimeShutdownTrigger): number {
	const termination = resolveRuntimeProcessTerminationAfterShutdown(trigger);
	return termination.kind === "exit_with_code" ? termination.exitCode : getExitCodeForSignal(termination.signal);
}

export function getExitCodeForSignal(signal: HandledShutdownSignal | null): number {
	switch (signal) {
		case "SIGHUP":
			return 129;
		case "SIGINT":
			return 130;
		case "SIGTERM":
			return 143;
		default:
			return 0;
	}
}

function normalizePath(path: string): string {
	return path.replaceAll("\\", "/").toLowerCase();
}

export function shouldSuppressImmediateDuplicateShutdownSignals(options?: {
	argv?: string[];
	env?: NodeJS.ProcessEnv;
}): boolean {
	const env = options?.env ?? process.env;
	if (typeof env.npm_execpath === "string" && env.npm_execpath.length > 0) {
		return true;
	}

	const argv = options?.argv ?? process.argv;
	const entrypointPath = argv[1];
	if (typeof entrypointPath !== "string" || entrypointPath.length === 0) {
		return false;
	}

	const normalizedPath = normalizePath(entrypointPath);
	return TRANSIENT_CLI_CACHE_PATH_MARKERS.some((marker) => normalizedPath.includes(marker));
}

export function installGracefulShutdownHandlers(options: GracefulShutdownOptions): {
	uninstall: () => void;
	requestShutdown: (trigger: RuntimeShutdownTrigger) => GracefulShutdownRequestOutcome;
} {
	const processRef = options.process;
	const now = options.now ?? (() => Date.now());
	const duplicateSignalWindowMs = options.duplicateSignalWindowMs ?? DEFAULT_DUPLICATE_SIGNAL_WINDOW_MS;
	const signalListeners = new Map<ListenedProcessSignal, () => void>();
	let timeoutId: ReturnType<typeof setTimeout> | null = null;
	let shutdownPromise: Promise<void> | null = null;
	let shutdownTrigger: RuntimeShutdownTrigger | null = null;
	let shutdownStartedAt = 0;
	let finalized = false;
	let installed = true;

	const uninstall = () => {
		if (!installed) {
			return;
		}
		installed = false;
		for (const [signal, listener] of signalListeners) {
			processRef.off(signal, listener);
		}
		signalListeners.clear();
	};

	// 触发要求重放信号（信号停止、显式全停）时一律重放，含超时 / 失败 / 第二个信号：父进程据此看到「被该信号结束」。
	// 否则（handover）按给定的退出码退出。
	const finalizeExit = (code: number) => {
		if (finalized) {
			return;
		}
		finalized = true;
		uninstall();
		if (timeoutId !== null) {
			clearTimeout(timeoutId);
			timeoutId = null;
		}
		const termination = shutdownTrigger ? resolveRuntimeProcessTerminationAfterShutdown(shutdownTrigger) : null;
		if (termination?.kind === "reraise_process_signal" && options.reraiseSignal) {
			options.reraiseSignal(termination.signal);
			return;
		}
		options.exit(code);
	};

	const startShutdown = (trigger: RuntimeShutdownTrigger): GracefulShutdownRequestOutcome => {
		if (shutdownPromise !== null) {
			return "shutdown_already_in_progress";
		}

		shutdownTrigger = trigger;
		shutdownStartedAt = now();
		const shutdownDeadlineMs =
			trigger.kind === "process_signal"
				? options.delayMs
				: (options.resolveShutdownDeadlineMs?.(trigger) ?? options.delayMs);
		timeoutId = setTimeout(() => {
			options.onTimeout?.(shutdownDeadlineMs);
			finalizeExit(1);
		}, shutdownDeadlineMs);

		shutdownPromise = (async () => {
			try {
				await options.onShutdown(trigger);
				finalizeExit(resolveExitCodeAfterCompletedShutdown(trigger));
			} catch (error) {
				options.onShutdownError?.(error);
				finalizeExit(1);
			}
		})();
		return "shutdown_started";
	};

	const handleSignal = (signal: HandledShutdownSignal) => {
		if (shutdownPromise === null) {
			startShutdown({ kind: "process_signal", signal });
			return;
		}

		if (
			options.suppressImmediateDuplicateSignals === true &&
			shutdownTrigger?.kind === "process_signal" &&
			signal === shutdownTrigger.signal &&
			now() - shutdownStartedAt <= duplicateSignalWindowMs
		) {
			return;
		}

		options.onSecondSignal?.(signal);
		finalizeExit(getExitCodeForSignal(signal));
	};

	for (const signal of DEFAULT_HANDLED_SIGNALS) {
		const listener = () => {
			handleSignal(signal);
		};
		signalListeners.set(signal, listener);
		processRef.on(signal, listener);
	}

	const acceptPlannedHandoverRestartSignal = options.acceptPlannedHandoverRestartSignal;
	if (acceptPlannedHandoverRestartSignal) {
		const listener = () => {
			// 已在停止中：handover 信号不升级成强退（与 SIGINT 的「第二下」不同，它不是人急着要退）。
			if (shutdownPromise !== null) {
				return;
			}
			if (!acceptPlannedHandoverRestartSignal()) {
				options.onPlannedHandoverRestartSignalIgnored?.();
				return;
			}
			startShutdown({
				kind: "planned_handover_restart_preserving_hosted_agent_sessions",
				requestedVia: "process_signal_sigusr2",
			});
		};
		signalListeners.set(RUNTIME_PLANNED_HANDOVER_RESTART_PROCESS_SIGNAL, listener);
		processRef.on(RUNTIME_PLANNED_HANDOVER_RESTART_PROCESS_SIGNAL, listener);
	}

	return { uninstall, requestShutdown: startShutdown };
}
