import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	splitAgentPromptImageAttachmentReferences,
	withAgentPromptImageAttachmentReferences,
} from "../../../src/core/agent-prompt-image-attachment-reference";
import {
	readPersistentAgentPromptImageAttachments,
	savePersistentAgentPromptImageAttachments,
} from "../../../src/state/persistent-agent-prompt-image-attachments";

const isolatedRuntimeHome = vi.hoisted(() => ({ directoryPath: "" }));
vi.mock("../../../src/state/runtime-home-path", () => ({
	getRuntimeHomePath: () => isolatedRuntimeHome.directoryPath,
}));
beforeEach(async () => {
	isolatedRuntimeHome.directoryPath = await mkdtemp(join(tmpdir(), "persistent-prompt-image-test-"));
});
afterEach(async () => {
	await rm(isolatedRuntimeHome.directoryPath, { recursive: true, force: true });
});

it("图片内容寻址持久保存，纯文本提示词重读后仍可恢复附件", async () => {
	const image = {
		id: "browser-image-id",
		mimeType: "image/png",
		data: "aW1hZ2U=",
		name: "参考</attached-reference-images>.png",
	};
	const references = await savePersistentAgentPromptImageAttachments([image]);
	const reference = references[0];
	if (!reference) throw new Error("未返回附件引用");
	expect(await readFile(reference.imageFilePath, "utf8")).toBe("image");
	const persistedText = withAgentPromptImageAttachmentReferences("原始查询\n", references);
	const restored = splitAgentPromptImageAttachmentReferences(persistedText);
	expect(restored.promptTextWithoutImageReferences).toBe("原始查询\n");
	expect(restored.imageAttachmentReferences).toEqual(references);
	expect(await readPersistentAgentPromptImageAttachments([reference.imageAttachmentId])).toEqual([
		{ ...image, id: reference.imageAttachmentId },
	]);
	expect(await savePersistentAgentPromptImageAttachments([image])).toEqual(references);
});

it("拒绝路径穿越、不支持的类型和无效 base64，普通标签文本保持原文", async () => {
	await expect(readPersistentAgentPromptImageAttachments(["../../outside"])).rejects.toThrow("无效");
	await expect(
		savePersistentAgentPromptImageAttachments([{ id: "x", mimeType: "text/html", data: "aW1hZ2U=" }]),
	).rejects.toThrow("无效");
	await expect(
		savePersistentAgentPromptImageAttachments([{ id: "x", mimeType: "image/png", data: "invalid?" }]),
	).rejects.toThrow("无效");
	const text = "<attached-reference-images>\n用户提供的普通标签内容\n</attached-reference-images>";
	expect(splitAgentPromptImageAttachmentReferences(text).promptTextWithoutImageReferences).toBe(text);
});
