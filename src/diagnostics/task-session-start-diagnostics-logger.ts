import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const TASK_SESSION_START_DIAGNOSTICS_DIRECTORY_NAME = "task-session-start-diagnostics";
const TASK_SESSION_START_DIAGNOSTICS_FILE_NAME = "task-session-start-diagnostics.log";

export type TaskSessionStartDiagnosticEvent =
	| "runtime_started"
	| "response_ready"
	| "failed"
	| "phase_completed"
	| "phase_failed";

export interface TaskSessionStartDiagnosticRecord {
	event: TaskSessionStartDiagnosticEvent;
	workspaceId: string;
	taskId: string;
	requestedAgentId: string | null;
	effectiveAgentId: string | null;
	requestedTerminalColumns?: number | null;
	requestedTerminalRows?: number | null;
	phase: string;
	elapsedMs: number;
	phaseDurationMs?: number;
	runtimeSessionIncarnationId?: string;
	error: string | null;
	session: {
		state: string;
		turnOwner: string | null;
		liveness: string;
		pid: number | null;
		startedAt: number | null;
		updatedAt: number;
	} | null;
}

export function getTaskSessionStartDiagnosticsLogPath(): string {
	return join(
		homedir(),
		".cline",
		"kanban",
		TASK_SESSION_START_DIAGNOSTICS_DIRECTORY_NAME,
		TASK_SESSION_START_DIAGNOSTICS_FILE_NAME,
	);
}

export function formatTaskSessionStartDiagnosticLine(
	record: TaskSessionStartDiagnosticRecord,
	isoTimestamp: string,
): string {
	return [
		isoTimestamp,
		`event=${record.event}`,
		`workspaceId=${record.workspaceId}`,
		`taskId=${record.taskId}`,
		`requestedAgentId=${record.requestedAgentId ?? "(default)"}`,
		`effectiveAgentId=${record.effectiveAgentId ?? "(unresolved)"}`,
		`requestedTerminalColumns=${record.requestedTerminalColumns ?? null}`,
		`requestedTerminalRows=${record.requestedTerminalRows ?? null}`,
		`phase=${record.phase}`,
		`elapsedMs=${record.elapsedMs}`,
		...(record.phaseDurationMs === undefined ? [] : [`phaseDurationMs=${record.phaseDurationMs}`]),
		...(record.runtimeSessionIncarnationId
			? [`runtimeSessionIncarnationId=${record.runtimeSessionIncarnationId}`]
			: []),
		`session=${JSON.stringify(record.session)}`,
		`error=${JSON.stringify(record.error)}`,
	].join(" ");
}

export async function measureTaskSessionStartupPhase<T>(
	context: Pick<
		TaskSessionStartDiagnosticRecord,
		"workspaceId" | "taskId" | "requestedAgentId" | "effectiveAgentId" | "phase" | "runtimeSessionIncarnationId"
	>,
	run: () => Promise<T>,
): Promise<T> {
	const startedAt = performance.now();
	let error: string | null = null;
	try {
		return await run();
	} catch (failure) {
		error = failure instanceof Error ? failure.message : String(failure);
		throw failure;
	} finally {
		const phaseDurationMs = Math.round(performance.now() - startedAt);
		void recordTaskSessionStartDiagnostic({
			...context,
			event: error === null ? "phase_completed" : "phase_failed",
			elapsedMs: phaseDurationMs,
			phaseDurationMs,
			error,
			session: null,
		});
	}
}

export async function recordTaskSessionStartDiagnostic(record: TaskSessionStartDiagnosticRecord): Promise<void> {
	const line = formatTaskSessionStartDiagnosticLine(record, new Date().toISOString());
	try {
		process.stderr.write(`[task-session-start] ${line}\n`);
	} catch {
		// Best-effort diagnostic logging only.
	}
	try {
		const logPath = getTaskSessionStartDiagnosticsLogPath();
		await mkdir(dirname(logPath), { recursive: true });
		await appendFile(logPath, `${line}\n`, "utf8");
	} catch {
		// Best-effort persistence only.
	}
}
