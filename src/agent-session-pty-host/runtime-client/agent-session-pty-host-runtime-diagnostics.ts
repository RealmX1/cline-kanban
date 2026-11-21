import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readAgentSessionPtyHostPersistentPreferenceWithoutWritingConfig } from "../../config/runtime-config";
import {
	type AgentSessionPtyHostDiagnostics,
	agentSessionPtyHostDiagnosticsSchema,
	agentSessionPtyHostRecoveryProgressSchema,
	type RuntimePtySessionProcessOwnership,
} from "../../core/agent-session-pty-host-diagnostics-contract";
import { readPosixProcessResourceTable } from "../../diagnostics/posix-process-table-with-resource-columns-reader";
import { lockedFileSystem } from "../../fs/locked-file-system";
import { RUNTIME_LOADED_ENTRYPOINT_SHA256 } from "../../state/runtime-loaded-entrypoint-identity";
import type { AgentSessionPtyHostModeEnablementDecision } from "./agent-session-pty-host-mode-enablement";
import {
	type AgentSessionPtyHostRuntimeIdentity,
	listAgentSessionPtyHostGenerationSocketPaths,
} from "./agent-session-pty-host-socket-path-for-runtime-identity";
import { queryAgentSessionPtyHostReadOnlyStatus } from "./hosted-session-cli-client-requests-to-agent-session-pty-host";

let runtimeDiagnosticsProvider: (() => Promise<AgentSessionPtyHostDiagnostics>) | null = null;
let runtimePtySessionOwnershipProvider: (() => RuntimePtySessionProcessOwnership[]) | null = null;
let nonPtyAgentSessionOwnershipProvider:
	| (() => AgentSessionPtyHostDiagnostics["nonPtyAgentSessionsPreventingContinuity"])
	| null = null;
const diagnosticsChangedListeners = new Set<(revision: number) => void>();
let revision = 0;
let persistingSnapshot: Promise<void> | null = null;

export function agentSessionPtyHostDiagnosticsSnapshotPath(identity: AgentSessionPtyHostRuntimeIdentity): string {
	return join(
		identity.runtimeHomeDirectoryPath,
		"agent-session-pty-host",
		`p${identity.runtimePort}-runtime-diagnostics.json`,
	);
}

export function setRuntimePtySessionOwnershipProvider(provider: () => RuntimePtySessionProcessOwnership[]): void {
	runtimePtySessionOwnershipProvider = provider;
}

export function setNonPtyAgentSessionsPreventingContinuityProvider(
	provider: () => AgentSessionPtyHostDiagnostics["nonPtyAgentSessionsPreventingContinuity"],
): void {
	nonPtyAgentSessionOwnershipProvider = provider;
}

export function registerAgentSessionPtyHostRuntimeDiagnosticsProvider(
	provider: () => Promise<AgentSessionPtyHostDiagnostics>,
): void {
	runtimeDiagnosticsProvider = provider;
}

export async function queryCurrentRuntimeAgentSessionPtyHostDiagnostics(): Promise<AgentSessionPtyHostDiagnostics> {
	if (!runtimeDiagnosticsProvider) throw new Error("当前 runtime 未提供独立 PTY host 诊断");
	const report = await runtimeDiagnosticsProvider();
	return await withCurrentPersistentPreference({
		...report,
		// 只有正在应答的本 build 能做这个承诺。离线快照不补写，避免把旧证据看成新能力。
		enforcesAuthorizedUnretainableSessionHandoverBinding: true,
		acceptsPlannedHandoverRestartWithAuthorizedUnretainableSessions: true,
		runtimePtySessions: runtimePtySessionOwnershipProvider?.() ?? report.runtimePtySessions,
		nonPtyAgentSessionsPreventingContinuity:
			nonPtyAgentSessionOwnershipProvider?.() ?? report.nonPtyAgentSessionsPreventingContinuity,
	});
}

async function withCurrentPersistentPreference(
	report: AgentSessionPtyHostDiagnostics,
): Promise<AgentSessionPtyHostDiagnostics> {
	try {
		const preference = await readAgentSessionPtyHostPersistentPreferenceWithoutWritingConfig();
		return {
			...report,
			configuredPersistentPreference: preference ?? null,
			configuredPreferenceSource: preference ? "persistent_preference" : "default_enabled",
		};
	} catch (error) {
		return {
			...report,
			configuredPersistentPreference: null,
			configuredPreferenceSource: "configuration_read_error",
			configurationReadError: String(error),
		};
	}
}

export function subscribeToAgentSessionPtyHostDiagnosticsChanges(listener: (revision: number) => void): () => void {
	diagnosticsChangedListeners.add(listener);
	return () => diagnosticsChangedListeners.delete(listener);
}

export function notifyAgentSessionPtyHostDiagnosticsChanged(): void {
	if (!runtimeDiagnosticsProvider) return;
	revision += 1;
	for (const listener of diagnosticsChangedListeners) listener(revision);
	if (persistingSnapshot) return;
	const persistLatest = async () => {
		let persistedRevision: number;
		do {
			persistedRevision = revision;
			const report = await queryCurrentRuntimeAgentSessionPtyHostDiagnostics();
			await persistAgentSessionPtyHostDiagnostics(report);
		} while (persistedRevision !== revision);
	};
	persistingSnapshot = persistLatest().finally(() => {
		persistingSnapshot = null;
	});
	// 持久预算与 spawn 归属另有同步落盘；诊断快照写失败不得伪造就绪。
	void persistingSnapshot.catch((error: unknown) => {
		process.stderr.write(`[kanban][pty-host-diagnostics] 无法保存诊断快照：${String(error)}\n`);
	});
}

export async function persistAgentSessionPtyHostDiagnostics(report: AgentSessionPtyHostDiagnostics): Promise<void> {
	await lockedFileSystem.writeJsonFileAtomic(
		agentSessionPtyHostDiagnosticsSnapshotPath(report.runtimeIdentity),
		report,
		// 此文件只有身份已认领的 runtime 写入；沿用原子写，避免崩溃遗留 advisory 锁阻塞下一代诊断。
		{ lock: null, durable: true, fileMode: 0o600 },
	);
}

export function createAgentSessionPtyHostDiagnosticsReport(input: {
	runtimeIdentity: AgentSessionPtyHostRuntimeIdentity;
	startupDecision: AgentSessionPtyHostModeEnablementDecision | null;
	runtimeProcessStartTimeText?: string | null;
	configurationReadError?: string | null;
}): AgentSessionPtyHostDiagnostics {
	return {
		reportGeneratedAtEpochMs: Date.now(),
		runtimeIdentity: input.runtimeIdentity,
		runtimeProcessId: process.pid,
		runtimeProcessStartTimeText: input.runtimeProcessStartTimeText ?? null,
		runtimeLoadedEntrypointSha256: RUNTIME_LOADED_ENTRYPOINT_SHA256,
		runtimeProcessStatus: "running",
		startupDecision: input.startupDecision,
		configurationReadError: input.configurationReadError ?? null,
		configuredPersistentPreference: input.startupDecision?.persistentPreference ?? null,
		configuredPreferenceSource: input.configurationReadError
			? "configuration_read_error"
			: input.startupDecision?.persistentPreference
				? "persistent_preference"
				: "default_enabled",
		newSessionHostingMode: input.configurationReadError
			? "ownership_unknown"
			: input.startupDecision?.canAdoptExistingHostedSessions === false
				? "unsupported"
				: "disabled",
		currentGenerationSocketPath: null,
		nextReadOnlyHostProbeAtEpochMs: null,
		recoveryProgress: null,
		generations: [],
		runtimePtySessions: [],
		nonPtyAgentSessionsPreventingContinuity: [],
		pendingHostedSessionSpawnOwnership: [],
	};
}

// 离线只读路径：旧快照是历史证据；当前缺少所属 runtime 响应时不能据它放行部署。
export async function queryAgentSessionPtyHostDiagnosticsWithoutRuntime(
	identity: AgentSessionPtyHostRuntimeIdentity,
): Promise<AgentSessionPtyHostDiagnostics> {
	let report = createAgentSessionPtyHostDiagnosticsReport({ runtimeIdentity: identity, startupDecision: null });
	try {
		report = agentSessionPtyHostDiagnosticsSchema.parse(
			JSON.parse(await readFile(agentSessionPtyHostDiagnosticsSnapshotPath(identity), "utf8")),
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			report.configurationReadError = `无法读取诊断快照：${String(error)}`;
	}
	let runtimeStillPresent = false;
	try {
		const processes = await readPosixProcessResourceTable();
		runtimeStillPresent = processes.some(
			(entry) =>
				entry.processId === report.runtimeProcessId &&
				entry.processStartTimeText === report.runtimeProcessStartTimeText,
		);
	} catch {
		runtimeStillPresent = true;
	}
	if (!report.recoveryProgress && report.startupDecision?.agentSessionPtyHostModeEnabled !== false) {
		for (const evidenceKind of ["current-generation-readiness-recovery", "generation-discovery-recovery"]) {
			try {
				report.recoveryProgress = agentSessionPtyHostRecoveryProgressSchema.parse(
					JSON.parse(
						await readFile(
							join(
								identity.runtimeHomeDirectoryPath,
								"agent-session-pty-host",
								`p${identity.runtimePort}-${evidenceKind}.json`,
							),
							"utf8",
						),
					),
				);
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT")
					report.configurationReadError = `恢复证据不可读：${String(error)}`;
			}
		}
	}
	return await withCurrentPersistentPreference({
		...report,
		reportGeneratedAtEpochMs: Date.now(),
		runtimeIdentity: identity,
		runtimeProcessStatus: runtimeStillPresent ? "unknown" : "offline",
		newSessionHostingMode: "runtime_offline",
		runtimePtySessions: report.runtimePtySessions.map((session) => ({ ...session, ownership: "ownership_unknown" })),
		generations: await Promise.all(
			listAgentSessionPtyHostGenerationSocketPaths(identity).map(async (socketPath) => {
				const status = await queryAgentSessionPtyHostReadOnlyStatus({ agentSessionPtyHostSocketPath: socketPath });
				return "hostProcessId" in status
					? {
							socketPath,
							observationSource: "readonly_host_query" as const,
							readiness: "ready" as const,
							failureMessage: null,
							hostStatus: status,
						}
					: {
							socketPath,
							observationSource: "unavailable" as const,
							readiness: status.noHostIsListening ? ("not_listening" as const) : ("unknown" as const),
							failureMessage: status.failureMessage,
							hostStatus: null,
						};
			}),
		),
	});
}
