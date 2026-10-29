// 必须先于 workspace registry 和任何 PTY：启动偏好只读一次，保存设置不自动切换存量进程。
import { loadGlobalRuntimeConfig } from "../../config/runtime-config";
import { getKanbanRuntimePort, isKanbanRemoteHost } from "../../core/runtime-endpoint";
import { readPosixProcessResourceTable } from "../../diagnostics/posix-process-table-with-resource-columns-reader";
import { getRuntimeHomePath } from "../../state/runtime-home-path";
import {
	KANBAN_AGENT_SESSION_PTY_HOST_MODE_ENVIRONMENT_VARIABLE_NAME,
	resolveAgentSessionPtyHostModeEnablement,
} from "./agent-session-pty-host-mode-enablement";
import {
	createAgentSessionPtyHostDiagnosticsReport,
	persistAgentSessionPtyHostDiagnostics,
	queryCurrentRuntimeAgentSessionPtyHostDiagnostics,
	registerAgentSessionPtyHostRuntimeDiagnosticsProvider,
} from "./agent-session-pty-host-runtime-diagnostics";
import {
	AgentSessionPtyHostPreventsSafeRuntimeStartupError,
	AgentSessionPtyHostRuntimeFacade,
} from "./agent-session-pty-host-runtime-facade";
import { listAgentSessionPtyHostGenerationSocketPaths } from "./agent-session-pty-host-socket-path-for-runtime-identity";
import { queryAgentSessionPtyHostReadOnlyStatus } from "./hosted-session-cli-client-requests-to-agent-session-pty-host";

export async function startAgentSessionPtyHostRuntimeFacadeWhenEnabled(input: {
	runtimePortWasAutoSelected: boolean;
	warn: (message: string) => void;
}): Promise<AgentSessionPtyHostRuntimeFacade | null> {
	const runtimeIdentity = { runtimeHomeDirectoryPath: getRuntimeHomePath(), runtimePort: getKanbanRuntimePort() };
	let config: Awaited<ReturnType<typeof loadGlobalRuntimeConfig>>;
	try {
		config = await loadGlobalRuntimeConfig();
	} catch (error) {
		await persistAgentSessionPtyHostDiagnostics(
			createAgentSessionPtyHostDiagnosticsReport({
				runtimeIdentity,
				startupDecision: null,
				configurationReadError: String(error),
			}),
		);
		throw error;
	}
	const enablement = resolveAgentSessionPtyHostModeEnablement({
		agentSessionPtyHostEnablementPreference: config.agentSessionPtyHostEnablementPreference,
		agentSessionPtyHostModeEnvironmentValue:
			process.env[KANBAN_AGENT_SESSION_PTY_HOST_MODE_ENVIRONMENT_VARIABLE_NAME],
		kanbanDesktopEnvironmentValue: process.env.KANBAN_DESKTOP,
		runtimePortWasAutoSelected: input.runtimePortWasAutoSelected,
		runtimeServesRemoteHost: isKanbanRemoteHost(),
		platform: process.platform,
	});
	if (enablement.disabledReason)
		input.warn(JSON.stringify({ event: "agent_session_pty_host_disabled", ...enablement }));
	if (!enablement.canAdoptExistingHostedSessions && process.platform !== "win32") {
		for (const socketPath of listAgentSessionPtyHostGenerationSocketPaths(runtimeIdentity)) {
			const status = await queryAgentSessionPtyHostReadOnlyStatus({ agentSessionPtyHostSocketPath: socketPath });
			if (
				"hostProcessId" in status
					? status.hostedSessions.some((session) => !session.exited)
					: !status.noHostIsListening
			) {
				await persistAgentSessionPtyHostDiagnostics(
					createAgentSessionPtyHostDiagnosticsReport({ runtimeIdentity, startupDecision: enablement }),
				);
				throw new AgentSessionPtyHostPreventsSafeRuntimeStartupError(
					`当前启动方式 ${enablement.disabledReason} 不能接管原 host；保留会话，等待原会话自然结束或恢复受支持的启动方式：${socketPath}`,
				);
			}
		}
	}
	const facade = enablement.canAdoptExistingHostedSessions
		? await AgentSessionPtyHostRuntimeFacade.start({
				runtimeIdentity,
				warn: input.warn,
				startupDecision: enablement,
				newHostedSessionsEnabled: enablement.agentSessionPtyHostModeEnabled,
				recoveryConfigurationEvidenceFilePath: config.globalConfigPath,
			})
		: null;
	const baseline = createAgentSessionPtyHostDiagnosticsReport({ runtimeIdentity, startupDecision: enablement });
	try {
		baseline.runtimeProcessStartTimeText =
			(await readPosixProcessResourceTable()).find((entry) => entry.processId === process.pid)
				?.processStartTimeText ?? null;
	} catch {
		/* 不支持的平台仍可报告限制；没有 OS 身份时保留 null。 */
	}
	registerAgentSessionPtyHostRuntimeDiagnosticsProvider(async () =>
		facade ? facade.queryDiagnostics() : { ...baseline, reportGeneratedAtEpochMs: Date.now() },
	);
	await persistAgentSessionPtyHostDiagnostics(await queryCurrentRuntimeAgentSessionPtyHostDiagnostics());
	return facade;
}

export {
	notifyAgentSessionPtyHostDiagnosticsChanged,
	setNonPtyAgentSessionsPreventingContinuityProvider,
	setRuntimePtySessionOwnershipProvider,
} from "./agent-session-pty-host-runtime-diagnostics";
