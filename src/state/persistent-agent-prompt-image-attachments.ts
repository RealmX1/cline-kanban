import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentPromptImageAttachmentReference } from "../core/agent-prompt-image-attachment-reference";
import { type RuntimeTaskImage, runtimeTaskImageSchema } from "../core/api-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "./runtime-home-path";

const IMAGE_EXTENSION_BY_MIME_TYPE: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
};

function attachmentDirectoryPath() {
	return join(getRuntimeHomePath(), "persistent-agent-prompt-image-attachments");
}

export async function savePersistentAgentPromptImageAttachments(
	images: RuntimeTaskImage[],
): Promise<AgentPromptImageAttachmentReference[]> {
	const directoryPath = attachmentDirectoryPath();
	await mkdir(directoryPath, { recursive: true, mode: 0o700 });
	return await Promise.all(
		images.map(async (image) => {
			const extension = IMAGE_EXTENSION_BY_MIME_TYPE[image.mimeType];
			const imageBytes = Buffer.from(image.data, "base64");
			if (
				!extension ||
				!imageBytes.length ||
				imageBytes.length > 20 * 1024 * 1024 ||
				imageBytes.toString("base64") !== image.data
			)
				throw new Error("图片格式无效或超过 20MB 限额。");
			const imageAttachmentId = createHash("sha256").update(image.mimeType).update(imageBytes).digest("hex");
			const imageFilePath = join(directoryPath, `${imageAttachmentId}${extension}`);
			// 内容寻址只写同一内容；先写图片再写元数据，返回时引用已可跨重启读取。
			const metadataFilePath = join(directoryPath, `${imageAttachmentId}.json`);
			await lockedFileSystem.withLock({ path: metadataFilePath }, async () => {
				try {
					await readFile(metadataFilePath);
					return;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
				await writeFile(imageFilePath, imageBytes, { mode: 0o600 });
				await lockedFileSystem.writeJsonFileAtomic(
					metadataFilePath,
					{ ...image, id: imageAttachmentId },
					{ lock: null },
				);
			});
			return {
				imageAttachmentId,
				imageFilePath,
				imageMimeType: image.mimeType,
				imageDisplayName: image.name ?? "参考图片",
			};
		}),
	);
}

export async function readPersistentAgentPromptImageAttachments(
	imageAttachmentIds: string[],
): Promise<RuntimeTaskImage[]> {
	return await Promise.all(
		imageAttachmentIds.map(async (imageAttachmentId) => {
			if (!/^[a-f0-9]{64}$/u.test(imageAttachmentId)) throw new Error("图片附件标识无效。");
			return runtimeTaskImageSchema.parse(
				JSON.parse(await readFile(join(attachmentDirectoryPath(), `${imageAttachmentId}.json`), "utf8")),
			);
		}),
	);
}
