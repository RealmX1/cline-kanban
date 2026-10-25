import { isAbsolute, normalize } from "node:path";
import type { RvfCloseoutSkillSnapshot } from "../core/rvf-automatic-closeout-recovery-contract";
import type { CodexNativeCloseoutSkillReference } from "./codex-native-closeout-user-message-content";
import type { CodexAppServerRequestPort } from "./codex-native-conversation-prefix";

function skillNameMatchesReference(name: string, reference: string) {
	return name === reference || (!reference.includes(":") && name.endsWith(`:${reference}`));
}

export function parseCodexNativeSkillExpansion(text: string) {
	const match = /^<skill>\n<name>([^<\r\n]+)<\/name>\n<path>([^<\r\n]+)<\/path>\n([\s\S]*)\n<\/skill>$/u.exec(text);
	if (!match?.[1] || !match[2] || !isAbsolute(match[2]))
		throw new Error("原生 Skill 展开缺少完整名称、绝对路径或正文。");
	return { name: match[1], path: match[2], instructionText: match[3] ?? "" };
}

// 调用方必须先经原生 reader 验证逐内容块 provenance；wrapper 自身不证明来源。
export async function verifyCodexNativeCloseoutSkillAttachmentEvidence(input: {
	port: CodexAppServerRequestPort;
	worktree: string;
	text: string;
	skillReferences: CodexNativeCloseoutSkillReference[];
	nativeSkillExpansionTexts: string[];
	historicalSnapshots?: RvfCloseoutSkillSnapshot[];
	nativeUserMessageId?: string;
	nativeTurnId?: string;
}): Promise<() => Promise<void>> {
	const explicitNames = [...input.text.matchAll(/\$([\p{L}\p{N}_.-]+(?::[\p{L}\p{N}_.-]+)*)/gu)].map(
		(match) => match[1] ?? "",
	);
	if (input.nativeSkillExpansionTexts.length !== input.skillReferences.length)
		throw new Error("Skill 附件与同回合展开记录数量不符。");
	const identities = new Set<string>();
	for (const snapshot of input.historicalSnapshots ?? []) {
		if (
			snapshot.phase === "accepted_native_expansion" &&
			snapshot.nativeMessageId === input.nativeUserMessageId &&
			snapshot.nativeTurnId === input.nativeTurnId &&
			(snapshot.skills.length !== input.nativeSkillExpansionTexts.length ||
				snapshot.skills.some((skill, index) => skill.expansionText !== input.nativeSkillExpansionTexts[index]))
		)
			throw new Error("同一原生接受事件的完整展开与已保存历史证据冲突。");
	}
	const referencedSkillExpansions = input.skillReferences.map((reference, index) => ({
		reference,
		expansion: parseCodexNativeSkillExpansion(input.nativeSkillExpansionTexts[index] ?? ""),
	}));
	for (const { reference, expansion } of referencedSkillExpansions) {
		if (
			!skillNameMatchesReference(expansion.name, reference.name) ||
			!explicitNames.some(
				(name) =>
					skillNameMatchesReference(expansion.name, name) &&
					referencedSkillExpansions.filter(({ expansion: candidate }) =>
						skillNameMatchesReference(candidate.name, name),
					).length === 1,
			)
		)
			throw new Error("Skill 未唯一对应正文的显式引用。");
		const sameRecordedPath = normalize(expansion.path) === normalize(reference.path);
		const historicalAliases = (input.historicalSnapshots ?? []).flatMap((snapshot) =>
			snapshot.skills.filter(
				(skill) =>
					skillNameMatchesReference(skill.canonicalName, reference.name) &&
					[skill.referencePath, skill.canonicalPath, skill.realPath].includes(reference.path) &&
					[skill.referencePath, skill.canonicalPath, skill.realPath].includes(expansion.path),
			),
		);
		if (!sameRecordedPath && !historicalAliases.length) throw new Error("Skill 路径别名缺少事件绑定的历史归属证据。");
		const skillIdentityPaths = new Set([
			normalize(expansion.path),
			...historicalAliases.map((skill) => normalize(skill.realPath)),
		]);
		if ([...skillIdentityPaths].some((path) => identities.has(path)))
			throw new Error("同一 Skill 通过多个附件别名重复出现。");
		for (const path of skillIdentityPaths) identities.add(path);
	}
	// 当前安装不参与历史事实重验；转录前缀和活动分支由调用方在写入前复查。
	return async () => {};
}
