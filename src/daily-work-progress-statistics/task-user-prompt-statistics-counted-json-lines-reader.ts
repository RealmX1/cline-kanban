import { open } from "node:fs/promises";
import {
	type DailyWorkProgressCollectionCostStage,
	measureDailyWorkProgressAsynchronousStage,
	measureDailyWorkProgressSynchronousStage,
	recordDailyWorkProgressFileRead,
} from "../diagnostics/daily-work-progress-collection-cost-recorder";

// 依赖包的增量读取器不返回 read(2) 实际字节数。这里保留其完整行/半行语义，
// 用打开后的 fstat 限定窗口，并在 read 返回处计量，避免把推进偏移或 stat 大小冒充实际 I/O。
export async function readCountedTaskUserPromptStatisticsJsonLines(
	path: string,
	previousByteOffset: number,
	maximumBytes: number,
	stage: DailyWorkProgressCollectionCostStage = "transcript_body_read",
) {
	return measureDailyWorkProgressAsynchronousStage(stage, async () => {
		const handle = await open(path, "r");
		try {
			const metadata = await handle.stat();
			const start = metadata.size < previousByteOffset ? 0 : previousByteOffset;
			const readByteCount = Math.min(maximumBytes, Math.max(0, metadata.size - start));
			const buffer = Buffer.allocUnsafe(readByteCount);
			const bytesRead = readByteCount > 0 ? (await handle.read(buffer, 0, readByteCount, start)).bytesRead : 0;
			if (readByteCount > 0) recordDailyWorkProgressFileRead(bytesRead);
			return measureDailyWorkProgressSynchronousStage("transcript_decode", () => {
				const lastNewline = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
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
			});
		} finally {
			await handle.close();
		}
	});
}
