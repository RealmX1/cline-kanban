import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { type FileHandle, mkdtemp, open, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import pLimit from "p-limit";
import streamJson from "stream-json";
import Filter from "stream-json/filters/Filter.js";
import Stringer from "stream-json/Stringer.js";
import { decompressStream } from "zstd-stream";
import { recordDailyWorkProgressFileRead } from "../diagnostics/daily-work-progress-collection-cost-recorder";
import { readCodexThreadRolloutPath } from "./codex-native-transcript-current-pointer";

const TRANSCRIPT_READ_CHUNK_BYTES = 64 * 1024;
// EXPERIMENT_NODE: 用真实历史的命中率与磁盘成本校准 256 MiB LRU；超大文件始终按范围流读。
const MAXIMUM_CACHED_DECODED_BYTES = 256 * 1024 * 1024;
// 同时限制私有快照句柄，避免许多小转录耗尽文件描述符。
const MAXIMUM_CACHED_SOURCE_VERSIONS = 64;
const sharedCodexTranscriptDecoderSlots = pLimit(2);
async function acquireCodexTranscriptDecoderSlot(signal?: AbortSignal): Promise<() => void> {
	signal?.throwIfAborted();
	let releaseAcquiredSlot: (() => void) | undefined;
	const acquired = new Promise<() => void>((resolve) => {
		void sharedCodexTranscriptDecoderSlots(async () => {
			if (signal?.aborted) return;
			await new Promise<void>((release) => {
				releaseAcquiredSlot = release;
				resolve(release);
			});
		});
	});
	if (!signal) return acquired;
	let abortListener: () => void = () => {};
	const aborted = new Promise<never>((_resolve, reject) => {
		abortListener = () => reject(signal.reason);
		signal.addEventListener("abort", abortListener, { once: true });
	});
	try {
		return await Promise.race([acquired, aborted]);
	} catch (error) {
		releaseAcquiredSlot?.();
		throw error;
	} finally {
		signal.removeEventListener("abort", abortListener);
	}
}
let activeCodexTranscriptDecoders = 0;
let maximumObservedCodexTranscriptDecoderConcurrency = 0;

export interface NativeTranscriptReadHandle {
	nativePath?: string;
	physicalReadBytesReportedToCollectionCostRecorder?: boolean;
	read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
	stat(): Promise<Stats>;
	close(): Promise<void>;
	hashPrefix?(endByteOffset: number): Promise<string>;
	streamingRangeReads?: boolean;
	scanPrefix?(endByteOffset: number, inspectChunk: (chunk: Uint8Array) => void): Promise<void>;
}
export interface CodexTranscriptReadSource extends NativeTranscriptReadHandle {
	/** 始终是原生存储路径，私有快照不能参与会话身份或续跑。 */
	nativePath: string;
}

export function codexTranscriptJsonlPath(path: string): string {
	return path.endsWith(".jsonl.zst") ? path.slice(0, -4) : path;
}

export function codexTranscriptPathMatchesSession(path: string, nativeSessionId: string): boolean {
	const name = basename(codexTranscriptJsonlPath(path));
	return (
		name.endsWith(`${nativeSessionId}.jsonl`) || (name.includes(`${nativeSessionId}_`) && name.endsWith(".jsonl"))
	);
}

function physicalVersion(metadata: Stats): string {
	return `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`;
}

class CodexTranscriptSourceChangedError extends Error {
	constructor() {
		super("Codex 转录在读取期间发生变化，等待重新核验。");
	}
}

export function codexTranscriptNativeStorageRoot(path: string): string | null {
	let directory = dirname(path);
	while (dirname(directory) !== directory && !["sessions", "archived_sessions"].includes(basename(directory)))
		directory = dirname(directory);
	return ["sessions", "archived_sessions"].includes(basename(directory)) ? directory : null;
}

export async function assertCodexTranscriptNativeStoragePathOwnership(path: string): Promise<void> {
	const directory = codexTranscriptNativeStorageRoot(path);
	if (!directory) return;
	const location = relative(await realpath(directory), await realpath(path));
	if (isAbsolute(location) || location === ".." || location.startsWith(`..${sep}`))
		throw new Error("Codex 转录的真实路径超出已绑定原生存储目录。");
}

/** 与续接预检共用解码器；原生文件只读，打开时的物理长度封顶。 */
export async function* readCodexDecodedTranscriptChunks(
	handle: FileHandle,
	path: string,
	physicalByteLength: number,
	assertWithinReadBudget: () => void = () => {},
	signal?: AbortSignal,
): AsyncGenerator<Uint8Array, void, unknown> {
	async function* readPhysicalChunks() {
		for (let position = 0; position < physicalByteLength; ) {
			signal?.throwIfAborted();
			assertWithinReadBudget();
			const buffer = Buffer.allocUnsafe(Math.min(TRANSCRIPT_READ_CHUNK_BYTES, physicalByteLength - position));
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
			if (bytesRead === 0) throw new CodexTranscriptSourceChangedError();
			position += bytesRead;
			recordDailyWorkProgressFileRead(bytesRead);
			yield buffer.subarray(0, bytesRead);
		}
	}
	if (!path.endsWith(".jsonl.zst")) {
		yield* readPhysicalChunks();
		return;
	}
	const releaseDecoderSlot = await acquireCodexTranscriptDecoderSlot(signal);
	activeCodexTranscriptDecoders += 1;
	maximumObservedCodexTranscriptDecoderConcurrency = Math.max(
		maximumObservedCodexTranscriptDecoderConcurrency,
		activeCodexTranscriptDecoders,
	);
	try {
		const chunks = readPhysicalChunks();
		let cancelled = false;
		// Node 22.0 的 Readable.toWeb 取消路径可能重复关闭 controller；直接交接迭代器。
		const input = new ReadableStream<Uint8Array>(
			{
				async pull(controller) {
					try {
						const { done, value } = await chunks.next();
						if (cancelled) return;
						if (done) controller.close();
						else controller.enqueue(value);
					} catch (error) {
						if (!cancelled) controller.error(error);
					}
				},
				async cancel() {
					cancelled = true;
					await chunks.return();
				},
			},
			{ highWaterMark: 0 },
		);
		const decoded = await decompressStream(input, { highWaterMark: TRANSCRIPT_READ_CHUNK_BYTES });
		const reader = decoded.getReader();
		try {
			for (;;) {
				signal?.throwIfAborted();
				assertWithinReadBudget();
				const { done, value } = await reader.read();
				if (done) return;
				yield value;
			}
		} finally {
			try {
				await reader.cancel();
			} finally {
				reader.releaseLock();
				await chunks.return();
			}
		}
	} finally {
		activeCodexTranscriptDecoders -= 1;
		releaseDecoderSlot();
	}
}

interface DecodedTranscriptVersion {
	logicalByteLength: number;
	sha256: string;
	snapshot: FileHandle | null;
	references: number;
}

export function createCodexTranscriptReadSourceCache(options: { maximumCachedDecodedBytes?: number } = {}) {
	const maximumBytes = options.maximumCachedDecodedBytes ?? MAXIMUM_CACHED_DECODED_BYTES;
	const decodeLimit = pLimit(2);
	const versions = new Map<string, DecodedTranscriptVersion>();
	const inFlight = new Map<string, Promise<DecodedTranscriptVersion>>();
	let cachedDecodedBytes = 0;
	let completedDecodeCount = 0;
	async function withDecodeSlot<T>(operation: () => Promise<T>): Promise<T> {
		return decodeLimit(operation);
	}
	async function discardSnapshot(entry: DecodedTranscriptVersion) {
		if (!entry.snapshot) return;
		const snapshot = entry.snapshot;
		entry.snapshot = null;
		cachedDecodedBytes -= entry.logicalByteLength;
		await snapshot.close();
	}
	async function reserveSnapshotBytes(bytes: number): Promise<boolean> {
		for (const [key, candidate] of versions) {
			if (cachedDecodedBytes + bytes <= maximumBytes) break;
			if (candidate.references > 0 || !candidate.snapshot) continue;
			versions.delete(key);
			await discardSnapshot(candidate);
		}
		if (cachedDecodedBytes + bytes > maximumBytes) return false;
		cachedDecodedBytes += bytes;
		return true;
	}
	async function decodeVersion(handle: FileHandle, nativePath: string, metadata: Stats) {
		const entry: DecodedTranscriptVersion = { logicalByteLength: 0, sha256: "", snapshot: null, references: 0 };
		const directory = await mkdtemp(join(tmpdir(), "kanban-codex-private-read-snapshot-"));
		try {
			entry.snapshot = await open(join(directory, "decoded-transcript.jsonl"), "wx+", 0o600);
			// 解开目录引用后只保留私有只读接口；崩溃/重启自动回收，不遗留历史副本。
			await rm(directory, { recursive: true });
			const hash = createHash("sha256");
			for await (const chunk of readCodexDecodedTranscriptChunks(handle, nativePath, metadata.size)) {
				hash.update(chunk);
				if (entry.snapshot) {
					if (!(await reserveSnapshotBytes(chunk.length))) await discardSnapshot(entry);
					else {
						try {
							await entry.snapshot.writeFile(chunk);
						} catch (error) {
							cachedDecodedBytes -= chunk.length;
							throw error;
						}
					}
				}
				entry.logicalByteLength += chunk.length;
			}
			if (
				physicalVersion(await handle.stat()) !== physicalVersion(metadata) ||
				physicalVersion(await stat(nativePath)) !== physicalVersion(metadata)
			)
				throw new CodexTranscriptSourceChangedError();
			entry.sha256 = hash.digest("hex");
			await entry.snapshot?.chmod(0o400);
			completedDecodeCount += 1;
			return entry;
		} catch (error) {
			await discardSnapshot(entry);
			throw error;
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
	return {
		async open(requestedPath: string): Promise<CodexTranscriptReadSource> {
			const ordinaryPath = codexTranscriptJsonlPath(resolve(requestedPath));
			const counterpart = requestedPath.endsWith(".jsonl.zst") ? ordinaryPath : `${ordinaryPath}.zst`;
			for (let attempt = 0; attempt < 2; attempt += 1) {
				let handle: FileHandle | null = null;
				let nativePath = resolve(requestedPath);
				try {
					try {
						handle = await open(nativePath, "r");
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
						nativePath = counterpart;
						handle = await open(nativePath, "r");
					}
					const sourceHandle = handle;
					await assertCodexTranscriptNativeStoragePathOwnership(nativePath);
					const metadata = await sourceHandle.stat();
					if (!metadata.isFile()) throw new Error("Codex 转录不是普通文件。");
					if (!nativePath.endsWith(".jsonl.zst")) {
						if (physicalVersion(await stat(nativePath)) !== physicalVersion(metadata))
							throw new CodexTranscriptSourceChangedError();
						return {
							nativePath,
							physicalReadBytesReportedToCollectionCostRecorder: true,
							async read(buffer, offset, length, position) {
								const result = await sourceHandle.read(buffer, offset, length, position);
								if (length > 0) recordDailyWorkProgressFileRead(result.bytesRead);
								return result;
							},
							stat: () => sourceHandle.stat(),
							close: () => sourceHandle.close(),
						};
					}
					const key = `${nativePath}:${physicalVersion(metadata)}`;
					let entry = versions.get(key);
					if (!entry) {
						let pending = inFlight.get(key);
						if (!pending) {
							pending = withDecodeSlot(() => decodeVersion(sourceHandle, nativePath, metadata));
							inFlight.set(key, pending);
							pending.finally(() => inFlight.delete(key)).catch(() => {});
						}
						entry = await pending;
					}
					if (
						physicalVersion(await sourceHandle.stat()) !== physicalVersion(metadata) ||
						physicalVersion(await stat(nativePath)) !== physicalVersion(metadata)
					)
						throw new CodexTranscriptSourceChangedError();
					const decoded = entry;
					versions.delete(key);
					versions.set(key, decoded);
					decoded.references += 1;
					while (versions.size > MAXIMUM_CACHED_SOURCE_VERSIONS) {
						const oldest = [...versions].find(([, value]) => value.references === 0);
						if (!oldest) break;
						versions.delete(oldest[0]);
						await discardSnapshot(oldest[1]);
					}
					let closed = false;
					const assertUnchanged = async () => {
						if (
							closed ||
							physicalVersion(await sourceHandle.stat()) !== physicalVersion(metadata) ||
							physicalVersion(await stat(nativePath)) !== physicalVersion(metadata)
						)
							throw new CodexTranscriptSourceChangedError();
					};
					const streamPrefix = async (end: number, onChunk: (chunk: Uint8Array, position: number) => void) => {
						await assertUnchanged();
						await withDecodeSlot(async () => {
							let position = 0;
							for await (const chunk of readCodexDecodedTranscriptChunks(
								sourceHandle,
								nativePath,
								metadata.size,
							)) {
								onChunk(chunk.subarray(0, Math.max(0, end - position)), position);
								position += chunk.length;
								if (position >= end) break;
							}
							if (position < end) throw new CodexTranscriptSourceChangedError();
						});
						await assertUnchanged();
					};
					return {
						nativePath,
						physicalReadBytesReportedToCollectionCostRecorder: true,
						streamingRangeReads: decoded.snapshot === null,
						async read(buffer, offset, length, position) {
							await assertUnchanged();
							const count = Math.min(length, Math.max(0, decoded.logicalByteLength - position));
							if (decoded.snapshot) {
								const result = await decoded.snapshot.read(buffer, offset, count, position);
								if (count > 0) recordDailyWorkProgressFileRead(result.bytesRead);
								return result;
							}
							if (count === 0) return { bytesRead: 0 };
							await streamPrefix(position + count, (chunk, chunkPosition) => {
								const start = Math.max(0, position - chunkPosition);
								if (start < chunk.length)
									buffer.set(chunk.subarray(start), offset + Math.max(0, chunkPosition - position));
							});
							return { bytesRead: count };
						},
						async stat() {
							await assertUnchanged();
							return Object.assign(Object.create(Object.getPrototypeOf(metadata)) as Stats, metadata, {
								size: decoded.logicalByteLength,
							});
						},
						scanPrefix: (end, inspectChunk) => streamPrefix(end, inspectChunk),
						async hashPrefix(end) {
							await assertUnchanged();
							if (end > decoded.logicalByteLength) throw new CodexTranscriptSourceChangedError();
							if (end === decoded.logicalByteLength) return decoded.sha256;
							const hash = createHash("sha256");
							await streamPrefix(end, (chunk) => {
								hash.update(chunk);
							});
							return hash.digest("hex");
						},
						async close() {
							if (closed) return;
							closed = true;
							decoded.references -= 1;
							await sourceHandle.close();
						},
					};
				} catch (error) {
					await handle?.close();
					if (
						attempt === 0 &&
						(error instanceof CodexTranscriptSourceChangedError ||
							(error as NodeJS.ErrnoException).code === "ENOENT")
					)
						continue;
					throw error;
				}
			}
			throw new CodexTranscriptSourceChangedError();
		},
		inspect: () => ({
			cachedDecodedBytes,
			completedDecodeCount,
			maximumObservedConcurrentDecodes: maximumObservedCodexTranscriptDecoderConcurrency,
		}),
		async dispose() {
			await Promise.allSettled(inFlight.values());
			for (const [key, entry] of versions) {
				if (entry.references > 0) continue;
				versions.delete(key);
				await discardSnapshot(entry);
			}
		},
	};
}

const sharedCodexTranscriptReadSourceCache = createCodexTranscriptReadSourceCache();
export async function openCodexTranscriptReadSource(
	path: string,
	nativeSessionId?: string,
): Promise<CodexTranscriptReadSource> {
	try {
		return await sharedCodexTranscriptReadSourceCache.open(path);
	} catch (error) {
		const root = codexTranscriptNativeStorageRoot(path);
		if (!root || !nativeSessionId || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const candidate = readCodexThreadRolloutPath(join(dirname(root), "state_5.sqlite"), nativeSessionId);
		if (!candidate || codexTranscriptJsonlPath(candidate) === codexTranscriptJsonlPath(path)) throw error;
		const canonicalRoot = await realpath(root);
		const canonicalCandidate = await realpath(candidate).catch(() =>
			realpath(candidate.endsWith(".jsonl.zst") ? codexTranscriptJsonlPath(candidate) : `${candidate}.zst`),
		);
		const allowedRoots = [
			canonicalRoot,
			join(dirname(canonicalRoot), basename(root) === "sessions" ? "archived_sessions" : "sessions"),
		];
		if (
			!allowedRoots.some((allowed) => {
				const location = relative(allowed, canonicalCandidate);
				return !isAbsolute(location) && location !== ".." && !location.startsWith(`..${sep}`);
			})
		)
			throw new Error("Codex 当前原生指针超出已绑定存储目录。");
		const source = await sharedCodexTranscriptReadSourceCache.open(candidate);
		try {
			if (
				!codexTranscriptMetadataMatchesPersistentMainConversation(
					nativeSessionId,
					(await readCodexTranscriptSessionMetadata(source)).record,
				)
			)
				throw new Error("Codex 当前原生指针的会话身份不可验证。");
			return source;
		} catch (failure) {
			await source.close();
			throw failure;
		}
	}
}

export async function statCodexTranscriptReadSource(path: string, nativeSessionId?: string): Promise<Stats> {
	const source = await openCodexTranscriptReadSource(path, nativeSessionId);
	try {
		return await source.stat();
	} finally {
		await source.close();
	}
}

export async function readCodexTranscriptCompleteLines(
	path: string,
	previousByteOffset: number,
	maximumBytes: number,
	nativeSessionId?: string,
) {
	const source = await openCodexTranscriptReadSource(path, nativeSessionId);
	try {
		return await readCodexTranscriptCompleteLinesFromSource(source, previousByteOffset, maximumBytes);
	} finally {
		await source.close();
	}
}

export async function readCodexTranscriptCompleteLinesFromSource(
	source: NativeTranscriptReadHandle,
	previousByteOffset: number,
	maximumBytes: number,
) {
	const metadata = await source.stat();
	const start = metadata.size < previousByteOffset ? 0 : previousByteOffset;
	const buffer = Buffer.allocUnsafe(Math.min(maximumBytes, Math.max(0, metadata.size - start)));
	const { bytesRead } = await source.read(buffer, 0, buffer.length, start);
	const lastNewline = buffer.subarray(0, bytesRead).lastIndexOf(10);
	const nextByteOffset = lastNewline < 0 ? start : start + lastNewline + 1;
	return {
		completeLines:
			lastNewline < 0
				? []
				: buffer
						.subarray(0, lastNewline + 1)
						.toString("utf8")
						.split(/\r?\n/u)
						.filter(Boolean),
		nextByteOffset,
		fileSizeBytes: metadata.size,
		fileModifiedAtMilliseconds: metadata.mtimeMs,
		fileWasTruncated: metadata.size < previousByteOffset,
		appendedBytesRemainBeyondIncrementalReadBudget:
			metadata.size - start > maximumBytes && nextByteOffset < metadata.size,
	};
}

/** 巨型 base_instructions 不进入内存对象；首行本身仍完整解析，返回原始 JSONL 字节边界。 */
const sessionMetadataReads = new WeakMap<
	NativeTranscriptReadHandle,
	Promise<{ record: Record<string, unknown>; endByteOffset: number }>
>();
export function readCodexTranscriptSessionMetadata(handle: NativeTranscriptReadHandle) {
	let pending = sessionMetadataReads.get(handle);
	if (!pending) {
		pending = readCodexTranscriptSessionMetadataUncached(handle);
		sessionMetadataReads.set(handle, pending);
	}
	return pending;
}
async function readCodexTranscriptSessionMetadataUncached(handle: NativeTranscriptReadHandle) {
	const sourceByteLength = (await handle.stat()).size;
	const deadlineAt = performance.now() + 3000;
	let endByteOffset = 0;
	let terminated = false;
	const filteredChunks: Buffer[] = [];
	let filteredByteLength = 0;
	async function* firstLineChunks() {
		while (!terminated && endByteOffset < sourceByteLength) {
			if (performance.now() >= deadlineAt) throw new Error("Codex 身份元数据读取超时。");
			const chunk = Buffer.alloc(
				Math.min(
					handle.streamingRangeReads ? 16 * 1024 * 1024 : TRANSCRIPT_READ_CHUNK_BYTES,
					sourceByteLength - endByteOffset,
				),
			);
			const { bytesRead } = await handle.read(chunk, 0, chunk.length, endByteOffset);
			if (bytesRead === 0) break;
			const newline = chunk.subarray(0, bytesRead).indexOf(10);
			const length = newline < 0 ? bytesRead : newline + 1;
			endByteOffset += length;
			terminated = newline >= 0;
			yield chunk.subarray(0, length);
		}
	}
	await pipeline(
		Readable.from(firstLineChunks()),
		streamJson.parser({ packValues: false, packKeys: true }),
		new Filter({
			filter:
				/^(type|timestamp|payload\.(id|session_id|source|thread_source|timestamp|cwd|history_mode|history_base|forked_from_id|title|thread_name|git))($|\.)/u,
		}),
		new Stringer(),
		new Writable({
			write(chunk: Buffer, _encoding, callback) {
				filteredByteLength += chunk.length;
				if (filteredByteLength > 256 * 1024) {
					callback(new Error("Codex 身份元数据超出读取预算。"));
					return;
				}
				filteredChunks.push(chunk);
				callback();
			},
		}),
	);
	const record = JSON.parse(Buffer.concat(filteredChunks).toString("utf8")) as Record<string, unknown>;
	if (!terminated || !record || record.type !== "session_meta")
		throw new Error("Codex 转录缺少完整的元数据首行，无法核实原生身份。");
	return { record, endByteOffset };
}

export function codexTranscriptMetadataMatchesPersistentMainConversation(
	nativeSessionId: string,
	record: Record<string, unknown>,
): boolean {
	const payload = record.payload as Record<string, unknown> | null;
	if (record.type !== "session_meta" || !payload || typeof payload !== "object") return false;
	const source = payload.source as Record<string, unknown> | null;
	return (
		payload.id === nativeSessionId &&
		(payload.session_id === undefined || payload.session_id === nativeSessionId) &&
		(payload.thread_source === undefined || payload.thread_source === "user") &&
		!["memory_consolidation", "guardian_review"].includes(String(payload.source)) &&
		!(source && typeof source === "object" && (source.subagent !== undefined || source.internal !== undefined))
	);
}

export async function scanNativeTranscriptPrefix(
	source: NativeTranscriptReadHandle,
	endByteOffset: number,
	inspectChunk: (chunk: Uint8Array) => void,
): Promise<void> {
	if (source.streamingRangeReads && source.scanPrefix) return source.scanPrefix(endByteOffset, inspectChunk);
	const buffer = Buffer.alloc(TRANSCRIPT_READ_CHUNK_BYTES);
	for (let position = 0; position < endByteOffset; ) {
		const length = Math.min(buffer.length, endByteOffset - position);
		const { bytesRead } = await source.read(buffer, 0, length, position);
		if (bytesRead !== length) throw new CodexTranscriptSourceChangedError();
		inspectChunk(buffer.subarray(0, bytesRead));
		position += bytesRead;
	}
}
