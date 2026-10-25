import { isAbsolute } from "node:path";
import { z } from "zod";

const textPartSchema = z.looseObject({ type: z.enum(["text", "input_text"]), text: z.string() });
const skillReferenceSchema = z.strictObject({
	type: z.literal("skill"),
	name: z.string().min(1),
	path: z.string().min(1),
});
export type CodexNativeCloseoutSkillReference = z.infer<typeof skillReferenceSchema>;

// 此处只识别候选，不授予接受资格；未知附件的同正文消息也必须参与唯一性检查。
export function readCodexNativeCloseoutCandidateText(content: readonly unknown[]): string {
	return content
		.flatMap((part) => {
			const parsed = textPartSchema.safeParse(part);
			return parsed.success ? [parsed.data.text] : [];
		})
		.join("");
}

export function parseCodexNativeCloseoutUserMessageContent(content: readonly unknown[]) {
	if (!content.length) throw new Error("原生收尾消息没有正文。");
	const skillReferences: CodexNativeCloseoutSkillReference[] = [];
	const textParts: string[] = [];
	for (const part of content) {
		const text = textPartSchema.safeParse(part);
		if (text.success) {
			textParts.push(text.data.text);
			continue;
		}
		const skill = skillReferenceSchema.safeParse(part);
		if (!skill.success || !isAbsolute(skill.data.path)) throw new Error("精确收尾消息包含未知或不完整的附件。");
		skillReferences.push(skill.data);
	}
	if (!textParts.length) throw new Error("原生收尾消息没有文字正文。");
	if (new Set(skillReferences.map((reference) => JSON.stringify(reference))).size !== skillReferences.length)
		throw new Error("精确收尾消息包含重复 Skill 附件。");
	return { text: textParts.join(""), skillReferences };
}
