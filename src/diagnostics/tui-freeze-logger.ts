// Minimal logging abstraction for the [tui-freeze] probe set used by the
// terminal stall detector, hydration recovery, Codex startup verification, and
// related diagnostics. Routes to process.stderr so messages survive the no-console
// lint rule and are visible in the Kanban server log without requiring users to
// opt into the optional cline-runtime-logger pipeline.

function emitLine(prefix: string, payload: string): void {
	try {
		process.stderr.write(`${prefix} ${payload}\n`);
	} catch {
		// Best-effort diagnostic logging only.
	}
}

export function logTuiFreezeWarning(payload: string): void {
	emitLine("[warn]", payload);
}

export function logTuiFreezeError(payload: string, cause?: unknown): void {
	emitLine("[error]", payload);
	if (cause instanceof Error && cause.stack) {
		try {
			process.stderr.write(`${cause.stack}\n`);
		} catch {
			// Best-effort diagnostic logging only.
		}
	}
}
