// agent / 脚本在 hosted 会话里调用的 `kanban task …` 等 CLI：runtime 热重启的那几秒里，请求会撞上 ECONNREFUSED。
// 以前直接把错误报给 agent，agent 往往据此放弃或改走别的路；现在只要有「runtime 正在重启」的证据，就等它回来再发。
//
// 只重试「确定没发出」的请求（ECONNREFUSED：TCP 连接都没建立），所以对任何 procedure 都安全；
// 发出后才失败的（reset / 超时）不在这里重试——服务端可能已经应用了。

import {
	queryAgentSessionPtyHostControllerPresence,
	readHostedSessionBindingToAgentSessionPtyHostFromEnvironment,
} from "../agent-session-pty-host/runtime-client/hosted-session-cli-client-requests-to-agent-session-pty-host";

// EXPERIMENT_NODE: 等 runtime 重启回来的上限；超过就照旧报错（runtime 可能是真停了）。
export const MAXIMUM_WAIT_FOR_RESTARTING_KANBAN_RUNTIME_MS = 60_000;
// controller（runtime）离开 host 不超过这么久才算「正在重启」；更久就是 runtime 停着、没人会回来。
const KANBAN_RUNTIME_RESTART_EVIDENCE_CONTROLLER_ABSENCE_WINDOW_MS = 90_000;
const RETRY_INTERVAL_WHILE_KANBAN_RUNTIME_RESTARTS_MS = 500;
const AGENT_SESSION_PTY_HOST_PRESENCE_QUERY_DEADLINE_MS = 1_000;

// 「runtime 根本不在监听」：请求确定没发出（ECONNREFUSED 藏在 fetch 错误的 cause 链里，tRPC 可能再包一层）。
export function isRuntimeConnectionRefusedTransportError(transportError: unknown): boolean {
	let current: unknown = transportError;
	for (let depth = 0; depth < 6 && current !== null && typeof current === "object"; depth += 1) {
		if ((current as { code?: unknown }).code === "ECONNREFUSED") {
			return true;
		}
		current = (current as { cause?: unknown }).cause;
	}
	return false;
}

// 有证据时返回一句给人看的说明，没有证据返回 null。证据只来自本会话的 agent session PTY host：
//   - host 有 controller 连着：新 runtime 已连上 host、正在接管，HTTP 还没开始监听；
//   - controller 刚离开不久：旧 runtime 刚退出，新 runtime 还没连上。
// 不在 hosted 会话里（没有 host 绑定）就没有证据，行为与以前一样。
export async function readKanbanRuntimeRestartInProgressEvidence(
	environment: NodeJS.ProcessEnv,
	nowEpochMs: number,
): Promise<string | null> {
	const hostedSessionBinding = readHostedSessionBindingToAgentSessionPtyHostFromEnvironment(environment);
	if (hostedSessionBinding === null) {
		return null;
	}
	const presence = await queryAgentSessionPtyHostControllerPresence({
		agentSessionPtyHostSocketPath: hostedSessionBinding.agentSessionPtyHostSocketPath,
		responseDeadlineMilliseconds: AGENT_SESSION_PTY_HOST_PRESENCE_QUERY_DEADLINE_MS,
	});
	if ("kind" in presence) {
		return null;
	}
	if (presence.controllerConnected) {
		return "新的 runtime 已连上 agent session PTY host，尚未开始监听";
	}
	if (
		presence.controllerAbsentSinceEpochMs !== null &&
		nowEpochMs - presence.controllerAbsentSinceEpochMs <= KANBAN_RUNTIME_RESTART_EVIDENCE_CONTROLLER_ABSENCE_WINDOW_MS
	) {
		return `runtime 已离开 ${Math.round((nowEpochMs - presence.controllerAbsentSinceEpochMs) / 1000)}s`;
	}
	return null;
}

export interface CliRuntimeRequestRetryWhileKanbanRuntimeRestartsDependencies {
	readNowEpochMs: () => number;
	sleep: (milliseconds: number) => Promise<void>;
	writeStderr: (text: string) => void;
	readKanbanRuntimeRestartInProgressEvidence: (nowEpochMs: number) => Promise<string | null>;
}

const DEFAULT_DEPENDENCIES: CliRuntimeRequestRetryWhileKanbanRuntimeRestartsDependencies = {
	readNowEpochMs: Date.now,
	sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
	writeStderr: (text) => {
		process.stderr.write(text);
	},
	readKanbanRuntimeRestartInProgressEvidence: (nowEpochMs) =>
		readKanbanRuntimeRestartInProgressEvidence(process.env, nowEpochMs),
};

export async function retryCliRuntimeRequestWhileKanbanRuntimeRestarts<Result>(
	performRuntimeRequest: () => Promise<Result>,
	dependencies: CliRuntimeRequestRetryWhileKanbanRuntimeRestartsDependencies = DEFAULT_DEPENDENCIES,
): Promise<Result> {
	const waitStartedAtEpochMs = dependencies.readNowEpochMs();
	let announcedWaitingForRestartingRuntime = false;
	while (true) {
		try {
			return await performRuntimeRequest();
		} catch (requestError) {
			if (!isRuntimeConnectionRefusedTransportError(requestError)) {
				throw requestError;
			}
			const nowEpochMs = dependencies.readNowEpochMs();
			if (nowEpochMs - waitStartedAtEpochMs >= MAXIMUM_WAIT_FOR_RESTARTING_KANBAN_RUNTIME_MS) {
				throw requestError;
			}
			const restartEvidence = await dependencies.readKanbanRuntimeRestartInProgressEvidence(nowEpochMs);
			if (restartEvidence === null) {
				throw requestError;
			}
			if (!announcedWaitingForRestartingRuntime) {
				announcedWaitingForRestartingRuntime = true;
				dependencies.writeStderr(
					`[kanban] Kanban runtime 正在重启（${restartEvidence}），最多等待 ${MAXIMUM_WAIT_FOR_RESTARTING_KANBAN_RUNTIME_MS / 1000}s 后重试…\n`,
				);
			}
			await dependencies.sleep(RETRY_INTERVAL_WHILE_KANBAN_RUNTIME_RESTARTS_MS);
		}
	}
}
