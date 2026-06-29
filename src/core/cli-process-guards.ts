const DEFAULT_CLI_HARD_TIMEOUT_MS = 35_000;
const DEFAULT_CLI_TRPC_TIMEOUT_MS = 28_000;
/** Subcommand shutdown flush budget — must fit inside HARD − TRPC margin. */
export const DEFAULT_CLI_TELEMETRY_FLUSH_MS = 500;

let fatalHandlersInstalled = false;
let handlingFatalError = false;
type CliProcessExit = (code: number) => never;
let cliProcessExit: CliProcessExit | null = null;

export function registerCliProcessExit(exit: CliProcessExit): void {
	cliProcessExit = exit;
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

export function resolveCliHardTimeoutMs(): number {
	return parsePositiveIntEnv("KANBAN_CLI_HARD_TIMEOUT_MS", DEFAULT_CLI_HARD_TIMEOUT_MS);
}

export function resolveCliTrpcTimeoutMs(): number {
	return parsePositiveIntEnv("KANBAN_CLI_TRPC_TIMEOUT_MS", DEFAULT_CLI_TRPC_TIMEOUT_MS);
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
		const seen = new WeakSet<object>();
		return JSON.stringify(
			value,
			(_key, nested) => {
				if (typeof nested === "object" && nested !== null) {
					if (seen.has(nested)) {
						return "[Circular]";
					}
					seen.add(nested);
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
		writeFatalAndExit(`kanban: fatal: ${safeErrorMessage(error)}`, 1);
	});

	process.on("unhandledRejection", (reason) => {
		writeFatalAndExit(`kanban: fatal: ${safeErrorMessage(reason)}`, 1);
	});
}

export function installCliHardTimeoutIfNeeded(_argv: string[], isServerStyleInvocation: boolean): () => void {
	if (isServerStyleInvocation) {
		return () => {};
	}
	const timeoutMs = resolveCliHardTimeoutMs();
	const timeoutHandle = setTimeout(() => {
		writeFatalAndExit(`kanban: fatal: command timed out after ${timeoutMs}ms`, 124);
	}, timeoutMs);
	return () => {
		clearTimeout(timeoutHandle);
	};
}
