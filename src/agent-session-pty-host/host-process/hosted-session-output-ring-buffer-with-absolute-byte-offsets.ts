// 每个 hosted 会话的 PTY 输出环形缓冲，按「从 spawn 起的绝对字节偏移」寻址。
//
// 用途：runtime 不在（重启窗口）时 host 照常读 PTY、把输出攒在这里；新 runtime 接管时从它记得的偏移
// （或缓冲起点）续流。满了就覆盖最旧的字节，并让读取方知道丢了多少，绝不阻塞 agent。
//
// 本文件属于 host 进程的依赖闭包：只允许 import `node:*` 与 wire-protocol。

import { HostedSessionTerminalModeStateTracker } from "../wire-protocol/hosted-session-terminal-mode-checkpoint";

// EXPERIMENT_NODE: 每会话 2 MiB 是「重启窗口内 TUI 全屏重绘几轮」的估计，未实测；太小会让崩溃路径的追赶重放缺头，太大则 30 个会话占 60 MiB。
export const HOSTED_SESSION_OUTPUT_RING_BUFFER_DEFAULT_CAPACITY_BYTES = 2 * 1024 * 1024;

export interface HostedSessionOutputRingBufferReadResult {
	bytes: Buffer;
	// 实际返回的第一个字节的绝对偏移；请求的偏移早于保留区间时会被抬到保留区间起点。
	startByteOffset: number;
	// 请求偏移与实际起点之间、已被覆盖而读不到的字节数。
	overwrittenByteCountBeforeStart: number;
}

export class HostedSessionOutputRingBufferWithAbsoluteByteOffsets {
	private readonly storage: Buffer;
	// 下一个写入字节的绝对偏移，也就是迄今写入的总字节数。
	private totalWrittenByteCount = 0;
	// 只解析即将被覆盖的字节；状态永久对齐保留起点，不随旧输出一起丢失。
	private readonly terminalModeStateAtRetainedStart = new HostedSessionTerminalModeStateTracker();

	constructor(private readonly capacityByteLength: number = HOSTED_SESSION_OUTPUT_RING_BUFFER_DEFAULT_CAPACITY_BYTES) {
		if (!Number.isInteger(capacityByteLength) || capacityByteLength <= 0) {
			throw new Error(`invalid ring buffer capacity ${capacityByteLength}`);
		}
		this.storage = Buffer.alloc(capacityByteLength);
	}

	get endByteOffset(): number {
		return this.totalWrittenByteCount;
	}

	get retainedStartByteOffset(): number {
		return Math.max(0, this.totalWrittenByteCount - this.capacityByteLength);
	}

	// 返回本段首字节的绝对偏移。
	append(bytes: Buffer): number {
		const startByteOffset = this.totalWrittenByteCount;
		const nextRetainedStart = Math.max(0, startByteOffset + bytes.length - this.capacityByteLength);
		this.consumeRetainedBytes(this.retainedStartByteOffset, Math.min(startByteOffset, nextRetainedStart), (chunk) =>
			this.terminalModeStateAtRetainedStart.applyOutput(chunk),
		);
		if (nextRetainedStart > startByteOffset)
			this.terminalModeStateAtRetainedStart.applyOutput(bytes.subarray(0, nextRetainedStart - startByteOffset));
		// 超过容量的一段只留尾部；偏移照常按全长推进。
		const retainedBytes =
			bytes.byteLength > this.capacityByteLength
				? bytes.subarray(bytes.byteLength - this.capacityByteLength)
				: bytes;
		const firstRetainedByteOffset = startByteOffset + (bytes.byteLength - retainedBytes.byteLength);
		let writePosition = firstRetainedByteOffset % this.capacityByteLength;
		let remaining = retainedBytes;
		while (remaining.byteLength > 0) {
			const writableUntilWrap = this.capacityByteLength - writePosition;
			const chunk = remaining.subarray(0, writableUntilWrap);
			chunk.copy(this.storage, writePosition);
			remaining = remaining.subarray(chunk.byteLength);
			writePosition = 0;
		}
		this.totalWrittenByteCount += bytes.byteLength;
		return startByteOffset;
	}

	readTerminalModeStateAtAbsoluteByteOffset(outputByteOffset: number) {
		if (outputByteOffset < this.retainedStartByteOffset || outputByteOffset > this.endByteOffset) return undefined;
		const tracker = this.terminalModeStateAtRetainedStart.clone();
		this.consumeRetainedBytes(this.retainedStartByteOffset, outputByteOffset, (chunk) => tracker.applyOutput(chunk));
		return tracker.readReplayState();
	}

	private consumeRetainedBytes(start: number, end: number, consume: (bytes: Buffer) => void): void {
		while (start < end) {
			const position = start % this.capacityByteLength;
			const length = Math.min(this.capacityByteLength - position, end - start);
			consume(this.storage.subarray(position, position + length));
			start += length;
		}
	}

	readFromAbsoluteByteOffset(requestedStartByteOffset: number): HostedSessionOutputRingBufferReadResult {
		const clampedRequestedStart = Math.min(Math.max(0, requestedStartByteOffset), this.totalWrittenByteCount);
		const startByteOffset = Math.max(clampedRequestedStart, this.retainedStartByteOffset);
		const byteLength = this.totalWrittenByteCount - startByteOffset;
		const bytes = Buffer.alloc(byteLength);
		let readPosition = startByteOffset % this.capacityByteLength;
		let copiedByteCount = 0;
		while (copiedByteCount < byteLength) {
			const readableUntilWrap = Math.min(this.capacityByteLength - readPosition, byteLength - copiedByteCount);
			this.storage.copy(bytes, copiedByteCount, readPosition, readPosition + readableUntilWrap);
			copiedByteCount += readableUntilWrap;
			readPosition = 0;
		}
		return {
			bytes,
			startByteOffset,
			overwrittenByteCountBeforeStart: startByteOffset - clampedRequestedStart,
		};
	}
}
