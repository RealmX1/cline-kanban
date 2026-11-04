import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { type FileHandle, stat } from "node:fs/promises";
import { z } from "zod";

const TRANSCRIPT_PREFIX_HASH_CHUNK_BYTES = 64 * 1024;
export const nativeTranscriptFilePrefixSnapshotSchema = z.object({
	deviceId: z.number(),
	inodeId: z.number(),
	createdAtMs: z.number(),
	endByteOffset: z.number().int().nonnegative(),
	prefixSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
type NativeTranscriptFilePrefixSnapshot = z.infer<typeof nativeTranscriptFilePrefixSnapshotSchema>;

export class NativeTranscriptSnapshotInvalidError extends Error {
	constructor() {
		super("会话快照的来源已被替换、截断或改写，请刷新到最新后重试。");
	}
}

function matchesSnapshotFile(metadata: Stats, snapshot: NativeTranscriptFilePrefixSnapshot): boolean {
	return (
		metadata.isFile() &&
		metadata.dev === snapshot.deviceId &&
		metadata.ino === snapshot.inodeId &&
		metadata.birthtimeMs === snapshot.createdAtMs &&
		metadata.size >= snapshot.endByteOffset
	);
}

async function hashTranscriptFilePrefix(handle: FileHandle, endByteOffset: number): Promise<string> {
	const hash = createHash("sha256");
	const chunk = Buffer.alloc(TRANSCRIPT_PREFIX_HASH_CHUNK_BYTES);
	for (let position = 0; position < endByteOffset; ) {
		const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, endByteOffset - position), position);
		if (bytesRead === 0) throw new NativeTranscriptSnapshotInvalidError();
		hash.update(chunk.subarray(0, bytesRead));
		position += bytesRead;
	}
	return hash.digest("hex");
}

export async function captureNativeTranscriptFilePrefixSnapshot(handle: FileHandle, fixedEndByteOffset?: number) {
	const metadata = await handle.stat();
	let endByteOffset = fixedEndByteOffset ?? metadata.size;
	if (endByteOffset > metadata.size) throw new NativeTranscriptSnapshotInvalidError();
	if (fixedEndByteOffset !== undefined && endByteOffset > 0) {
		const boundary = Buffer.alloc(1);
		await handle.read(boundary, 0, 1, endByteOffset - 1);
		if (boundary[0] !== 10) throw new NativeTranscriptSnapshotInvalidError();
	}
	// 原生进程可能尚未写完最后一行；只有 LF 之前的完整记录属于当前快照。
	if (fixedEndByteOffset === undefined) {
		const chunk = Buffer.alloc(TRANSCRIPT_PREFIX_HASH_CHUNK_BYTES);
		while (endByteOffset > 0) {
			const start = Math.max(0, endByteOffset - chunk.length);
			const length = endByteOffset - start;
			const { bytesRead } = await handle.read(chunk, 0, length, start);
			if (bytesRead !== length) throw new NativeTranscriptSnapshotInvalidError();
			const newlineIndex = chunk.subarray(0, bytesRead).lastIndexOf(10);
			if (newlineIndex >= 0) {
				endByteOffset = start + newlineIndex + 1;
				break;
			}
			endByteOffset = start;
		}
	}
	return {
		deviceId: metadata.dev,
		inodeId: metadata.ino,
		createdAtMs: metadata.birthtimeMs,
		endByteOffset,
		prefixSha256: await hashTranscriptFilePrefix(handle, endByteOffset),
	};
}

export async function assertNativeTranscriptFilePrefixSnapshot(
	handle: FileHandle,
	path: string,
	snapshot: NativeTranscriptFilePrefixSnapshot,
): Promise<void> {
	if (
		!matchesSnapshotFile(await handle.stat(), snapshot) ||
		!matchesSnapshotFile(await stat(path), snapshot) ||
		(await hashTranscriptFilePrefix(handle, snapshot.endByteOffset)) !== snapshot.prefixSha256
	)
		throw new NativeTranscriptSnapshotInvalidError();
	if (!matchesSnapshotFile(await handle.stat(), snapshot) || !matchesSnapshotFile(await stat(path), snapshot))
		throw new NativeTranscriptSnapshotInvalidError();
}
