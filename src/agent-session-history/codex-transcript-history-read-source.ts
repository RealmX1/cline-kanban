import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { listKnownCodexTranscriptSegmentPaths } from "./codex-native-conversation-transcript-location-for-resume";
import {
	type CodexTranscriptReadSource,
	codexTranscriptJsonlPath,
	codexTranscriptMetadataMatchesPersistentMainConversation,
	codexTranscriptNativeStorageRoot,
	openCodexTranscriptReadSource,
	readCodexTranscriptSessionMetadata,
	scanNativeTranscriptPrefix,
} from "./codex-transcript-read-source";

const historyBaseSchema = z.object({
	thread_id: z.string().min(1),
	end_byte_offset: z.number().int().positive().safe(),
	end_ordinal_exclusive: z.number().int().positive().safe(),
});

/** 顺序消费者读取同一 UUID 的有效历史；分页消费者继续保留各分片的本地偏移。 */
export async function openCodexTranscriptHistoryReadSource(
	path: string,
	nativeSessionId: string,
): Promise<CodexTranscriptReadSource> {
	const ownedSources: CodexTranscriptReadSource[] = [];
	const segments: { source: CodexTranscriptReadSource; endByteOffset: number }[] = [];
	const visitedPaths = new Set<string>();
	const root = await openCodexTranscriptReadSource(path, nativeSessionId);
	ownedSources.push(root);
	try {
		const rootMetadata = await root.stat();
		let knownPaths: string[] | null = null;
		const rootHeader = (await readCodexTranscriptSessionMetadata(root)).record.payload as Record<string, unknown>;
		const appendSegment = async (
			source: CodexTranscriptReadSource,
			endByteOffset: number,
			expectedRecordCount: number | null,
		): Promise<number> => {
			const logicalPath = codexTranscriptJsonlPath(source.nativePath);
			if (visitedPaths.has(logicalPath) || visitedPaths.size >= 64)
				throw new Error("Codex 历史分片有循环或超过读取预算。");
			visitedPaths.add(logicalPath);
			const { record } = await readCodexTranscriptSessionMetadata(source);
			if (!codexTranscriptMetadataMatchesPersistentMainConversation(nativeSessionId, record))
				throw new Error("Codex 历史分片的原生会话身份不匹配。");
			const metadata = record.payload as Record<string, unknown>;
			if (source !== root && typeof rootHeader.cwd === "string" && metadata.cwd !== rootHeader.cwd)
				throw new Error("Codex 父历史分片工作目录归属不匹配。");
			let inheritedRecordCount = 0;
			if (metadata.history_base != null) {
				const base = historyBaseSchema.parse(metadata.history_base);
				if (metadata.history_mode !== "paginated") throw new Error("Codex 历史分片的分页模式不匹配。");
				knownPaths ??= await listKnownCodexTranscriptSegmentPaths(
					codexTranscriptNativeStorageRoot(root.nativePath) ?? dirname(root.nativePath),
					nativeSessionId,
					{ includeCompressedTranscripts: true },
				);
				const suffix =
					base.thread_id === nativeSessionId
						? `-${nativeSessionId}.jsonl`
						: `-${nativeSessionId}_${base.thread_id}.jsonl`;
				const parents = knownPaths.filter((candidate) => codexTranscriptJsonlPath(candidate).endsWith(suffix));
				if (parents.length !== 1) throw new Error("Codex 父历史分片缺失或归属不唯一。");
				const parentPath = parents[0];
				if (!parentPath) throw new Error("Codex 父历史分片缺失。");
				const parent = await openCodexTranscriptReadSource(parentPath);
				ownedSources.push(parent);
				inheritedRecordCount = await appendSegment(parent, base.end_byte_offset, base.end_ordinal_exclusive);
			}
			if (endByteOffset > (await source.stat()).size) throw new Error("Codex 历史分片被截断。");
			if (expectedRecordCount !== null) {
				let localRecordCount = 0;
				let lastByte = -1;
				await scanNativeTranscriptPrefix(source, endByteOffset, (chunk) => {
					for (const byte of chunk) if (byte === 10) localRecordCount += 1;
					lastByte = chunk.at(-1) ?? lastByte;
				});
				if (lastByte !== 10 || localRecordCount + inheritedRecordCount !== expectedRecordCount)
					throw new Error("Codex 父历史分片的字节或累计记录边界不匹配。");
			}
			segments.push({ source, endByteOffset });
			return expectedRecordCount ?? 0;
		};
		await appendSegment(root, rootMetadata.size, null);
		if (segments.length === 1) return root;
		const logicalByteLength = segments.reduce((total, segment) => total + segment.endByteOffset, 0);
		const segmentVersions = await Promise.all(
			segments.map(async ({ source, endByteOffset }) => {
				const metadata = await source.stat();
				return [
					codexTranscriptJsonlPath(source.nativePath),
					metadata.dev,
					metadata.ino,
					source === root ? null : endByteOffset,
				];
			}),
		);
		const logicalInode = Number.parseInt(
			createHash("sha256").update(JSON.stringify(segmentVersions)).digest("hex").slice(0, 12),
			16,
		);
		return {
			nativePath: root.nativePath,
			physicalReadBytesReportedToCollectionCostRecorder: true,
			streamingRangeReads: segments.some(({ source }) => source.streamingRangeReads),
			async read(buffer, offset, length, position) {
				let segmentStart = 0;
				let bytesRead = 0;
				for (const { source, endByteOffset } of segments) {
					const start = Math.max(0, position - segmentStart);
					const count = Math.min(length - bytesRead, Math.max(0, endByteOffset - start));
					if (count > 0) {
						const result = await source.read(buffer, offset + bytesRead, count, start);
						if (result.bytesRead !== count) throw new Error("Codex 历史分片在读取期间发生变化。");
						bytesRead += count;
						position += count;
					}
					segmentStart += endByteOffset;
					if (bytesRead === length) break;
				}
				return { bytesRead };
			},
			async stat() {
				for (const { source, endByteOffset } of segments)
					if ((await source.stat()).size < endByteOffset) throw new Error("Codex 历史分片被截断。");
				return Object.assign(Object.create(Object.getPrototypeOf(rootMetadata)) as Stats, await root.stat(), {
					size: logicalByteLength,
					ino: logicalInode,
				});
			},
			async close() {
				await Promise.all(ownedSources.map((source) => source.close()));
			},
		};
	} catch (error) {
		await Promise.all(ownedSources.map((source) => source.close()));
		throw error;
	}
}

export async function statCodexTranscriptHistoryReadSource(path: string, nativeSessionId: string) {
	const source = await openCodexTranscriptHistoryReadSource(path, nativeSessionId);
	try {
		return await source.stat();
	} finally {
		await source.close();
	}
}
