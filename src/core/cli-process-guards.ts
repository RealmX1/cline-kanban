const DEFAULT_CLI_HARD_TIMEOUT_MS = 35_000;
const DEFAULT_CLI_TRPC_TIMEOUT_MS = 28_000;
export const DEFAULT_CLI_RUNTIME_HANDOVER_SUCCESSOR_WAIT_SECONDS = 60;
/** Subcommand shutdown flush budget — must fit inside HARD − TRPC margin. */
export const DEFAULT_CLI_TELEMETRY_FLUSH_MS = 500;
export const CLI_TASK_GROUP_WATCH_INTERRUPTED_SHUTDOWN_TIMEOUT_MS = 2_000;

let fatalHandlersInstalled = false;
let handlingFatalError = false;
type CliProcessExit = (code: number) => never;
type CliFatalErrorReporter = (error: unknown) => void;
let cliProcessExit: CliProcessExit | null = null;
let fatalErrorReporter: CliFatalErrorReporter | null = null;

export function registerCliProcessExit(exit: CliProcessExit): void {
	cliProcessExit = exit;
}

export function registerCliFatalErrorReporter(reporter: CliFatalErrorReporter): void {
	fatalErrorReporter = reporter;
}

function reportFatalError(error: unknown): void {
	try {
		fatalErrorReporter?.(error);
	} catch {
		// Telemetry must never block fatal CLI exit.
	}
}

function exitCliProcess(code: number): never {
	if (cliProcessExit) {
		cliProcessExit(code);
	}
	throw new Error(`kanban: CLI exit handler was not registered (code=${code}).`);
}

function parsePositiveIntEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined) {
		return fallback;
	}
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return fallback;
	}
	return parsed;
}

export function resolveCliHardTimeoutOverrideMs(): number | undefined {
	return parsePositiveIntEnv("KANBAN_CLI_HARD_TIMEOUT_MS", 0) || undefined;
}

export function resolveCliHardTimeoutMs(argv: readonly string[] = process.argv): number {
	const runtimeCommandIndex = argv.indexOf("runtime");
	let fallback = isTaskIndexingSupportTriageInvocation(argv) ? 240_000 : DEFAULT_CLI_HARD_TIMEOUT_MS;
	if (runtimeCommandIndex >= 0 && argv[runtimeCommandIndex + 1] === "handover-restart") {
		let successorWaitSeconds = DEFAULT_CLI_RUNTIME_HANDOVER_SUCCESSOR_WAIT_SECONDS;
		for (let index = runtimeCommandIndex + 2; index < argv.length && argv[index] !== "--"; index++) {
			const argument = argv[index];
			const value =
				argument === "--wait-for-successor-seconds"
					? argv[++index]
					: argument.startsWith("--wait-for-successor-seconds=")
						? argument.slice(argument.indexOf("=") + 1)
						: undefined;
			if (value !== undefined && Number.isFinite(Number(value)) && Number(value) >= 0)
				successorWaitSeconds = Number(value);
		}
		// 等待从 tRPC 成功返回后才开始；还须覆盖一次 HTTP 探测及最终输出、遥测排空。
		fallback = Math.max(fallback, resolveCliTrpcTimeoutMs(argv) + successorWaitSeconds * 1000 + 5_000);
	}
	return resolveCliHardTimeoutOverrideMs() ?? fallback;
}

export function resolveCliTrpcTimeoutMs(argv: readonly string[] = process.argv): number {
	return parsePositiveIntEnv(
		"KANBAN_CLI_TRPC_TIMEOUT_MS",
		isTaskIndexingSupportTriageInvocation(argv) ? 210_000 : DEFAULT_CLI_TRPC_TIMEOUT_MS,
	);
}

function isTaskIndexingSupportTriageInvocation(argv: readonly string[]): boolean {
	const index = argv.indexOf("support");
	return index >= 0 && argv[index + 1] === "triage-incoming-work-item";
}

export function safeErrorMessage(error: unknown): string {
	if (typeof error === "string") {
		return error;
	}
	if (typeof error === "object" && error !== null && "message" in error) {
		const message = (error as { message?: unknown }).message;
		if (typeof message === "string" && message.trim().length > 0) {
			return message;
		}
	}
	try {
		return String(error);
	} catch {
		return "unknown error";
	}
}

export function safeStringify(value: unknown, space?: number | string): string {
	try {
		const currentAncestorObjects: object[] = [];
		return JSON.stringify(
			value,
			function (this: object, _key, nested: unknown) {
				if (typeof nested === "object" && nested !== null) {
					// 只检测当前祖先链上的回指；兄弟分组共享对象不构成循环。
					while (currentAncestorObjects.length > 0 && currentAncestorObjects.at(-1) !== this) {
						currentAncestorObjects.pop();
					}
					if (currentAncestorObjects.includes(nested)) {
						return "[Circular]";
					}
					currentAncestorObjects.push(nested);
				}
				return nested;
			},
			space,
		);
	} catch {
		return JSON.stringify({ ok: false, error: "serialization failed" });
	}
}

export function mergeAbortSignals(...signals: Array<AbortSignal | undefined | null>): AbortSignal | undefined {
	const active = signals.filter((signal): signal is AbortSignal => signal !== undefined && signal !== null);
	if (active.length === 0) {
		return undefined;
	}
	if (active.length === 1) {
		return active[0];
	}
	return AbortSignal.any(active);
}

function writeFatalAndExit(message: string, exitCode: number): void {
	if (handlingFatalError) {
		exitCliProcess(exitCode);
		return;
	}
	handlingFatalError = true;
	process.stderr.write(`${message}\n`);
	exitCliProcess(exitCode);
}

export function installCliFatalErrorHandlers(): void {
	if (fatalHandlersInstalled) {
		return;
	}
	fatalHandlersInstalled = true;

	process.on("uncaughtException", (error) => {
		reportFatalError(error);
		writeFatalAndExit(`kanban: fatal: ${safeErrorMessage(error)}`, 1);
	});

	process.on("unhandledRejection", (reason) => {
		reportFatalError(reason);
		writeFatalAndExit(`kanban: fatal: ${safeErrorMessage(reason)}`, 1);
	});
}

function readCliTaskSubcommand(argv: readonly string[]): string | undefined {
	const taskCommandIndex = argv.findIndex((argument) => argument === "task" || argument === "tasks");
	return taskCommandIndex >= 0 ? argv[taskCommandIndex + 1] : undefined;
}

export function installCliTaskGroupWatchInterruptionGuard(
	argv: readonly string[],
): { signal: AbortSignal; dispose: () => void } | undefined {
	if (readCliTaskSubcommand(argv) !== "watch") return undefined;
	const controller = new AbortController();
	let interruptedShutdownTimeout: ReturnType<typeof setTimeout> | undefined;
	const interrupt = (signalName: "SIGINT" | "SIGTERM") => {
		if (controller.signal.aborted) return;
		const exitCode = signalName === "SIGTERM" ? 143 : 130;
		process.exitCode = exitCode;
		// watch 没有整命令硬超时；首次中断后，连同遥测和最终 pipe 排空一起限时退出。
		interruptedShutdownTimeout = setTimeout(
			() => exitCliProcess(exitCode),
			CLI_TASK_GROUP_WATCH_INTERRUPTED_SHUTDOWN_TIMEOUT_MS,
		);
		controller.abort(signalName);
	};
	const onSigint = () => interrupt("SIGINT");
	const onSigterm = () => interrupt("SIGTERM");
	process.on("SIGINT", onSigint);
	process.on("SIGTERM", onSigterm);
	return {
		signal: controller.signal,
		dispose: () => {
			clearTimeout(interruptedShutdownTimeout);
			process.removeListener("SIGINT", onSigint);
			process.removeListener("SIGTERM", onSigterm);
		},
	};
}

export function installCliHardTimeoutIfNeeded(argv: string[], isServerStyleInvocation: boolean): () => void {
	const taskSubcommand = readCliTaskSubcommand(argv);
	if (isServerStyleInvocation || taskSubcommand === "watch") {
		return () => {};
	}
	// 离线批量核验有自己的收口预算，默认允许输出已完成的部分结果。
	if (taskSubcommand === "audit-native-history" && resolveCliHardTimeoutOverrideMs() === undefined) {
		return () => {};
	}
	const timeoutMs = resolveCliHardTimeoutMs(argv);
	const timeoutHandle = setTimeout(() => {
		writeFatalAndExit(`kanban: fatal: command timed out after ${timeoutMs}ms`, 124);
	}, timeoutMs);
	return () => {
		clearTimeout(timeoutHandle);
	};
}
