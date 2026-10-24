import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveRecordedCodexConversationHome } from "../codex-conversation-storage/codex-conversation-storage-home";
import {
	type RecoveredCodexUserQuestions,
	recoverCodexUserQuestionsFromKnownConversation,
	resolveCodexUserQuestionTranscriptRecoveryStorageBinding,
} from "./codex-user-question-transcript-recovery";

const MAXIMUM_TRACKED_FILESYSTEM_PATHS_PER_CACHED_CONVERSATION = 4096;

type CodexUserQuestionTranscriptRecoveryInput = Parameters<typeof recoverCodexUserQuestionsFromKnownConversation>[0];
interface CodexTranscriptFilesystemSnapshot {
	filesystemPathSignatures: Map<string, string | null>;
	discoveryWasComplete: boolean;
}
interface CachedCodexUserQuestionRecovery {
	filesystemSnapshot: CodexTranscriptFilesystemSnapshot;
	recovered: RecoveredCodexUserQuestions;
	retainedResultBytes: number;
}

async function readCodexTranscriptFilesystemPathSignature(path: string): Promise<string | null> {
	try {
		const identity = await stat(path, { bigint: true });
		return `${identity.dev}:${identity.ino}:${identity.mode}:${identity.size}:${identity.mtimeNs}:${identity.ctimeNs}`;
	} catch {
		return null;
	}
}

async function captureKnownCodexTranscriptFilesystemSnapshot(
	codexSessionsRootDirectoryPath: string,
	input: CodexUserQuestionTranscriptRecoveryInput,
): Promise<CodexTranscriptFilesystemSnapshot> {
	const filesystemSnapshot: CodexTranscriptFilesystemSnapshot = {
		filesystemPathSignatures: new Map(),
		discoveryWasComplete: true,
	};
	const directoriesToVisit = [codexSessionsRootDirectoryPath];
	const knownTranscriptPaths = new Set<string>();
	if (input.transcriptPath) knownTranscriptPaths.add(resolve(input.transcriptPath));
	while (directoriesToVisit.length > 0) {
		const directoryPath = directoriesToVisit.pop();
		if (!directoryPath) break;
		// 在枚举之前留存目录身份，防止枚举后新增文件却把新时间戳配给旧文件清单。
		const signature = await readCodexTranscriptFilesystemPathSignature(directoryPath);
		filesystemSnapshot.filesystemPathSignatures.set(directoryPath, signature);
		if (
			signature === null ||
			filesystemSnapshot.filesystemPathSignatures.size + knownTranscriptPaths.size >
				MAXIMUM_TRACKED_FILESYSTEM_PATHS_PER_CACHED_CONVERSATION
		) {
			filesystemSnapshot.discoveryWasComplete = false;
			return filesystemSnapshot;
		}
		try {
			for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
				const entryPath = join(directoryPath, entry.name);
				if (entry.isDirectory()) directoriesToVisit.push(entryPath);
				else if (
					entry.isFile() &&
					(entry.name.endsWith(`${input.sessionId}.jsonl`) ||
						(entry.name.includes(`${input.sessionId}_`) && entry.name.endsWith(".jsonl")))
				)
					knownTranscriptPaths.add(entryPath);
				if (
					filesystemSnapshot.filesystemPathSignatures.size +
						knownTranscriptPaths.size +
						directoriesToVisit.length >
					MAXIMUM_TRACKED_FILESYSTEM_PATHS_PER_CACHED_CONVERSATION
				) {
					filesystemSnapshot.discoveryWasComplete = false;
					return filesystemSnapshot;
				}
			}
		} catch {
			filesystemSnapshot.discoveryWasComplete = false;
			return filesystemSnapshot;
		}
	}
	for (const transcriptPath of knownTranscriptPaths) {
		if (
			filesystemSnapshot.filesystemPathSignatures.size >= MAXIMUM_TRACKED_FILESYSTEM_PATHS_PER_CACHED_CONVERSATION
		) {
			filesystemSnapshot.discoveryWasComplete = false;
			break;
		}
		const signature = await readCodexTranscriptFilesystemPathSignature(transcriptPath);
		filesystemSnapshot.filesystemPathSignatures.set(transcriptPath, signature);
		if (signature === null) filesystemSnapshot.discoveryWasComplete = false;
	}
	return filesystemSnapshot;
}

async function codexTranscriptFilesystemSnapshotIsUnchanged(
	filesystemSnapshot: CodexTranscriptFilesystemSnapshot,
): Promise<boolean> {
	const comparisons = await Promise.all(
		[...filesystemSnapshot.filesystemPathSignatures].map(
			async ([path, signature]) => (await readCodexTranscriptFilesystemPathSignature(path)) === signature,
		),
	);
	return comparisons.every(Boolean);
}

/** 只供 pending/history 查询复用；实际答案投递仍须调用原始的即时恢复入口。 */
export function createCodexUserQuestionPendingAndHistoryFileChangeCache(
	options: { maximumCachedConversations?: number; maximumCachedResultBytes?: number } = {},
) {
	const maximumCachedConversations = Math.max(1, options.maximumCachedConversations ?? 32);
	const maximumCachedResultBytes = Math.max(0, options.maximumCachedResultBytes ?? 8 * 1024 * 1024);
	const cachedRecoveries = new Map<string, CachedCodexUserQuestionRecovery>();
	const inFlightRecoveries = new Map<string, Promise<RecoveredCodexUserQuestions>>();
	let retainedResultBytes = 0;
	const removeCachedRecovery = (key: string) => {
		const cachedRecovery = cachedRecoveries.get(key);
		if (cachedRecovery) retainedResultBytes -= cachedRecovery.retainedResultBytes;
		cachedRecoveries.delete(key);
	};
	return (input: CodexUserQuestionTranscriptRecoveryInput): Promise<RecoveredCodexUserQuestions> => {
		const recoveryRequestKey = JSON.stringify([
			resolve(input.homeDirectoryPath ?? resolveRecordedCodexConversationHome(input)),
			input.sessionId,
			input.transcriptPath ? resolve(input.transcriptPath) : null,
			input.maximumTranscriptBytesToRead ?? 32 * 1024 * 1024,
		]);
		const inFlightRecovery = inFlightRecoveries.get(recoveryRequestKey);
		if (inFlightRecovery) return inFlightRecovery;
		// 高并发的额外会话直接走即时读取，避免单飞索引本身无限增长。
		if (inFlightRecoveries.size >= maximumCachedConversations)
			return recoverCodexUserQuestionsFromKnownConversation(input);
		const pendingRecovery = (async () => {
			// 每次查询先读取正式绑定；目录未变的旧缓存不能遮住迁移或回退。
			const resolvedInput = await resolveCodexUserQuestionTranscriptRecoveryStorageBinding(input);
			const codexHomeDirectoryPath = resolve(resolvedInput.homeDirectoryPath);
			const codexSessionsRootDirectoryPath = join(codexHomeDirectoryPath, "sessions");
			const cacheKey = JSON.stringify([
				codexHomeDirectoryPath,
				resolvedInput.sessionId,
				resolvedInput.transcriptPath ? resolve(resolvedInput.transcriptPath) : null,
				resolvedInput.maximumTranscriptBytesToRead ?? 32 * 1024 * 1024,
			]);
			const cachedRecovery = cachedRecoveries.get(cacheKey);
			if (
				cachedRecovery &&
				(await codexTranscriptFilesystemSnapshotIsUnchanged(cachedRecovery.filesystemSnapshot))
			) {
				cachedRecoveries.delete(cacheKey);
				cachedRecoveries.set(cacheKey, cachedRecovery);
				return cachedRecovery.recovered;
			}
			removeCachedRecovery(cacheKey);
			for (let stableSnapshotAttempt = 0; stableSnapshotAttempt < 2; stableSnapshotAttempt += 1) {
				const filesystemSnapshot = await captureKnownCodexTranscriptFilesystemSnapshot(
					codexSessionsRootDirectoryPath,
					resolvedInput,
				);
				const recovered = await recoverCodexUserQuestionsFromKnownConversation(resolvedInput);
				if (!filesystemSnapshot.discoveryWasComplete) return recovered;
				if (!(await codexTranscriptFilesystemSnapshotIsUnchanged(filesystemSnapshot))) continue;
				const recoveredResultByteLength = Buffer.byteLength(JSON.stringify(recovered));
				if (recovered.coverage === "complete" && recoveredResultByteLength <= maximumCachedResultBytes) {
					while (
						cachedRecoveries.size >= maximumCachedConversations ||
						retainedResultBytes + recoveredResultByteLength > maximumCachedResultBytes
					) {
						const oldestCacheKey = cachedRecoveries.keys().next().value;
						if (oldestCacheKey === undefined) break;
						removeCachedRecovery(oldestCacheKey);
					}
					cachedRecoveries.set(cacheKey, {
						filesystemSnapshot,
						recovered,
						retainedResultBytes: recoveredResultByteLength,
					});
					retainedResultBytes += recoveredResultByteLength;
				}
				return recovered;
			}
			// 正在持续写入的转录不应把旧问题重新生成为可投递状态。
			return { exchanges: [], coverage: "incomplete" as const };
		})().finally(() => inFlightRecoveries.delete(recoveryRequestKey));
		inFlightRecoveries.set(recoveryRequestKey, pendingRecovery);
		return pendingRecovery;
	};
}

export const recoverCodexUserQuestionsForPendingAndHistoryWithFileChangeCache =
	createCodexUserQuestionPendingAndHistoryFileChangeCache();
