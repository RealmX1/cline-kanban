import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { withRunningCodexAppServerControlSocketConnection } from "../codex-native-session-protocol/codex-app-server-control-socket-request-connection";
import type { CodexAppServerRequestPort } from "../codex-native-session-protocol/codex-native-conversation-history";
import type {
	RuntimeExitCodexTaskConversationSessionPlanModeResponse,
	RuntimeTaskSessionSummary,
} from "../core/api-contract";
import { isAgentAwaitingModalUserDecision, resolveSessionFacets } from "../core/session-activity";

const loadedThreadPageSchema = z.object({ data: z.array(z.string()), nextCursor: z.string().nullable() });
const nativeThreadSchema = z.object({
	id: z.string(),
	cwd: z.string().min(1),
	status: z.object({ type: z.string() }),
});
const nativeThreadSettingsSchema = z.object({
	thread: nativeThreadSchema,
	model: z.string().min(1),
	reasoningEffort: z.string().nullable(),
	collaborationMode: z.object({ mode: z.string() }).nullish(),
});

async function isNativeThreadLoaded(
	port: CodexAppServerRequestPort,
	nativeSessionId: string,
	isCurrent: () => boolean,
): Promise<boolean> {
	let cursor: string | null = null;
	const seenCursors = new Set<string>();
	for (let pageIndex = 0; pageIndex < 10 && isCurrent(); pageIndex += 1) {
		const page = loadedThreadPageSchema.parse(await port.request("thread/loaded/list", { cursor, limit: 100 }));
		if (page.data.includes(nativeSessionId)) return true;
		cursor = page.nextCursor;
		if (cursor === null || seenCursors.has(cursor)) return false;
		seenCursors.add(cursor);
	}
	return false;
}

async function canonicalWorkingDirectory(path: string): Promise<string> {
	return realpath(path).catch(() => resolve(path));
}

export async function exitCodexNativeConversationPlanMode(input: {
	workspaceId: string;
	summary: RuntimeTaskSessionSummary;
	getCurrentLiveSummary: () => RuntimeTaskSessionSummary | null;
}): Promise<RuntimeExitCodexTaskConversationSessionPlanModeResponse> {
	const { summary } = input;
	const endpoint = summary.codexNativeSessionControlEndpoint;
	const identity = summary.agentNativeConversationSessionIdentity;
	if (
		summary.agentId !== "codex" ||
		!summary.workspacePath ||
		identity?.sourceAgentId !== "codex" ||
		!identity.nativeSessionId ||
		!endpoint ||
		endpoint.workspaceId !== input.workspaceId ||
		endpoint.conversationSessionId !== summary.taskId ||
		endpoint.runtimeSessionIncarnationId !== summary.runtimeSessionIncarnationId
	)
		return { status: "rejected", error: "当前会话缺少匹配的 Codex 原生控制端点，请恢复会话后重试。" };

	const isCurrent = () => {
		const current = input.getCurrentLiveSummary();
		return (
			current?.agentId === "codex" &&
			current.taskId === summary.taskId &&
			current.taskConversationSessionMetadata?.workspaceTaskId ===
				summary.taskConversationSessionMetadata?.workspaceTaskId &&
			current.pid === summary.pid &&
			current.workspacePath === summary.workspacePath &&
			current.runtimeSessionIncarnationId === summary.runtimeSessionIncarnationId &&
			current.agentNativeConversationSessionIdentity?.sourceAgentId === "codex" &&
			current.agentNativeConversationSessionIdentity.nativeSessionId === identity.nativeSessionId &&
			current.codexNativeSessionControlEndpoint?.socketPath === endpoint.socketPath &&
			current.codexNativeSessionControlEndpoint.workspaceId === input.workspaceId &&
			current.codexNativeSessionControlEndpoint.conversationSessionId === summary.taskId &&
			current.codexNativeSessionControlEndpoint.runtimeSessionIncarnationId === summary.runtimeSessionIncarnationId
		);
	};
	const canChangeMode = () => {
		const current = input.getCurrentLiveSummary();
		if (!current) return false;
		const facets = resolveSessionFacets(current);
		return facets.turnOwner !== "agent" && !isAgentAwaitingModalUserDecision(facets);
	};
	let updateRequested = false;
	let requestedDefaultModeSettings: {
		model: string;
		reasoning_effort: string | null;
		developer_instructions: null;
	} | null = null;
	const resultWhenModeExitCannotBeConfirmed = (
		error: string,
	): RuntimeExitCodexTaskConversationSessionPlanModeResponse => ({
		status: updateRequested ? "unconfirmed" : "rejected",
		error,
	});
	const expectedWorkingDirectory = await canonicalWorkingDirectory(summary.workspacePath);
	// 回执丢失只重连补证一次；绝不在结果未知时再次写入，以免覆盖用户随后选择的模式。
	for (let connectionAttempt = 0; connectionAttempt < 2; connectionAttempt += 1) {
		if (!isCurrent())
			return resultWhenModeExitCannotBeConfirmed("会话已停止、重启或切换原生身份，请在当前会话重试。");
		try {
			return await withRunningCodexAppServerControlSocketConnection<RuntimeExitCodexTaskConversationSessionPlanModeResponse>(
				async (port) => {
					if (!(await isNativeThreadLoaded(port, identity.nativeSessionId, isCurrent)))
						return resultWhenModeExitCannotBeConfirmed("目标 Codex 会话尚未加载，请等待恢复完成后重试。");
					if (!isCurrent()) return resultWhenModeExitCannotBeConfirmed("会话已变化，请在当前会话重试。");
					const nativeThread = z
						.object({ thread: nativeThreadSchema })
						.parse(
							await port.request("thread/read", { threadId: identity.nativeSessionId, includeTurns: false }),
						).thread;
					if (
						nativeThread.id !== identity.nativeSessionId ||
						(await canonicalWorkingDirectory(nativeThread.cwd)) !== expectedWorkingDirectory ||
						!isCurrent()
					)
						return resultWhenModeExitCannotBeConfirmed("原生会话身份或执行目录已变化，未对其他会话执行操作。");
					const readSettings = async () =>
						nativeThreadSettingsSchema.parse(
							await port.request("thread/resume", { threadId: identity.nativeSessionId, excludeTurns: true }),
						);
					const settings = await readSettings();
					if (
						settings.thread.id !== identity.nativeSessionId ||
						(await canonicalWorkingDirectory(settings.thread.cwd)) !== expectedWorkingDirectory ||
						!isCurrent()
					)
						return resultWhenModeExitCannotBeConfirmed("会话已变化，请在当前会话重试。");
					if (settings.collaborationMode?.mode === "default") {
						if (
							requestedDefaultModeSettings &&
							(settings.model !== requestedDefaultModeSettings.model ||
								settings.reasoningEffort !== requestedDefaultModeSettings.reasoning_effort)
						)
							return resultWhenModeExitCannotBeConfirmed(
								"原生模式已改变，但模型或推理档也发生变化，无法确认本次操作结果。",
							);
						return { status: updateRequested ? "exited" : "already_default" };
					}
					if (updateRequested)
						return resultWhenModeExitCannotBeConfirmed("尚未确认退出计划模式，请重试以读取当前状态。");
					if (settings.collaborationMode?.mode !== "plan")
						return resultWhenModeExitCannotBeConfirmed("当前 Codex 未提供可核验的计划模式，未更改设置。");
					if (!canChangeMode() || nativeThread.status.type !== "idle" || settings.thread.status.type !== "idle")
						return resultWhenModeExitCannotBeConfirmed(
							"当前回合仍在运行或等待原生作答，请结束或中断该回合后重试。",
						);
					if (!isCurrent()) return resultWhenModeExitCannotBeConfirmed("会话已变化，请在当前会话重试。");
					requestedDefaultModeSettings = {
						model: settings.model,
						reasoning_effort: settings.reasoningEffort,
						developer_instructions: null,
					};
					updateRequested = true;
					await port.request("thread/settings/update", {
						threadId: identity.nativeSessionId,
						collaborationMode: { mode: "default", settings: requestedDefaultModeSettings },
					});
					if (!isCurrent())
						return resultWhenModeExitCannotBeConfirmed("写入后会话已变化，无法确认当前会话模式，请重试。");
					const confirmed = await readSettings();
					if (
						confirmed.thread.id !== identity.nativeSessionId ||
						(await canonicalWorkingDirectory(confirmed.thread.cwd)) !== expectedWorkingDirectory ||
						confirmed.collaborationMode?.mode !== "default" ||
						confirmed.model !== requestedDefaultModeSettings.model ||
						confirmed.reasoningEffort !== requestedDefaultModeSettings.reasoning_effort ||
						!isCurrent()
					)
						return resultWhenModeExitCannotBeConfirmed("原生状态尚未确认退出计划模式，请重试以读取当前状态。");
					return { status: "exited" };
				},
				{ socketPath: endpoint.socketPath },
			);
		} catch (error) {
			if (connectionAttempt === 1)
				return resultWhenModeExitCannotBeConfirmed(
					`${updateRequested ? "退出结果尚未确认" : "无法连接或核验 Codex 原生会话"}，可重试：${error instanceof Error ? error.message : String(error)}`,
				);
		}
	}
	return resultWhenModeExitCannotBeConfirmed("原生状态尚未确认，请重试。");
}
