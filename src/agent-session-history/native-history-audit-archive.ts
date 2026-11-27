import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { runtimeTaskChatMessageSchema } from "../core/api-contract";

const archiveDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const archivedConversationIdentitySchema = z.object({
	sourceWorkspaceId: z.string().min(1),
	sourceTaskId: z.string().min(1),
	sourceTaskIncarnationCreatedAtEpochMs: z.number().finite(),
	sourceConversationSessionId: z.string().min(1),
	sourceAgentId: z.enum(["codex", "claude"]),
});
const archiveGapSchema = z.object({ source: z.string(), reason: z.string(), retryCondition: z.string() });
// M2 的 V1 归档头没有实例字段。实例归属取独立来源清单，清单以归档摘要绑定此头和各分页。
const archivedConversationSchema = archivedConversationIdentitySchema.extend({
	schemaVersion: z.literal(1),
	sourceNativeSessionId: z.string().nullable(),
	capturedAtEpochMs: z.number().finite(),
	availability: z.enum(["complete", "partial", "missing"]),
	pageDigests: z.array(archiveDigestSchema).max(2048),
	gaps: z.array(archiveGapSchema),
});
const archiveSourceManifestSchema = z.object({
	schemaVersion: z.literal(1),
	sourceInstanceId: z.string().trim().min(1),
	sessions: z.array(archivedConversationIdentitySchema.extend({ archiveDigest: archiveDigestSchema })),
});
const archiveMessagePageSchema = z.array(runtimeTaskChatMessageSchema);
const maximumArchiveAuditBytesPerSession = 128 * 1024 * 1024;
const maximumExportedArchiveMessageBytes = 128 * 1024 * 1024;

export type ArchivedConversationIdentity = z.infer<typeof archivedConversationIdentitySchema>;

export function archivedConversationIdentityKey(identity: ArchivedConversationIdentity) {
	return JSON.stringify([
		identity.sourceWorkspaceId,
		identity.sourceTaskId,
		identity.sourceTaskIncarnationCreatedAtEpochMs,
		identity.sourceConversationSessionId,
		identity.sourceAgentId,
	]);
}

async function readBoundedArchiveFile(path: string, maximumBytes: number) {
	const handle = await open(path, "r");
	try {
		const metadata = await handle.stat();
		if (!metadata.isFile() || metadata.size > maximumBytes) throw new Error("归档文件不可读或超出核验预算。");
		const contents = Buffer.alloc(metadata.size);
		const { bytesRead } = await handle.read(contents, 0, contents.length, 0);
		if (bytesRead !== metadata.size || (await handle.stat()).size !== metadata.size)
			throw new Error("归档文件在读取期间变化。");
		return contents;
	} finally {
		await handle.close();
	}
}

function assertArchiveDigest(contents: Buffer, digest: string) {
	if (createHash("sha256").update(contents).digest("hex") !== digest) throw new Error("归档内容摘要不匹配。");
}

export async function openNativeHistoryArchiveAudit(input: {
	archiveDirectory: string;
	sourceManifestPath: string;
	expectedSourceInstanceId: string;
	includeMessages: boolean;
}) {
	const manifest = archiveSourceManifestSchema.parse(
		JSON.parse((await readBoundedArchiveFile(input.sourceManifestPath, 16 * 1024 * 1024)).toString("utf8")),
	);
	if (manifest.sourceInstanceId !== input.expectedSourceInstanceId)
		throw new Error("归档来源清单与指定的来源实例不匹配。");
	const archiveDigestBySession = new Map<string, string>();
	for (const session of manifest.sessions) {
		const key = archivedConversationIdentityKey(session);
		if (archiveDigestBySession.has(key)) throw new Error("归档来源清单含有重复会话，先核对对应归档摘要。");
		archiveDigestBySession.set(key, session.archiveDigest);
	}
	let remainingArchiveExportBytes = maximumExportedArchiveMessageBytes;
	const sessions = manifest.sessions.map((session) => ({
		sourceWorkspaceId: session.sourceWorkspaceId,
		sourceTaskId: session.sourceTaskId,
		sourceTaskIncarnationCreatedAtEpochMs: session.sourceTaskIncarnationCreatedAtEpochMs,
		sourceConversationSessionId: session.sourceConversationSessionId,
		sourceAgentId: session.sourceAgentId,
	}));
	const read = async (identity: ArchivedConversationIdentity, knownNativeSessionId?: string) => {
		const archiveDigest = archiveDigestBySession.get(archivedConversationIdentityKey(identity));
		if (!archiveDigest) return { status: "not_listed" as const };
		const provenance = { sourceInstanceId: manifest.sourceInstanceId, archiveDigest };
		try {
			const directory = join(input.archiveDirectory, archiveDigest);
			const rawArchive = await readBoundedArchiveFile(join(directory, "archive.json"), 4 * 1024 * 1024);
			assertArchiveDigest(rawArchive, archiveDigest);
			const archive = archivedConversationSchema.parse(JSON.parse(rawArchive.toString("utf8")));
			if (
				archivedConversationIdentityKey(archive) !== archivedConversationIdentityKey(identity) ||
				archive.capturedAtEpochMs < identity.sourceTaskIncarnationCreatedAtEpochMs ||
				(archive.sourceNativeSessionId &&
					knownNativeSessionId &&
					archive.sourceNativeSessionId !== knownNativeSessionId)
			)
				throw new Error("归档 Task 代次、会话、harness 或原生身份不匹配。");
			if ((archive.availability === "missing") !== (archive.pageDigests.length === 0))
				throw new Error("归档可用性与分页清单不一致。");
			const pages = [];
			let verifiedPageCount = 0;
			let verifiedMessageCount = 0;
			let verifiedByteCount = 0;
			for (const [pageIndex, digest] of archive.pageDigests.entries()) {
				const bytes = await readBoundedArchiveFile(
					join(directory, `${pageIndex}.json`),
					Math.min(32 * 1024 * 1024, maximumArchiveAuditBytesPerSession - verifiedByteCount),
				);
				assertArchiveDigest(bytes, digest);
				const messages = archiveMessagePageSchema.parse(JSON.parse(bytes.toString("utf8")));
				verifiedPageCount++;
				verifiedMessageCount += messages.length;
				verifiedByteCount += bytes.length;
				if (input.includeMessages && verifiedByteCount <= remainingArchiveExportBytes) pages.push(messages);
			}
			const messagesFitExportBudget = verifiedByteCount <= remainingArchiveExportBytes;
			if (input.includeMessages && messagesFitExportBudget) remainingArchiveExportBytes -= verifiedByteCount;
			return {
				...provenance,
				status: archive.availability,
				gaps: archive.gaps,
				verifiedPageCount,
				verifiedMessageCount,
				verifiedByteCount,
				...(input.includeMessages &&
					(messagesFitExportBudget
						? { messages: pages.reverse().flat() }
						: { messagesExportRecheckCondition: "正文超过本次导出预算。按 --task-id 缩小范围后重试。" })),
			};
		} catch (error) {
			return {
				...provenance,
				status: "unverified" as const,
				gaps: [
					{
						source: "archive",
						reason: error instanceof Error ? error.message : String(error),
						retryCondition: "取得与来源清单摘要一致的归档头和所有分页后重验。",
					},
				],
			};
		}
	};
	return { sessions, read };
}
