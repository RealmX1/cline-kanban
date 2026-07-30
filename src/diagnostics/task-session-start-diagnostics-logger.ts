import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const TASK_SESSION_START_DIAGNOSTICS_DIRECTORY_NAME = "task-session-start-diagnostics";
const TASK_SESSION_START_DIAGNOSTICS_FILE_NAME = "task-session-start-diagnostics.log";

export type TaskSessionStartDiagnosticEvent = "runtime_started" | "response_ready" | "failed";

export interface TaskSessionStartDiagnosticRecord {
	event: TaskSessionStartDiagnosticEvent;
	workspaceId: string;
	taskId: string;
	requestedAgentId: string | null;
	effectiveAgentId: string | null;
	phase: string;
	elapsedMs: number;
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
		`phase=${record.phase}`,
		`elapsedMs=${record.elapsedMs}`,
		`session=${JSON.stringify(record.session)}`,
		`error=${JSON.stringify(record.error)}`,
	].join(" ");
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
