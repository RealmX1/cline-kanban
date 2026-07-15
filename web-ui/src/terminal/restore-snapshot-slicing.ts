// restore 快照的分片写入切片。
//
// 服务端 mirror 的 restore 快照最多带 2 万行 scrollback(数 MB 字符串)。xterm 对单次
// terminal.write 的 chunk 是整段同步解析——WriteBuffer 的 12ms 时间预算只在 chunk 之间
// 检查,单个巨型快照 chunk 意味着一次数百 ms 的主线程冻结,restore_complete 也被同一次
// 解析推迟。按固定字符数切片后逐段 write:xterm 的解析器跨 write 调用保持转义序列与
// 代理对的中间状态(StringToUtf32 的 interim 缓存),任意切点都安全。
export const RESTORE_SNAPSHOT_WRITE_SLICE_CHARS = 64 * 1024;

export function sliceRestoreSnapshotForIncrementalWrite(
	snapshot: string,
	sliceChars: number = RESTORE_SNAPSHOT_WRITE_SLICE_CHARS,
): string[] {
	if (snapshot.length === 0) {
		return [];
	}
	if (snapshot.length <= sliceChars) {
		return [snapshot];
	}
	const snapshotSlices: string[] = [];
	for (let sliceStartIndex = 0; sliceStartIndex < snapshot.length; sliceStartIndex += sliceChars) {
		snapshotSlices.push(snapshot.slice(sliceStartIndex, sliceStartIndex + sliceChars));
	}
	return snapshotSlices;
}
