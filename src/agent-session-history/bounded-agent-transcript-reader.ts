// agent 落盘转录（JSONL）的**有界**读取原语，与「读它干什么」无关。
//
// 两个消费者共用这一份，避免各写一套读法后在边界行为上悄悄分叉：
//   - available-agent-session-index.ts —— 全盘扫描出「可续跑的历史会话」列表（标题 / 预览 / cwd）。
//   - persisted-agent-transcript-last-conversation-progress-probe.ts —— 只问一件事：这个任务的对话
//     上一次真正往前走是什么时候（卡片药丸 B 的权威来源）。
//
// 「有界」是这里的全部要点：转录文件可以长到几十上百 MB，而两个消费者都跑在会被用户等待的路径上。
// 超过预算时只读**头 1/4 + 尾 3/4**，并在两端各丢掉一条可能被截断的半行——头部丢末行、尾部丢首行。
// 头部之所以要读：claude / codex 的会话元信息（sessionId、cwd、session_meta）只在文件开头出现；
// 尾部之所以占大头：两个消费者关心的「最后发生了什么」都在文件末尾。

import { open } from "node:fs/promises";
import { resolve } from "node:path";

// 把一段可能在任意字节处被切开的 buffer 还原成「完整的 JSON 行」。
// boundary 说明这段 buffer 贴着文件的哪一端，据此决定丢掉哪一侧的半行：
//   - "file_start"：从文件开头读的，末尾那行可能被切断 ⇒ 丢末行（除非本来就以换行收尾）。
//   - "file_end"：贴着文件末尾读的，开头那行可能被切断 ⇒ 无条件丢首行。
export function splitCompleteJsonLines(buffer: Buffer, boundary: "file_start" | "file_end"): string[] {
	let text = buffer.toString("utf8");
	if (boundary === "file_end") {
		const firstNewlineIndex = text.indexOf("\n");
		if (firstNewlineIndex < 0) return [];
		text = text.slice(firstNewlineIndex + 1);
	}
	if (boundary === "file_start" && !text.endsWith("\n")) {
		const lastNewlineIndex = text.lastIndexOf("\n");
		if (lastNewlineIndex < 0) return [];
		text = text.slice(0, lastNewlineIndex + 1);
	}
	return text.split(/\r?\n/u).filter(Boolean);
}

// 在 maximumBytesToRead 预算内读出尽可能有用的完整 JSON 行。
// transcriptWasTruncated 如实上报「中间有一段没读」，调用方据此决定要不要降级结论——**绝不要**把它
// 当成「文件很小、读全了」而静默采信部分数据。
export async function readBoundedJsonLines(
	filePath: string,
	fileSize: number,
	maximumBytesToRead: number,
): Promise<{
	lines: string[];
	transcriptWasTruncated: boolean;
}> {
	const boundedMaximumBytesToRead = Math.max(0, Math.min(fileSize, maximumBytesToRead));
	if (boundedMaximumBytesToRead === 0) {
		return { lines: [], transcriptWasTruncated: fileSize > 0 };
	}
	const fileHandle = await open(filePath, "r");
	try {
		if (boundedMaximumBytesToRead >= fileSize) {
			const buffer = Buffer.allocUnsafe(fileSize);
			const { bytesRead } = await fileHandle.read(buffer, 0, fileSize, 0);
			return {
				lines: buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/u).filter(Boolean),
				transcriptWasTruncated: false,
			};
		}

		const headByteCount = Math.max(1, Math.floor(boundedMaximumBytesToRead / 4));
		const tailByteCount = boundedMaximumBytesToRead - headByteCount;
		const headBuffer = Buffer.allocUnsafe(headByteCount);
		const tailBuffer = Buffer.allocUnsafe(tailByteCount);
		const [{ bytesRead: headBytesRead }, { bytesRead: tailBytesRead }] = await Promise.all([
			fileHandle.read(headBuffer, 0, headByteCount, 0),
			fileHandle.read(tailBuffer, 0, tailByteCount, fileSize - tailByteCount),
		]);
		return {
			lines: [
				...splitCompleteJsonLines(headBuffer.subarray(0, headBytesRead), "file_start"),
				...splitCompleteJsonLines(tailBuffer.subarray(0, tailBytesRead), "file_end"),
			],
			transcriptWasTruncated: true,
		};
	} finally {
		await fileHandle.close();
	}
}

export function isTranscriptRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readTranscriptRecord(value: unknown): Record<string, unknown> | null {
	return isTranscriptRecord(value) ? value : null;
}

export function parseTranscriptJsonRecord(line: string): Record<string, unknown> | null {
	try {
		return readTranscriptRecord(JSON.parse(line) as unknown);
	} catch {
		return null;
	}
}

// ⚠️ 下面两个编码器只差「前导短横留不留」，但**不可互换**，混用会静默查不到目录（不报错、只是没结果）。

// Claude Code 自己写盘用的编码：`/Users/me/repo` → `-Users-me-repo`，**前导短横保留**。
// 要按工作目录直接定位 `~/.claude/projects/<这个名字>/` 时必须用它。
export function encodeClaudeProjectDirectoryName(pathValue: string): string {
	return resolve(pathValue).replace(/[^a-zA-Z0-9]/gu, "-");
}

// 索引侧用于**比对** cursor 嵌套路径片段的宽松编码：在上面的基础上再去掉前导短横。
// 它服务的是「这个已解析出来的会话属不属于当前仓库」这类模糊归属判断，不是路径定位。
export function encodedAgentProjectPath(pathValue: string): string {
	return encodeClaudeProjectDirectoryName(pathValue).replace(/^-+/u, "");
}
