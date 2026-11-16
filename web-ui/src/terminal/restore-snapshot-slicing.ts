// 按 UTF-8 字节限制每次解析量，保留完整字符；xterm 自身延续跨片 ANSI 解析状态。
export const RESTORE_SNAPSHOT_WRITE_SLICE_MAXIMUM_UTF8_BYTES = 64 * 1024;

export function sliceRestoreSnapshotForIncrementalWrite(
	snapshot: string,
	maximumUtf8Bytes: number = RESTORE_SNAPSHOT_WRITE_SLICE_MAXIMUM_UTF8_BYTES,
): string[] {
	if (!Number.isInteger(maximumUtf8Bytes) || maximumUtf8Bytes < 4)
		throw new RangeError("恢复切片上限必须是至少 4 字节的整数。");
	if (snapshot.length === 0) {
		return [];
	}
	const snapshotSlices: string[] = [];
	const snapshotBytes = new TextEncoder().encode(snapshot);
	if (snapshotBytes.byteLength <= maximumUtf8Bytes) return [snapshot];
	const decoder = new TextDecoder();
	for (let offset = 0; offset < snapshotBytes.byteLength; ) {
		let end = Math.min(offset + maximumUtf8Bytes, snapshotBytes.byteLength);
		while (end < snapshotBytes.byteLength && (snapshotBytes[end]! & 0xc0) === 0x80) end -= 1;
		snapshotSlices.push(decoder.decode(snapshotBytes.subarray(offset, end)));
		offset = end;
	}
	return snapshotSlices;
}
