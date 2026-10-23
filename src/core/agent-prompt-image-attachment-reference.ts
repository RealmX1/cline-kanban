export interface AgentPromptImageAttachmentReference {
	imageAttachmentId: string;
	imageFilePath: string;
	imageMimeType: string;
	imageDisplayName: string;
}

const IMAGE_REFERENCE_BLOCK_PATTERN = /\n?<attached-reference-images>\n([\s\S]*?)\n<\/attached-reference-images>/gu;

/** 文本协议也能持久携带附件；编辑器隐藏引用块，Agent 仍可读取其中的真实图片路径。 */
export function splitAgentPromptImageAttachmentReferences(promptText: string): {
	promptTextWithoutImageReferences: string;
	imageAttachmentReferences: AgentPromptImageAttachmentReference[];
} {
	const imageAttachmentReferences: AgentPromptImageAttachmentReference[] = [];
	const promptTextWithoutImageReferences = promptText.replace(
		IMAGE_REFERENCE_BLOCK_PATTERN,
		(block, content: string) => {
			try {
				const entries: unknown = JSON.parse(content);
				if (
					!Array.isArray(entries) ||
					!entries.every((entry: unknown) => {
						if (!entry || typeof entry !== "object") return false;
						const reference = entry as Record<string, unknown>;
						return (
							typeof reference.imageAttachmentId === "string" &&
							/^[a-f0-9]{64}$/u.test(reference.imageAttachmentId) &&
							typeof reference.imageFilePath === "string" &&
							typeof reference.imageMimeType === "string" &&
							typeof reference.imageDisplayName === "string"
						);
					})
				)
					return block;
				imageAttachmentReferences.push(...(entries as AgentPromptImageAttachmentReference[]));
				return "";
			} catch {
				return block;
			}
		},
	);
	return { promptTextWithoutImageReferences, imageAttachmentReferences };
}

export function withAgentPromptImageAttachmentReferences(
	promptText: string,
	imageAttachmentReferences: readonly AgentPromptImageAttachmentReference[],
): string {
	if (!imageAttachmentReferences.length) return promptText;
	const serializedReferences = JSON.stringify(imageAttachmentReferences, null, 2).replaceAll("<", "\\u003c");
	return `${promptText}\n<attached-reference-images>\n${serializedReferences}\n</attached-reference-images>`;
}
