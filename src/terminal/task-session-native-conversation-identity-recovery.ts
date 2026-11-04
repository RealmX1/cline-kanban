// 身份补证只读取本代独享的原生控制凭据；恢复请求独立持久化，不保存首条消息或 fork 指令。
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { inspectCodexNativeConversationTranscriptBeforeResume } from "../agent-session-history/codex-native-conversation-transcript-location-for-resume";
import { withRunningCodexAppServerControlSocketConnection } from "../codex-native-session-protocol/codex-app-server-control-socket-request-connection";
import {
	type RuntimeAgentNativeConversationSessionIdentity,
	type RuntimeTaskSessionSummary,
	runtimeAgentIdSchema,
	runtimeTaskAgentPermissionModeSchema,
	runtimeTaskConversationModeSchema,
	runtimeTaskConversationSessionMetadataSchema,
	runtimeTaskTerminalAgentModelOverrideSettingsSchema,
} from "../core/api-contract";
import { codexConfigurationPermissionSelectionSourceSchema } from "../core/codex-configuration-sync-contract";
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
		additionalAgentStartupArgumentsForThisRestart: z.array(z.string()).optional(),
		codexConfigurationProfileId: z.string().optional(),
		codexConfigurationPermissionSelectionSource: codexConfigurationPermissionSelectionSourceSchema.optional(),
		taskConversationMode: runtimeTaskConversationModeSchema.optional(),
		taskConversationSessionMetadata: runtimeTaskConversationSessionMetadataSchema.optional(),
		terminalAgentModelOverrideSettings: runtimeTaskTerminalAgentModelOverrideSettingsSchema.optional(),
		autoContinueOnConnectionDropEnabled: z.boolean().optional(),
		codexModelCapacityErrorAutoContinuationEnabled: z.boolean().optional(),
		automaticFailureContinuationEpisodeId: z.string().optional(),
		cols: z.number().optional(),
		rows: z.number().optional(),
	}),
});

// 沿用已有目录以读取升级前的请求和重试预算，模块及 API 已推广到主会话。
const LEGACY_PERSISTED_TASK_NATIVE_IDENTITY_RECOVERY_DIRECTORY_NAME = "side-session-native-identity-recovery";

function recoveryRequestPath(summary: RuntimeTaskSessionSummary): string {
	const identity = JSON.stringify([summary.taskId, summary.runtimeSessionIncarnationId, summary.workspacePath]);
	return join(
		getRuntimeHomePath(),
		LEGACY_PERSISTED_TASK_NATIVE_IDENTITY_RECOVERY_DIRECTORY_NAME,
		`${createHash("sha256").update(identity).digest("hex")}.json`,
	);
}

export async function persistTaskSessionResumeRequestWaitingForNativeConversationIdentity(
	summary: RuntimeTaskSessionSummary,
	request: StartTaskSessionRequest,
): Promise<void> {
	// Zod 白名单排除 prompt、图片、首次 fork、Plan 起步及所有回调；续跑只接回当前子身份。
	const record = persistedResumeRequestSchema.parse({
		runtimeSessionIncarnationId: summary.runtimeSessionIncarnationId,
		request,
	});
	const path = recoveryRequestPath(summary);
	await mkdir(join(getRuntimeHomePath(), LEGACY_PERSISTED_TASK_NATIVE_IDENTITY_RECOVERY_DIRECTORY_NAME), {
		recursive: true,
		mode: 0o700,
	});
	await writeFile(path, JSON.stringify(record), { mode: 0o600 });
}

export async function readTaskSessionResumeRequestWaitingForNativeConversationIdentity(
	summary: RuntimeTaskSessionSummary,
	options?: { rebuildAutomaticRecoveryMetadataForWorkspaceTaskId: string },
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
			(!options &&
				(record.request.workspaceTaskId ??
					record.request.taskConversationSessionMetadata?.workspaceTaskId ??
					record.request.taskId) !== (summary.taskConversationSessionMetadata?.workspaceTaskId ?? summary.taskId))
		)
			return null;
		if (
			options &&
			(record.request.workspaceTaskId ??
				record.request.taskConversationSessionMetadata?.workspaceTaskId ??
				record.request.taskId) !== options.rebuildAutomaticRecoveryMetadataForWorkspaceTaskId
		)
			return null;
		if (
			!options &&
			!isDeepStrictEqual(record.request.taskConversationSessionMetadata, summary.taskConversationSessionMetadata)
		)
			return null;
		return { ...record.request, prompt: "", resumePriorAgentConversationWithoutResendingPrompt: true };
	} catch {
		return null;
	}
}

export async function readTaskSessionNativeConversationIdentityEvidenceFingerprint(
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
			? await readTaskSessionResumeRequestWaitingForNativeConversationIdentity(summary)
			: null;
	const identity = summary.agentNativeConversationSessionIdentity;
	const storageHome =
		summary.codexConversationStorageHomeDirectoryPath ??
		codexResumeRequest?.env?.CODEX_HOME ??
		join(homedir(), ".codex");
	const currentDate = new Date();
	const localDateSegments = [
		String(currentDate.getFullYear()),
		String(currentDate.getMonth() + 1).padStart(2, "0"),
		String(currentDate.getDate()).padStart(2, "0"),
	];
	const transcriptDirectories = [
		...new Set([
			join(storageHome, "sessions"),
			join(storageHome, "sessions", ...localDateSegments),
			join(storageHome, "sessions", ...currentDate.toISOString().slice(0, 10).split("-")),
		]),
	];
	// 尚无身份时也能察觉新转录出现；这里只读取目录变化，不按最近文件猜身份。
	const transcriptDirectoryEvidence =
		summary.agentId === "codex"
			? await Promise.all(
					transcriptDirectories.map(async (path) => {
						const metadata = await stat(path).catch(() => null);
						return [path, metadata && [metadata.dev, metadata.ino, metadata.mtimeMs]];
					}),
				)
			: [];
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
		transcriptDirectoryEvidence,
	]);
}

export async function readTaskSessionNativeConversationIdentityFromOwnedCodexControl(
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
				const loadedNativeSessionIds = new Set<string>();
				const seenCursors = new Set<string>();
				let cursor: string | null = null;
				do {
					const page = z
						.object({ data: z.array(z.string()), nextCursor: z.string().nullish() })
						.parse(await port.request("thread/loaded/list", { cursor, limit: 100 }));
					for (const id of page.data) {
						if (loadedNativeSessionIds.has(id)) return null;
						loadedNativeSessionIds.add(id);
					}
					cursor = page.nextCursor ?? null;
					if (cursor && seenCursors.has(cursor)) return null;
					if (cursor) seenCursors.add(cursor);
				} while (cursor);
				// 独享端点中须只有一个非来源候选；原生 fork 可能同时保留已知的父对话。
				const candidates = [...loadedNativeSessionIds].filter(
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
