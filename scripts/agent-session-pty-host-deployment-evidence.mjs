import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { readLegacyRuntimeQuiescenceEvidence } from "./agent-session-pty-host-legacy-deployment-inventory.mjs";

const execFileAsync = promisify(execFile);
export const normalizePosixProcessStartTimeText = (value) => value?.trim().split(/\s+/u).join(" ") ?? null;

export function resolveAgentSessionPtyHostRuntimeOrigin() {
	const host = process.env.KANBAN_RUNTIME_HOST || "127.0.0.1";
	const port = process.env.KANBAN_RUNTIME_PORT || "3484";
	return `${process.env.KANBAN_RUNTIME_HTTPS === "1" ? "https" : "http"}://${host}:${port}`;
}

export async function readLiveAgentSessionPtyHostDeploymentEvidence({ allowLegacyQuiescentStartupEvidence = false } = {}) {
	const origin = resolveAgentSessionPtyHostRuntimeOrigin();
	const response = await fetch(`${origin}/api/trpc/runtime.getAgentSessionPtyHostDiagnostics`, { signal: AbortSignal.timeout(5_000) });
	const envelope = await response.json();
	if (!response.ok) {
		if (allowLegacyQuiescentStartupEvidence && response.status === 404 && envelope.error?.data?.code === "NOT_FOUND") {
			const legacyInventory = await readLegacyRuntimeQuiescenceEvidence({ origin, runtimeHomeDirectoryPath: join(homedir(), ".cline", "kanban"), readRuntimeProcedure: async (procedure, workspaceId) => {
				const response = await fetch(`${origin}/api/trpc/${procedure}`, { headers: workspaceId ? { "x-kanban-workspace-id": workspaceId } : {}, signal: AbortSignal.timeout(5_000) });
				if (!response.ok) throw new Error(`${procedure} HTTP ${response.status}`);
				return (await response.json()).result?.data;
			} });
			return { legacyInventory };
		}
		throw new Error(`所属 runtime 未提供只读托管诊断：HTTP ${response.status}`);
	}
	const report = envelope.result?.data;
	if (!report || report.runtimeProcessStatus !== "running" || !Array.isArray(report.runtimePtySessions) || !Array.isArray(report.nonPtyAgentSessionsPreventingContinuity)) throw new Error("诊断契约不完整，保留 unknown；HTTP 200 不能证明会话可接管");
	const expectedRuntimeHome = join(homedir(), ".cline", "kanban");
	if (report.runtimeIdentity?.runtimeHomeDirectoryPath !== expectedRuntimeHome || report.runtimeIdentity?.runtimePort !== Number(new URL(origin).port)) throw new Error("运行实例的 home 或端口与本次检查身份不一致");
	const { stdout } = await execFileAsync("ps", ["-Ao", "pid=,lstart="], { env: { ...process.env, LC_ALL: "C", LANG: "C" }, timeout: 5_000, maxBuffer: 8 * 1024 * 1024 });
	const processStartTimeByPid = new Map(stdout.split("\n").flatMap((line) => {
		const match = /^\s*(\d+)\s+(.+?)\s*$/u.exec(line);
		return match ? [[Number(match[1]), normalizePosixProcessStartTimeText(match[2])]] : [];
	}));
	return { report, processStartTimeByPid };
}

export function assessAgentSessionPtyHostDeploymentEvidence({ report, processStartTimeByPid, legacyInventory }, { requireAllSessionsPreservable = false, expectedRuntimeProcessId } = {}) {
	if (legacyInventory) {
		if (expectedRuntimeProcessId !== undefined && legacyInventory.runtimeProcessId !== expectedRuntimeProcessId) return { ...legacyInventory, ok: false, failures: [...legacyInventory.failures, "旧版端口当前属于另一 runtime"] };
		return legacyInventory;
	}
	const failures = [];
	const blockingSessions = [];
	if (expectedRuntimeProcessId !== undefined && report.runtimeProcessId !== expectedRuntimeProcessId) failures.push("端口当前属于另一 runtime，拒绝把它当作本次启动结果");
	if (!report.runtimeProcessStartTimeText || normalizePosixProcessStartTimeText(processStartTimeByPid.get(report.runtimeProcessId)) !== normalizePosixProcessStartTimeText(report.runtimeProcessStartTimeText)) failures.push("runtime 的当前进程启动身份无法核对");
	if (report.configurationReadError) failures.push(report.configurationReadError);
	if (!report.startupDecision || ["ownership_unknown", "runtime_offline", "in_process_pty"].includes(report.newSessionHostingMode)) failures.push(`实际模式 ${report.newSessionHostingMode}，未满足所选启动意图`);
	if (report.startupDecision?.disabledReason === "invalid_environment_override") failures.push("临时启用变量无效，不能视为用户显式关闭");
	if (report.pendingHostedSessionSpawnOwnership?.length) failures.push("存在创建归属未知的 hosted 会话，禁止重复启动或停止原 runtime");
	for (const generation of report.generations) {
		if (generation.readiness === "unknown") failures.push(`generation ${generation.socketPath} 的当前状态 unknown`);
		for (const hostedSession of generation.hostStatus?.hostedSessions ?? []) {
			if (!hostedSession.exited && !report.runtimePtySessions.some((session) => session.hostedSessionKey === hostedSession.hostedSessionKey && session.hostSocketPath === generation.socketPath && session.processId === hostedSession.processId && session.workspaceId === hostedSession.workspaceId && session.conversationSessionId === hostedSession.conversationSessionId)) failures.push(`hosted 会话 ${hostedSession.workspaceId}/${hostedSession.conversationSessionId} 尚未接回所属 runtime`);
		}
	}
	const validatedHostedSessions = [];
	for (const session of report.runtimePtySessions) {
		if (session.ownership !== "independent_host") {
			blockingSessions.push({ ...session, recoveryCondition: "该活会话自然结束后重新核验" });
			continue;
		}
		const generation = report.generations.find((entry) => entry.socketPath === session.hostSocketPath);
		const host = generation?.hostStatus;
		const hostedSession = host?.hostedSessions.find((entry) => entry.hostedSessionKey === session.hostedSessionKey && !entry.exited);
		const hostStartTimeText = host ? processStartTimeByPid.get(host.hostProcessId) : null;
		const sessionStartTimeText = processStartTimeByPid.get(session.processId);
		if (generation?.readiness !== "ready" || !host || host.controllerProcessId !== report.runtimeProcessId || !hostStartTimeText || !sessionStartTimeText || !hostedSession || hostedSession.processId !== session.processId || hostedSession.processStartedAtEpochMs !== session.processStartedAtEpochMs || !hostedSession.adoptionRecordPresent) {
			failures.push(`会话 ${session.workspaceId}/${session.conversationSessionId} 缺少当前 host 响应、进程身份或待接管记录`);
			continue;
		}
		validatedHostedSessions.push({ ...session, hostedSessionKind: hostedSession.hostedSessionKind, processStartTimeText: sessionStartTimeText, hostProcessId: host.hostProcessId, hostProcessStartTimeText: hostStartTimeText, hostStartedAtEpochMs: host.hostStartedAtEpochMs, hostProcessInstanceId: host.hostProcessInstanceId, hostProcessIdentityEvidenceSource: generation.observationSource, hostBuildIdentity: host.hostBuildIdentity, outputEndByteOffset: hostedSession.outputEndByteOffset });
	}
	blockingSessions.push(...report.nonPtyAgentSessionsPreventingContinuity.map((session) => ({ ...session, recoveryCondition: "该非 PTY 会话自然结束后重新核验" })));
	if (requireAllSessionsPreservable && blockingSessions.length) failures.push(`${blockingSessions.length} 条活会话不能跨本次 runtime 退出保留，等待自然结束`);
	if (report.newSessionHostingMode === "independent_host") {
		const current = report.generations.find((entry) => entry.socketPath === report.currentGenerationSocketPath);
		if (current?.readiness !== "ready" || current.hostStatus?.controllerProcessId !== report.runtimeProcessId || current.hostStatus?.hostLifecycleState !== "serving" || !processStartTimeByPid.has(current.hostStatus.hostProcessId)) failures.push("当前 generation 没有以所属 runtime 为 controller 的活 host 响应");
	}
	return { ok: failures.length === 0, checkedAtEpochMs: Date.now(), runtimeIdentity: report.runtimeIdentity, runtimeProcessId: report.runtimeProcessId, runtimeProcessStartTimeText: report.runtimeProcessStartTimeText, configuredPersistentPreference: report.configuredPersistentPreference, startupDecision: report.startupDecision, newSessionHostingMode: report.newSessionHostingMode, failures, blockingSessions, validatedHostedSessions };
}

export function compareHostedSessionContinuityAcrossRuntimeRestart(before, after) {
	if (before.runtimeIdentity.runtimeHomeDirectoryPath !== after.runtimeIdentity.runtimeHomeDirectoryPath || before.runtimeIdentity.runtimePort !== after.runtimeIdentity.runtimePort) return ["前后证据不属于同一个 runtime 身份"];
	if (before.runtimeProcessId === after.runtimeProcessId && normalizePosixProcessStartTimeText(before.runtimeProcessStartTimeText) === normalizePosixProcessStartTimeText(after.runtimeProcessStartTimeText)) return ["尚未观察到 runtime 进程代际变化"];
	if (!before.validatedHostedSessions.length) return ["部署前没有可观察的活 hosted 会话，不能声称连续性已验证"];
	const failures = [...after.failures];
	for (const original of before.validatedHostedSessions) {
		if (["workspaceId", "conversationSessionId", "hostedSessionKey", "hostedSessionKind", "processId", "processStartedAtEpochMs", "processStartTimeText", "hostProcessId", "hostProcessStartTimeText", "hostStartedAtEpochMs"].some((field) => original[field] === undefined || original[field] === null) || (original.hostProcessInstanceId == null && original.hostProcessIdentityEvidenceSource !== "own_controller_connection") || (original.hostedSessionKind === "task_agent_session" && (!original.runtimeSessionIncarnationId || !original.nativeConversationSessionId))) {
			failures.push(`原会话 ${original.conversationSessionId} 的基线身份字段不完整`);
			continue;
		}
		const current = after.validatedHostedSessions.find((session) => session.workspaceId === original.workspaceId && session.conversationSessionId === original.conversationSessionId && session.hostedSessionKey === original.hostedSessionKey);
		if (!current || ["processId", "processStartedAtEpochMs", "processStartTimeText", "runtimeSessionIncarnationId", "nativeConversationSessionId", "hostProcessId", "hostProcessStartTimeText", "hostStartedAtEpochMs", "hostProcessInstanceId"].some((field) => field.endsWith("StartTimeText") ? normalizePosixProcessStartTimeText(current[field]) !== normalizePosixProcessStartTimeText(original[field]) : current[field] !== original[field])) failures.push(`原会话 ${original.workspaceId}/${original.conversationSessionId} 的进程或会话身份未连续`);
		else if (current.outputEndByteOffset < original.outputEndByteOffset) failures.push(`原会话 ${original.conversationSessionId} 输出水位回退`);
	}
	return failures;
}

export function observeHostedSessionIoProgressAfterRuntimeRestart(before, after, afterRestartObservationStartingPoint) {
	const earliestAcceptedInputAtEpochMs = Math.max(before.checkedAtEpochMs ?? 0, Date.parse(after.runtimeProcessStartTimeText) || 0);
	const startingPointMatchesCurrentRuntime = Number.isSafeInteger(after.runtimeProcessId) && after.runtimeProcessId > 0 && !!after.runtimeProcessStartTimeText && afterRestartObservationStartingPoint?.runtimeProcessId === after.runtimeProcessId && normalizePosixProcessStartTimeText(afterRestartObservationStartingPoint?.runtimeProcessStartTimeText) === normalizePosixProcessStartTimeText(after.runtimeProcessStartTimeText);
	return before.validatedHostedSessions.map((original) => {
		const current = after.validatedHostedSessions.find((session) => session.hostedSessionKey === original.hostedSessionKey && session.workspaceId === original.workspaceId && session.conversationSessionId === original.conversationSessionId);
		const startingSession = startingPointMatchesCurrentRuntime ? afterRestartObservationStartingPoint.validatedHostedSessions.find((session) => session.hostedSessionKey === original.hostedSessionKey && session.workspaceId === original.workspaceId && session.conversationSessionId === original.conversationSessionId) : null;
		return { workspaceId: original.workspaceId, conversationSessionId: original.conversationSessionId,
			outputProgressObserved: !!current && !!startingSession && current.outputEndByteOffset > startingSession.outputEndByteOffset && current.currentRuntimeDeliveredHostedOutputEndByteOffset > startingSession.outputEndByteOffset,
			nativeInputAcceptanceObserved: original.hostedSessionKind === "shell_session" ? null : !!original.nativeConversationSessionId && !!current && !!current.mostRecentPromptSubmissionId && current.mostRecentPromptSubmissionId !== original.mostRecentPromptSubmissionId && current.mostRecentNativePromptAcceptedAtEpochMs > earliestAcceptedInputAtEpochMs,
		};
	});
}
