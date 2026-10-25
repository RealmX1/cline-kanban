import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import {
	inferCodexHomeDirectoryPathFromTranscriptPath,
	resolveMigratedCodexConversationHome,
	resolveRecordedCodexConversationHome,
} from "../codex-conversation-storage/codex-conversation-storage-home";
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { withCodexAppServerRequestConnection } from "../rvf-automatic-closeout/codex-app-server-request-connection";
import {
	type CodexAppServerRequestPort,
	readCodexConversationTurns,
} from "../rvf-automatic-closeout/codex-native-conversation-prefix";

export class TaskMainSessionHandoverExecutionProhibitedError extends Error {}

const forkChildIdentitySchema = z.object({
	nativeSessionId: z.string().min(1),
	transcriptPath: z.string().min(1),
	codexConversationStorageHomeDirectoryPath: z.string().min(1),
});
const forkPreparationReceiptSchema = z.object({
	handoverId: z.string(),
	sourceTaskConversationSessionId: z.string(),
	sourceNativeSessionId: z.string(),
	workingDirectoryPath: z.string(),
	codexConversationStorageHomeDirectoryPath: z.string(),
	expectedTurnIds: z.array(z.string()).min(1),
	attempts: z.array(
		z.object({
			startedAt: z.number(),
			childIdentity: forkChildIdentitySchema.nullable(),
			verifiedAt: z.number().nullable(),
			failureDescription: z.string().nullable(),
			evidenceFingerprint: z.string().optional(),
			rejectedForkResponse: z
				.object({ nativeSessionId: z.string(), workingDirectoryPath: z.string(), transcriptPath: z.string() })
				.optional(),
		}),
	),
});
interface ForkPreparationInput {
	handoverId: string;
	sourceTaskConversationSessionId: string;
	sourceNativeSessionId: string;
	workingDirectoryPath: string;
	codexConversationStorageHomeDirectoryPath: string;
	receiptFilePath: string;
	now?: () => number;
	expectedTurnIds?: readonly string[];
	allowAdditionalSourceTurnsAfterFrozenBoundary?: boolean;
	preparationEvidenceFingerprint?: string;
}
export type PreparedCodexMainSessionHandoverNativeFork = z.infer<typeof forkChildIdentitySchema> & {
	sourceCompletedTurnCount: number;
};

// 只有原生历史读写，不产生模型回合。准备尝试与子身份均先 fsync，再继续下一步。
export async function prepareCodexMainSessionHandoverNativeForkWithPort(
	port: CodexAppServerRequestPort,
	input: ForkPreparationInput,
): Promise<PreparedCodexMainSessionHandoverNativeFork> {
	return await lockedFileSystem.withLock({ path: input.receiptFilePath }, async () => {
		const now = input.now ?? Date.now;
		const original = await readCodexConversationTurns(port, input.sourceNativeSessionId);
		if (
			!original.length ||
			(!input.allowAdditionalSourceTurnsAfterFrozenBoundary &&
				(original.at(-1)?.status !== "completed" || original.some((turn) => turn.status === "inProgress")))
		)
			throw new Error("等待来源最后一个原生回合完整结束，未创建分支。");
		let receipt: z.infer<typeof forkPreparationReceiptSchema>;
		try {
			receipt = forkPreparationReceiptSchema.parse(JSON.parse(await readFile(input.receiptFilePath, "utf8")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			receipt = {
				handoverId: input.handoverId,
				sourceTaskConversationSessionId: input.sourceTaskConversationSessionId,
				sourceNativeSessionId: input.sourceNativeSessionId,
				workingDirectoryPath: resolve(input.workingDirectoryPath),
				codexConversationStorageHomeDirectoryPath: input.codexConversationStorageHomeDirectoryPath,
				expectedTurnIds: [...(input.expectedTurnIds ?? original.map((turn) => turn.id))],
				attempts: [],
			};
		}
		if (
			receipt.handoverId !== input.handoverId ||
			receipt.sourceTaskConversationSessionId !== input.sourceTaskConversationSessionId ||
			receipt.sourceNativeSessionId !== input.sourceNativeSessionId ||
			receipt.workingDirectoryPath !== resolve(input.workingDirectoryPath)
		)
			throw new TaskMainSessionHandoverExecutionProhibitedError("原生准备凭据的身份或归属不符，未切换主会话。");
		const assertSourceBoundaryUnchanged = async (turns = original) => {
			if (
				(input.allowAdditionalSourceTurnsAfterFrozenBoundary
					? turns.length < receipt.expectedTurnIds.length
					: turns.length !== receipt.expectedTurnIds.length) ||
				receipt.expectedTurnIds.some((id, index) => turns[index]?.id !== id) ||
				turns[receipt.expectedTurnIds.length - 1]?.status !== "completed"
			)
				throw new TaskMainSessionHandoverExecutionProhibitedError("来源完整回合边界已经变化，未采用陈旧交接。");
		};
		await assertSourceBoundaryUnchanged();
		const persist = async () =>
			await lockedFileSystem.writeJsonFileAtomic(input.receiptFilePath, receipt, { lock: null, durable: true });
		let attempt = receipt.attempts.at(-1);
		if (!attempt?.childIdentity) {
			const evidenceFingerprint =
				input.preparationEvidenceFingerprint ?? input.codexConversationStorageHomeDirectoryPath;
			const attemptsForCurrentEvidence = receipt.attempts.filter(
				(candidate) => candidate.evidenceFingerprint === evidenceFingerprint,
			);
			if (attemptsForCurrentEvidence.length >= 3 || (attempt && now() - attempt.startedAt < 15_000))
				throw new Error("原生分支准备已保留未知尝试，等待有界重验条件，不启动模型。");
			attempt = {
				startedAt: now(),
				childIdentity: null,
				verifiedAt: null,
				failureDescription: null,
				evidenceFingerprint,
			};
			receipt.attempts.push(attempt);
			await persist();
			try {
				const forked = z
					.object({ thread: z.object({ id: z.string().min(1), path: z.string().min(1), cwd: z.string() }) })
					.parse(
						await port.request("thread/fork", {
							threadId: input.sourceNativeSessionId,
							lastTurnId: receipt.expectedTurnIds.at(-1),
							cwd: input.workingDirectoryPath,
							excludeTurns: true,
						}),
					).thread;
				const childHome = inferCodexHomeDirectoryPathFromTranscriptPath(forked.path);
				if (
					forked.id === input.sourceNativeSessionId ||
					resolve(forked.cwd) !== resolve(input.workingDirectoryPath) ||
					(childHome && resolve(childHome) !== resolve(input.codexConversationStorageHomeDirectoryPath))
				) {
					attempt.rejectedForkResponse = {
						nativeSessionId: forked.id,
						workingDirectoryPath: forked.cwd,
						transcriptPath: forked.path,
					};
					await persist();
					throw new TaskMainSessionHandoverExecutionProhibitedError("原生分支身份或工作目录错误，未切换主会话。");
				}
				attempt.childIdentity = {
					nativeSessionId: forked.id,
					transcriptPath: forked.path,
					codexConversationStorageHomeDirectoryPath:
						inferCodexHomeDirectoryPathFromTranscriptPath(forked.path) ??
						input.codexConversationStorageHomeDirectoryPath,
				};
				await persist();
			} catch (error) {
				attempt.failureDescription = error instanceof Error ? error.message : String(error);
				await persist();
				throw error;
			}
		}
		const identity = attempt.childIdentity;
		if (!identity) throw new Error("原生子身份尚未保存，等待恢复准备。");
		const child = await readCodexConversationTurns(port, identity.nativeSessionId);
		if (
			child.length !== receipt.expectedTurnIds.length ||
			child.at(-1)?.status !== "completed" ||
			child.some((turn, index) => turn.id !== receipt.expectedTurnIds[index])
		)
			throw new TaskMainSessionHandoverExecutionProhibitedError("子会话未完整保留固定历史，未切换主会话。");
		await assertSourceBoundaryUnchanged(await readCodexConversationTurns(port, input.sourceNativeSessionId));
		attempt.verifiedAt = now();
		await persist();
		return { ...identity, sourceCompletedTurnCount: receipt.expectedTurnIds.length };
	});
}

export async function prepareCodexMainSessionHandoverNativeFork(input: {
	handoverId: string;
	sourceSummary: RuntimeTaskSessionSummary;
	receiptFilePath: string;
	expectedTurnIds?: readonly string[];
	allowAdditionalSourceTurnsAfterFrozenBoundary?: boolean;
}): Promise<PreparedCodexMainSessionHandoverNativeFork> {
	const identity = input.sourceSummary.agentNativeConversationSessionIdentity;
	const workingDirectoryPath = input.sourceSummary.workspacePath;
	if (input.sourceSummary.agentId !== "codex" || identity?.sourceAgentId !== "codex" || !workingDirectoryPath)
		throw new Error("等待可靠 Codex 原生身份和工作目录，未从其它会话猜选。");
	const codexConversationStorageHomeDirectoryPath = resolveRecordedCodexConversationHome({
		...input.sourceSummary,
		transcriptPath: identity.transcriptPath,
	});
	return await withCodexAppServerRequestConnection(
		{
			workingDirectory: workingDirectoryPath,
			codexConversationStorageHomeDirectoryPath,
			codexConversationStorageNativeSessionId: identity.nativeSessionId,
		},
		async (port) => {
			const authoritativeHome = await resolveMigratedCodexConversationHome(
				codexConversationStorageHomeDirectoryPath,
				identity.nativeSessionId,
			);
			const source = z
				.object({ thread: z.object({ id: z.string(), cwd: z.string() }) })
				.parse(
					await port.request("thread/read", { threadId: identity.nativeSessionId, includeTurns: false }),
				).thread;
			if (source.id !== identity.nativeSessionId || resolve(source.cwd) !== resolve(workingDirectoryPath))
				throw new TaskMainSessionHandoverExecutionProhibitedError("来源原生身份或工作目录归属不符。");
			return await prepareCodexMainSessionHandoverNativeForkWithPort(port, {
				handoverId: input.handoverId,
				sourceTaskConversationSessionId: input.sourceSummary.taskId,
				sourceNativeSessionId: identity.nativeSessionId,
				workingDirectoryPath,
				codexConversationStorageHomeDirectoryPath: authoritativeHome,
				preparationEvidenceFingerprint: JSON.stringify([
					authoritativeHome,
					input.sourceSummary.codexNativeSessionControlEndpoint,
				]),
				receiptFilePath: input.receiptFilePath,
				expectedTurnIds: input.expectedTurnIds,
				allowAdditionalSourceTurnsAfterFrozenBoundary: input.allowAdditionalSourceTurnsAfterFrozenBoundary,
			});
		},
	);
}

export async function prepareCodexMainSessionHandoverRecoveryNativeFork(input: {
	handoverId: string;
	sourceSummary: RuntimeTaskSessionSummary;
	frozenReceiptFilePath: string;
	receiptFilePath: string;
}) {
	const frozen = forkPreparationReceiptSchema.parse(JSON.parse(await readFile(input.frozenReceiptFilePath, "utf8")));
	if (frozen.handoverId !== input.handoverId || !frozen.attempts.some((attempt) => attempt.verifiedAt !== null))
		throw new TaskMainSessionHandoverExecutionProhibitedError("原交接缺少已验证的固定历史凭据，未降级为空白上下文。");
	return await prepareCodexMainSessionHandoverNativeFork({
		...input,
		expectedTurnIds: frozen.expectedTurnIds,
		allowAdditionalSourceTurnsAfterFrozenBoundary: true,
	});
}
