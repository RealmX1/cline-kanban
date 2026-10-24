import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { CodexNativeCloseoutSkillReference } from "./codex-native-closeout-user-message-content";
import type { CodexAppServerRequestPort } from "./codex-native-conversation-prefix";

const skillCatalogResponseSchema = z.object({
	data: z.array(
		z.object({
			cwd: z.string(),
			skills: z.array(z.looseObject({ name: z.string(), path: z.string(), enabled: z.boolean() })),
			errors: z.array(z.unknown()),
		}),
	),
});

function skillNameMatchesReference(catalogName: string, referenceName: string) {
	return catalogName === referenceName || (!referenceName.includes(":") && catalogName.endsWith(`:${referenceName}`));
}

// 只消费本代控制面按当前 cwd 返回的 catalog，不自行扫描或硬编码安装目录。
export async function verifyCodexNativeCloseoutSkillAttachmentEvidence(input: {
	port: CodexAppServerRequestPort;
	worktree: string;
	text: string;
	skillReferences: CodexNativeCloseoutSkillReference[];
	nativeSkillExpansionTexts: string[];
}): Promise<() => Promise<void>> {
	const explicitSkillNames = [...input.text.matchAll(/\$([\p{L}\p{N}_.-]+(?::[\p{L}\p{N}_.-]+)*)/gu)].map(
		(match) => match[1],
	);
	const worktree = await realpath(input.worktree);
	if (input.nativeSkillExpansionTexts.length !== input.skillReferences.length)
		throw new Error("Skill 附件与同回合展开记录数量不符。");
	async function readCurrentInstallation() {
		const response = skillCatalogResponseSchema.parse(
			await input.port.request("skills/list", { cwds: [input.worktree], forceReload: true }),
		);
		const catalog = response.data[0];
		if (response.data.length !== 1 || !catalog || (await realpath(catalog.cwd)) !== worktree || catalog.errors.length)
			throw new Error("当前工作目录的 Skill catalog 无法完整确认。");
		const enabledSkills = catalog.skills.filter((skill) => skill.enabled);
		const installedSkills = [];
		for (const reference of input.skillReferences) {
			const candidates = enabledSkills.filter((skill) => skillNameMatchesReference(skill.name, reference.name));
			const selected = candidates[0];
			if (
				candidates.length !== 1 ||
				!selected ||
				!isAbsolute(selected.path) ||
				!explicitSkillNames.some((name) => {
					const matches = enabledSkills.filter((skill) => skillNameMatchesReference(skill.name, name ?? ""));
					return matches.length === 1 && matches[0] === selected;
				})
			)
				throw new Error("Skill 附件未唯一对应当前已启用且被正文显式引用的手册。");
			const path = await realpath(selected.path);
			if ((await realpath(reference.path)) !== path || !(await stat(path)).isFile())
				throw new Error("Skill 附件路径与当前 catalog 不符。");
			const bytes = await readFile(path);
			const text = bytes.toString("utf8");
			if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("Skill 正文不是完整 UTF-8 文本。");
			installedSkills.push({ name: selected.name, catalogPath: selected.path, path, text });
		}
		if (new Set(installedSkills.map((skill) => skill.path)).size !== installedSkills.length)
			throw new Error("同一手册通过多个附件别名重复出现。");
		return installedSkills;
	}
	const installedSkills = await readCurrentInstallation();
	for (const [index, reference] of input.skillReferences.entries()) {
		const installed = installedSkills[index];
		if (!installed) throw new Error("缺少已核对的 Skill 安装内容。");
		// 原生展开可使用引用本身或已证明等价的 catalog 名称与规范路径。
		const expectedExpansions = [reference.name, installed.name].flatMap((name) =>
			[reference.path, installed.catalogPath, installed.path].map(
				(path) => `<skill>\n<name>${name}</name>\n<path>${path}</path>\n${installed.text}\n</skill>`,
			),
		);
		if (!expectedExpansions.includes(input.nativeSkillExpansionTexts[index] ?? ""))
			throw new Error("同回合 Skill 展开正文与当前安装内容不符，不能确认附件接受事实。");
	}
	// 原生分页期间可能更新安装文件或切换软链接；发放补证资格前重新核对。
	return async () => {
		if (JSON.stringify(await readCurrentInstallation()) !== JSON.stringify(installedSkills))
			throw new Error("核验期间 Skill catalog、路径或内容已改变。");
	};
}
