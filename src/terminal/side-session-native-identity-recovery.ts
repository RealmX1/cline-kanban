// 身份补证只读取本代独享的原生控制凭据；恢复请求独立持久化，不保存首条消息或 fork 指令。
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { inspectCodexNativeConversationTranscriptBeforeResume } from "../agent-session-history/codex-native-conversation-transcript-location-for-resume";
import {
	type RuntimeAgentNativeConversationSessionIdentity,
	type RuntimeTaskSessionSummary,
	runtimeAgentIdSchema,
	runtimeTaskAgentPermissionModeSchema,
	runtimeTaskConversationModeSchema,
	runtimeTaskConversationSessionMetadataSchema,
	runtimeTaskTerminalAgentModelOverrideSettingsSchema,
} from "../core/api-contract";
import { withRunningCodexAppServerControlSocketConnection } from "../rvf-automatic-closeout/codex-app-server-control-socket-request-connection";
import { getRuntimeHomePath } from "../state/runtime-home-path";
import type { StartTaskSessionRequest } from "./session-manager";

const persistedResumeRequestSchema = z.object({
	runtimeSessionIncarnationId: z.string().min(1),
	request: z.object({
		taskId: z.string().min(1),
		workspaceTaskId: z.string().optional(),
		workspaceId: z.string().optional(),
		projectPath: z.string().optional(),
		agentId: runtimeAgentIdSchema,
		binary: z.string().min(1),
		args: z.array(z.string()),
		cwd: z.string().min(1),
		env: z.record(z.string(), z.string().optional()).optional(),
		taskAgentPermissionMode: runtimeTaskAgentPermissionModeSchema.optional(),
		taskConversationMode: runtimeTaskConversationModeSchema.optional(),
		taskConversationSessionMetadata: runtimeTaskConversationSessionMetadataSchema.optional(),
		terminalAgentModelOverrideSettings: runtimeTaskTerminalAgentModelOverrideSettingsSchema.optional(),
		autoContinueOnConnectionDropEnabled: z.boolean().optional(),
		cols: z.number().optional(),
		rows: z.number().optional(),
	}),
});

function recoveryRequestPath(summary: RuntimeTaskSessionSummary): string {
	const identity = JSON.stringify([summary.taskId, summary.runtimeSessionIncarnationId, summary.workspacePath]);
	return join(
		getRuntimeHomePath(),
		"side-session-native-identity-recovery",
		`${createHash("sha256").update(identity).digest("hex")}.json`,
	);
}

export async function persistSideSessionResumeRequestWaitingForNativeIdentity(
	summary: RuntimeTaskSessionSummary,
	request: StartTaskSessionRequest,
): Promise<void> {
	// Zod 白名单排除 prompt、图片、首次 fork、Plan 起步及所有回调；续跑只接回当前子身份。
	const record = persistedResumeRequestSchema.parse({
		runtimeSessionIncarnationId: summary.runtimeSessionIncarnationId,
		request,
	});
	const path = recoveryRequestPath(summary);
	await mkdir(join(getRuntimeHomePath(), "side-session-native-identity-recovery"), { recursive: true, mode: 0o700 });
	await writeFile(path, JSON.stringify(record), { mode: 0o600 });
}

export async function readSideSessionResumeRequestWaitingForNativeIdentity(
	summary: RuntimeTaskSessionSummary,
): Promise<StartTaskSessionRequest | null> {
	try {
		const record = persistedResumeRequestSchema.parse(
			JSON.parse(await readFile(recoveryRequestPath(summary), "utf8")),
		);
		if (
			record.runtimeSessionIncarnationId !== summary.runtimeSessionIncarnationId ||
			record.request.taskId !== summary.taskId ||
			record.request.agentId !== summary.agentId ||
			resolve(record.request.cwd) !== resolve(summary.workspacePath ?? "") ||
			record.request.workspaceTaskId !== summary.taskConversationSessionMetadata?.workspaceTaskId
		)
			return null;
		if (!isDeepStrictEqual(record.request.taskConversationSessionMetadata, summary.taskConversationSessionMetadata))
			return null;
		return { ...record.request, prompt: "", resumePriorAgentConversationWithoutResendingPrompt: true };
	} catch {
		return null;
	}
}

export async function readSideSessionNativeIdentityEvidenceFingerprint(
	summary: RuntimeTaskSessionSummary,
	resolveResumeRequestWithCodexConversationStorageHome: (
		request: StartTaskSessionRequest,
	) => Promise<StartTaskSessionRequest>,
): Promise<string> {
	const socketMetadata = summary.codexNativeSessionControlEndpoint
		? await stat(summary.codexNativeSessionControlEndpoint.socketPath).catch(() => null)
		: null;
	const resumeRequestMetadata =
		summary.taskConversationSessionNativeIdentityRecovery?.resumeRequestedAtMs != null
			? await stat(recoveryRequestPath(summary)).catch(() => null)
			: null;
	const codexResumeRequest =
		summary.agentId === "codex" && summary.taskConversationSessionNativeIdentityRecovery?.resumeRequestedAtMs != null
			? await readSideSessionResumeRequestWaitingForNativeIdentity(summary)
			: null;
	const identity = summary.agentNativeConversationSessionIdentity;
	// 身份已知仍可能等待转录落盘；与停止前预检同源的新证据必须能解锁耗尽的重试预算。
	let persistedCodexTranscriptPath: string | null = null;
	if (codexResumeRequest && identity?.sourceAgentId === "codex") {
		// 旧请求可能在目录归一化前保存；补证与实际启动必须共用存储归属及迁移解析。
		const resolvedCodexResumeRequest = await resolveResumeRequestWithCodexConversationStorageHome(codexResumeRequest);
		persistedCodexTranscriptPath = (
			await inspectCodexNativeConversationTranscriptBeforeResume({
				nativeSessionId: identity.nativeSessionId,
				transcriptPath: identity.transcriptPath,
				agentExecutionWorkingDirectoryPath: resolvedCodexResumeRequest.cwd,
				environmentOverrides: resolvedCodexResumeRequest.env,
			})
		).persistedTranscriptPath;
	}
	return JSON.stringify([
		summary.agentNativeConversationSessionIdentity,
		summary.codexNativeSessionControlEndpoint,
		socketMetadata && [socketMetadata.dev, socketMetadata.ino, socketMetadata.mtimeMs],
		summary.lastHookAt,
		resumeRequestMetadata && [resumeRequestMetadata.size, resumeRequestMetadata.mtimeMs],
		persistedCodexTranscriptPath,
	]);
}

export async function readSideSessionNativeIdentityFromOwnedCodexControl(
	summary: RuntimeTaskSessionSummary,
): Promise<RuntimeAgentNativeConversationSessionIdentity | null> {
	const endpoint = summary.codexNativeSessionControlEndpoint;
	if (
		summary.agentId !== "codex" ||
		!endpoint ||
		endpoint.conversationSessionId !== summary.taskId ||
		endpoint.runtimeSessionIncarnationId !== summary.runtimeSessionIncarnationId
	)
		return null;
	try {
		return await withRunningCodexAppServerControlSocketConnection(
			async (port) => {
				const loaded = z.object({ data: z.array(z.string()) }).parse(await port.request("thread/loaded/list", {}));
				// 独享端点中须只有一个非来源候选；原生 fork 可能同时保留已知的父对话。
				const candidates = loaded.data.filter(
					(id) => id !== summary.taskConversationSessionNativeIdentityRecovery?.forkSourceNativeSessionId,
				);
				if (candidates.length !== 1) return null;
				const result = z
					.object({ thread: z.object({ id: z.string(), cwd: z.string(), path: z.string().nullish() }) })
					.parse(await port.request("thread/read", { threadId: candidates[0], includeTurns: false }));
				if (
					result.thread.id !== candidates[0] ||
					resolve(result.thread.cwd) !== resolve(summary.workspacePath ?? "") ||
					result.thread.id === summary.taskConversationSessionNativeIdentityRecovery?.forkSourceNativeSessionId
				)
					return null;
				return {
					sourceAgentId: "codex",
					nativeSessionId: result.thread.id,
					transcriptPath: result.thread.path ?? null,
					observedAt: Date.now(),
				};
			},
			{ socketPath: endpoint.socketPath, signal: AbortSignal.timeout(1_000) },
		);
	} catch {
		return null;
	}
}
