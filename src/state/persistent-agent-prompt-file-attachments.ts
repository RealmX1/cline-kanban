import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import {
	type RuntimeSaveAgentPromptFileAttachmentRequest,
	runtimeSaveAgentPromptFileAttachmentRequestSchema,
} from "../core/api-contract";
import { getRuntimeHomePath } from "./runtime-home-path";

export async function savePersistentAgentPromptFileAttachment(input: RuntimeSaveAgentPromptFileAttachmentRequest) {
	const { fileName, fileContentBase64 } = runtimeSaveAgentPromptFileAttachmentRequestSchema.parse(input);
	const fileBytes = Buffer.from(fileContentBase64, "base64");
	if (fileBytes.length > 20 * 1024 * 1024 || fileBytes.toString("base64") !== fileContentBase64)
		throw new Error("文件编码无效或超过 20MB 限额。");
	const attachmentDirectoryPath = join(getRuntimeHomePath(), "persistent-agent-prompt-file-attachments");
	const attachmentId = randomUUID();
	// 路径由服务端分配，清洗后的原文件名与扩展名都不允许带目录或控制字符。
	const sanitizedFileName = basename(fileName.replaceAll("\\", "/")).replace(/[^.\p{L}\p{N}_-]/gu, "_");
	const generatedFileName = `${attachmentId}${extname(sanitizedFileName)}`;
	// 仅超出常见文件系统的 255 字节文件名上限时拆出 UUID 目录，保留完整扩展名和通常路径格式。
	const filePath =
		Buffer.byteLength(generatedFileName) > 255
			? join(attachmentDirectoryPath, attachmentId, sanitizedFileName)
			: join(attachmentDirectoryPath, generatedFileName);
	await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
	await writeFile(filePath, fileBytes, { mode: 0o600, flag: "wx" });
	return { fileName, filePath };
}
