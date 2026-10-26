import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	parseTranscriptJsonRecord,
	readTranscriptRecord,
} from "../agent-session-history/bounded-agent-transcript-reader";
import { countDailyWorkProgressCollectionCost } from "../diagnostics/daily-work-progress-collection-cost-recorder";
import { readCountedTaskUserPromptStatisticsJsonLines } from "./task-user-prompt-statistics-counted-json-lines-reader";

// EXPERIMENT_NODE: 用自然窗口验证缓存容量与重建成本的权衡，始终保留身份和历史边界复验。
const MAXIMUM_CACHED_DIRECTORIES = 2_048;
const MAXIMUM_CACHED_DIRECTORY_ENTRIES = 65_536;
const MAXIMUM_CACHED_SEGMENT_HEADERS = 1_024;
const MAXIMUM_CACHED_NATIVE_SESSION_FILTERS_PER_DIRECTORY = 16;
const MAXIMUM_CACHED_MATCHING_SEGMENT_PATHS = 8_192;
type CodexStatisticsFileIdentityAndChangeMetadata = Awaited<
	ReturnType<typeof readCodexStatisticsFileIdentityAndChangeMetadata>
>;
async function readCodexStatisticsFileIdentityAndChangeMetadata(path: string) {
	const value = await stat(path, { bigint: true });
	return {
		fingerprint: `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`,
		size: value.size,
	};
}
interface CodexStatisticsVerifiedSegmentHeader {
	nativeSessionId: string;
	metadata: CodexStatisticsFileIdentityAndChangeMetadata;
	firstRecord: Record<string, unknown>;
}
interface CodexDirectoryInventorySnapshot {
	fingerprint: string;
	entryCount: number;
	childDirectoryPaths: string[];
	fileNames: string[];
	matchingPathsByNativeSessionId: Map<string, string[]>;
}

/** 每个 collector 独享、有界且不持久化；重启或淘汰后重新验证，缓存从不提供新身份。 */
export function createCodexStatisticsVerifiedHistoryReadCache() {
	const directories = new Map<string, CodexDirectoryInventorySnapshot>();
	const headers = new Map<string, CodexStatisticsVerifiedSegmentHeader>();
	let directoryEntryCount = 0;
	let cachedMatchingSegmentPathCount = 0;
	function forgetDirectory(path: string) {
		const snapshot = directories.get(path);
		directoryEntryCount -= snapshot?.entryCount ?? 0;
		for (const matchingPaths of snapshot?.matchingPathsByNativeSessionId.values() ?? [])
			cachedMatchingSegmentPathCount -= matchingPaths.length;
		directories.delete(path);
	}
	return {
		invalidateSession(nativeSessionId: string) {
			for (const [path, header] of headers) if (header.nativeSessionId === nativeSessionId) headers.delete(path);
			countDailyWorkProgressCollectionCost("codex_verified_history_cache_invalidations");
		},
		async readPrefix(path: string, nativeSessionId: string, maximumBytes: number) {
			path = resolve(path);
			const metadata = await readCodexStatisticsFileIdentityAndChangeMetadata(path);
			const cached = headers.get(path);
			if (cached?.nativeSessionId === nativeSessionId && cached.metadata.fingerprint === metadata.fingerprint) {
				headers.delete(path);
				headers.set(path, cached);
				countDailyWorkProgressCollectionCost("codex_verified_history_cache_hits");
				return { firstRecord: cached.firstRecord, rewrittenWithoutAppend: false };
			}
			headers.delete(path);
			if (cached) countDailyWorkProgressCollectionCost("codex_verified_history_cache_invalidations");
			const prefix = await readCountedTaskUserPromptStatisticsJsonLines(
				path,
				0,
				maximumBytes,
				"codex_prefix_validation",
			);
			const first = prefix.completeLines[0] ? parseTranscriptJsonRecord(prefix.completeLines[0]) : null;
			const payload = readTranscriptRecord(first?.payload);
			if (
				first?.type === "session_meta" &&
				(payload?.id !== nativeSessionId ||
					(payload.session_id !== undefined && payload.session_id !== nativeSessionId))
			)
				throw new Error("Codex 历史分段身份不可验证");
			const after = await readCodexStatisticsFileIdentityAndChangeMetadata(path);
			if (metadata.fingerprint !== after.fingerprint)
				throw new Error("Codex 分段在验证期间发生变化，等待下一轮重新核验");
			// 只保存续接所需的元信息，丢弃可能巨大的 base_instructions 等正文。
			const historyBase = readTranscriptRecord(payload?.history_base);
			const boundedHistoryBase =
				payload?.history_base == null
					? payload?.history_base
					: historyBase
						? {
								thread_id: historyBase.thread_id,
								end_byte_offset: historyBase.end_byte_offset,
								end_ordinal_exclusive: historyBase.end_ordinal_exclusive,
							}
						: true;
			const firstRecord =
				first?.type === "session_meta"
					? {
							type: first.type,
							payload: {
								id: nativeSessionId,
								session_id: payload?.session_id,
								history_mode: payload?.history_mode === "paginated" ? "paginated" : null,
								history_base: boundedHistoryBase,
							},
						}
					: first;
			if (firstRecord?.type === "session_meta") {
				headers.set(path, { nativeSessionId, metadata, firstRecord });
				while (headers.size > MAXIMUM_CACHED_SEGMENT_HEADERS) {
					const oldest = headers.keys().next().value;
					if (oldest === undefined) break;
					headers.delete(oldest);
				}
			}
			return { firstRecord, rewrittenWithoutAppend: cached !== undefined && metadata.size <= cached.metadata.size };
		},
		async listSegmentPaths(root: string, nativeSessionId: string): Promise<string[]> {
			const pendingDirectories = [resolve(root)];
			const paths: string[] = [];
			while (pendingDirectories.length) {
				const directory = pendingDirectories.pop();
				if (!directory) break;
				countDailyWorkProgressCollectionCost("codex_directory_metadata_checks");
				const metadata = await readCodexStatisticsFileIdentityAndChangeMetadata(directory).catch(() => null);
				if (!metadata) {
					forgetDirectory(directory);
					continue;
				}
				let snapshot = directories.get(directory);
				if (snapshot?.fingerprint !== metadata.fingerprint) {
					forgetDirectory(directory);
					countDailyWorkProgressCollectionCost("codex_directory_enumerations");
					// 与原枚举器一致：目录读取失败只隔离该子树，不复用旧清单，也不缓存失败。
					const entries = await readdir(directory, { withFileTypes: true }).catch(() => null);
					if (!entries) continue;
					const verifiedMetadata = await readCodexStatisticsFileIdentityAndChangeMetadata(directory).catch(
						() => null,
					);
					if (!verifiedMetadata) continue;
					if (verifiedMetadata.fingerprint !== metadata.fingerprint)
						throw new Error("Codex 目录在枚举期间发生变化，等待下一轮重新核验");
					snapshot = {
						fingerprint: metadata.fingerprint,
						entryCount: entries.length,
						childDirectoryPaths: entries
							.filter((entry) => entry.isDirectory())
							.map((entry) => join(directory, entry.name)),
						fileNames: entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
						matchingPathsByNativeSessionId: new Map(),
					};
					directories.set(directory, snapshot);
					directoryEntryCount += entries.length;
				} else {
					directories.delete(directory);
					directories.set(directory, snapshot);
				}
				while (
					directories.size > MAXIMUM_CACHED_DIRECTORIES ||
					directoryEntryCount > MAXIMUM_CACHED_DIRECTORY_ENTRIES
				) {
					const oldest = directories.keys().next().value;
					if (oldest === undefined) break;
					forgetDirectory(oldest);
				}
				for (const childDirectoryPath of snapshot.childDirectoryPaths) pendingDirectories.push(childDirectoryPath);
				let matchingPaths = snapshot.matchingPathsByNativeSessionId.get(nativeSessionId);
				if (!matchingPaths) {
					countDailyWorkProgressCollectionCost(
						"codex_directory_candidate_filter_entries",
						snapshot.fileNames.length,
					);
					matchingPaths = snapshot.fileNames
						.filter(
							(name) =>
								name.endsWith(`${nativeSessionId}.jsonl`) ||
								(name.includes(`${nativeSessionId}_`) && name.endsWith(".jsonl")),
						)
						.map((name) => join(directory, name));
					if (
						directories.get(directory) === snapshot &&
						matchingPaths.length <= MAXIMUM_CACHED_MATCHING_SEGMENT_PATHS
					) {
						if (cachedMatchingSegmentPathCount + matchingPaths.length > MAXIMUM_CACHED_MATCHING_SEGMENT_PATHS) {
							for (const cachedDirectory of directories.values())
								cachedDirectory.matchingPathsByNativeSessionId.clear();
							cachedMatchingSegmentPathCount = 0;
						}
						if (
							snapshot.matchingPathsByNativeSessionId.size >= MAXIMUM_CACHED_NATIVE_SESSION_FILTERS_PER_DIRECTORY
						) {
							const oldest = snapshot.matchingPathsByNativeSessionId.keys().next().value;
							if (oldest !== undefined) {
								cachedMatchingSegmentPathCount -=
									snapshot.matchingPathsByNativeSessionId.get(oldest)?.length ?? 0;
								snapshot.matchingPathsByNativeSessionId.delete(oldest);
							}
						}
						snapshot.matchingPathsByNativeSessionId.set(nativeSessionId, matchingPaths);
						cachedMatchingSegmentPathCount += matchingPaths.length;
					}
				}
				for (const matchingPath of matchingPaths) paths.push(matchingPath);
			}
			return paths;
		},
	};
}
export type CodexStatisticsVerifiedHistoryReadCache = ReturnType<typeof createCodexStatisticsVerifiedHistoryReadCache>;
