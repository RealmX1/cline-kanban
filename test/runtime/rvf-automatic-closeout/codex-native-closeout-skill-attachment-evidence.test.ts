import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { computeRvfTextSha256 } from "../../../src/rvf-automatic-closeout/capture-rvf-review-start-boundary";
import { readCodexNativeCloseoutPromptAcceptanceEvidence } from "../../../src/rvf-automatic-closeout/read-codex-native-closeout-prompt-acceptance-evidence";
import { verifyCodexNativeCloseoutSkillAttachmentEvidence } from "../../../src/rvf-automatic-closeout/verify-codex-native-closeout-skill-attachment-evidence";

async function setupSkillEvidence() {
	const directory = await mkdtemp(join(tmpdir(), "rvf-native-closeout-skill-evidence-"));
	onTestFinished(() => rm(directory, { recursive: true, force: true }));
	const skillDirectory = join(directory, "installed-base-branch-sync");
	await mkdir(skillDirectory);
	const skillPath = join(skillDirectory, "SKILL.md");
	const skillBody = "---\nname: base-branch-sync\n---\n核对本地 base 与任务提交。\n";
	await writeFile(skillPath, skillBody);
	const skillReference = { type: "skill" as const, name: "base-branch-sync", path: skillPath };
	const text = [
		"请使用 $base-branch-sync 收尾。",
		"RVF_AUTOMATIC_CLOSEOUT_TOKEN=token",
		"run_id=run",
		"handoff_sha256=handoff-digest",
		"/isolated/run/artifacts/handoff.md",
	].join("\n");
	const transcriptPath = join(directory, "native-closeout-evidence.jsonl");
	const timestamp = (offset: number) => new Date(Date.now() - 60_000 + offset).toISOString();
	const input = {
		transcriptPath,
		nativeSessionId: "native",
		worktree: directory,
		promptSha256: computeRvfTextSha256(text),
		deliveryCreatedAt: timestamp(0),
		decisionToken: "token",
		runId: "run",
		handoffSha256: "handoff-digest",
		handoffPath: "/isolated/run/artifacts/handoff.md",
	};
	const nativeMessage = {
		type: "event_msg",
		timestamp: timestamp(2000),
		payload: {
			type: "item_completed",
			thread_id: "native",
			turn_id: "user-turn",
			item: {
				type: "UserMessage",
				id: "native-message",
				content: [{ type: "text", text, text_elements: [] }, skillReference] as unknown[],
			},
		},
	};
	const expansionText = (reference = skillReference, body = skillBody) =>
		`<skill>\n<name>${reference.name}</name>\n<path>${reference.path}</path>\n${body}\n</skill>`;
	const expansionMetadata = () => ({
		turn_id: "user-turn",
		content_item_kinds: ["skills.selected_skill_instructions"],
		content_item_metadata: [{ provenance: { type: "skills" } }],
	});
	const expansionRecord = (body = expansionText()) => ({
		type: "response_item",
		timestamp: timestamp(2002),
		payload: {
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: body }] as [
				{ type: string; text: string },
				...{ type: string; text: string }[],
			],
			internal_chat_message_metadata_passthrough: expansionMetadata() as unknown,
		},
	});
	const prefix = [
		{ type: "session_meta", payload: { id: "native", cwd: directory, originator: "codex-tui", source: "vscode" } },
		{
			type: "event_msg",
			timestamp: timestamp(1000),
			payload: { type: "task_started", turn_id: "user-turn", turn_attribution: { turn_trigger: "user" } },
		},
	];
	const writeRecords = (following: unknown[] = [expansionRecord()]) =>
		writeFile(
			transcriptPath,
			`${[...prefix, nativeMessage, ...following].map((record) => JSON.stringify(record)).join("\n")}\n`,
		);
	const selectedSkill = { name: "base-branch-sync", path: skillPath, enabled: true };
	const catalogEntry = { cwd: directory, skills: [selectedSkill], errors: [] as unknown[] };
	const catalog = { data: [catalogEntry] };
	const request = vi.fn(async (method: string, _parameters: Record<string, unknown>) => {
		if (method !== "skills/list") throw new Error("不允许执行原生会话写入。");
		return catalog;
	});
	await writeRecords();
	const verify = async () => {
		const evidence = await readCodexNativeCloseoutPromptAcceptanceEvidence(input);
		return verifyCodexNativeCloseoutSkillAttachmentEvidence({ port: { request }, worktree: directory, ...evidence });
	};
	return {
		directory,
		input,
		text,
		skillReference,
		skillBody,
		skillPath,
		catalog,
		catalogEntry,
		selectedSkill,
		nativeMessage,
		prefix,
		writeRecords,
		expansionRecord,
		expansionText,
		expansionMetadata,
		request,
		verify,
	};
}

describe("原生收尾 Skill 附件的结构、归属与正文证据", () => {
	it("规范化后相同的 Skill 路径不能通过不同名称重复出现", async () => {
		const context = await setupSkillEvidence();
		const alternatePath = context.skillPath.replace("/SKILL.md", "/./SKILL.md");
		await expect(
			verifyCodexNativeCloseoutSkillAttachmentEvidence({
				port: { request: vi.fn() },
				worktree: context.directory,
				text: "$first $second",
				skillReferences: [
					{ type: "skill", name: "first", path: context.skillPath },
					{ type: "skill", name: "second", path: alternatePath },
				],
				nativeSkillExpansionTexts: [
					`<skill>\n<name>first</name>\n<path>${context.skillPath}</path>\n${context.skillBody}\n</skill>`,
					`<skill>\n<name>second</name>\n<path>${alternatePath}</path>\n${context.skillBody}\n</skill>`,
				],
			}),
		).rejects.toThrow("重复");
	});
	it.each(["updated", "removed", "disabled", "catalog_unavailable"])(
		"事件时历史证据在手册 %s 后仍可核验，不依赖当前安装",
		async (scenario) => {
			const context = await setupSkillEvidence();
			if (scenario === "updated") await writeFile(context.skillPath, "后来更新的手册\n");
			if (scenario === "removed") await rm(context.skillPath);
			if (scenario === "disabled") context.selectedSkill.enabled = false;
			if (scenario === "catalog_unavailable") context.request.mockRejectedValue(new Error("catalog 已不可用"));
			const revalidate = await context.verify();
			await expect(revalidate()).resolves.toBeUndefined();
			expect(context.request).not.toHaveBeenCalled();
		},
	);
	it("原生 text+skill 与相邻展开记录保持精确摘要，可信原生来源核验成功", async () => {
		const context = await setupSkillEvidence();
		const evidence = await readCodexNativeCloseoutPromptAcceptanceEvidence(context.input);
		expect(evidence).toMatchObject({
			text: context.text,
			nativeTurnId: "user-turn",
			nativeUserMessageId: "native-message",
			skillReferences: [context.skillReference],
			nativeSkillExpansionTexts: [context.expansionText()],
		});
		const revalidate = await context.verify();
		await expect(revalidate()).resolves.toBeUndefined();
		expect(context.request).not.toHaveBeenCalled();
	});
	it.each([
		"缺少元数据",
		"错回合",
		"缺少回合",
		"普通文本 kind",
		"普通用户来源",
		"缺少 kind",
		"缺少 provenance",
		"空 kinds",
		"空 metadata",
		"多余 kind",
		"多余 provenance",
		"不支持 kind 格式",
		"不支持 provenance 格式",
	])("Skill 展开来源为 %s 时不能仅凭相邻位置认可", async (scenario) => {
		const context = await setupSkillEvidence();
		const expansion = context.expansionRecord();
		const metadata: Record<string, unknown> = context.expansionMetadata();
		if (scenario === "错回合") metadata.turn_id = "other-user-turn";
		if (scenario === "缺少回合") delete metadata.turn_id;
		if (scenario === "普通文本 kind") metadata.content_item_kinds = ["user.text"];
		if (scenario === "普通用户来源") metadata.content_item_metadata = [{ provenance: { type: "user" } }];
		if (scenario === "缺少 kind") delete metadata.content_item_kinds;
		if (scenario === "缺少 provenance") metadata.content_item_metadata = [{}];
		if (scenario === "空 kinds") metadata.content_item_kinds = [];
		if (scenario === "空 metadata") metadata.content_item_metadata = [];
		if (scenario === "多余 kind")
			metadata.content_item_kinds = ["skills.selected_skill_instructions", "skills.selected_skill_instructions"];
		if (scenario === "多余 provenance")
			metadata.content_item_metadata = [{ provenance: { type: "skills" } }, { provenance: { type: "skills" } }];
		if (scenario === "不支持 kind 格式") metadata.content_item_kinds = "skills.selected_skill_instructions";
		if (scenario === "不支持 provenance 格式") metadata.content_item_metadata = [{ provenance: "skills" }];
		expansion.payload.internal_chat_message_metadata_passthrough = scenario === "缺少元数据" ? undefined : metadata;
		await context.writeRecords([expansion]);
		await expect(context.verify()).rejects.toThrow("来源证据");
		expect(context.request).not.toHaveBeenCalled();
	});
	it.each(["合法分块", "第二块 kind 冲突", "第二块 provenance 冲突", "第二块来源缺失"])(
		"Skill 展开 %s 时逐块核对来源，正文仍按原字节连接",
		async (scenario) => {
			const context = await setupSkillEvidence();
			const expansion = context.expansionRecord();
			const text = expansion.payload.content[0].text;
			expansion.payload.content = [
				{ type: "input_text", text: text.slice(0, 13) },
				{ type: "input_text", text: text.slice(13) },
			];
			const metadata = context.expansionMetadata();
			metadata.content_item_kinds.push("skills.selected_skill_instructions");
			metadata.content_item_metadata.push({ provenance: { type: "skills" } });
			if (scenario === "第二块 kind 冲突") metadata.content_item_kinds[1] = "user.text";
			if (scenario === "第二块 provenance 冲突")
				metadata.content_item_metadata[1] = { provenance: { type: "user" } };
			if (scenario === "第二块来源缺失") metadata.content_item_metadata.pop();
			expansion.payload.internal_chat_message_metadata_passthrough = metadata;
			await context.writeRecords([expansion]);
			if (scenario === "合法分块") await expect(context.verify()).resolves.toBeTypeOf("function");
			else {
				await expect(context.verify()).rejects.toThrow("来源证据");
				expect(context.request).not.toHaveBeenCalled();
			}
		},
	);
	it("纯文本和分块正文不要求 Skill catalog；内容不添加换行或 trim", async () => {
		const context = await setupSkillEvidence();
		context.nativeMessage.payload.item.content = [
			{ type: "input_text", text: context.text.slice(0, 9) },
			{ type: "text", text: context.text.slice(9) },
		];
		await context.writeRecords([]);
		expect(await readCodexNativeCloseoutPromptAcceptanceEvidence(context.input)).toMatchObject({
			text: context.text,
			skillReferences: [],
		});
		expect(context.request).not.toHaveBeenCalled();
	});
	it.each(["unknown_type", "missing_name", "relative_path", "extra_skill_field", "duplicate_skill"])(
		"同正文的 %s 附件不能成为接受证据",
		async (scenario) => {
			const context = await setupSkillEvidence();
			const invalidPart = {
				unknown_type: { type: "image", url: "/unknown" },
				missing_name: { type: "skill", path: context.skillPath },
				relative_path: { ...context.skillReference, path: "relative/SKILL.md" },
				extra_skill_field: { ...context.skillReference, text: "被塞入的指令" },
				duplicate_skill: context.skillReference,
			}[scenario];
			if (scenario !== "duplicate_skill") context.nativeMessage.payload.item.content.pop();
			context.nativeMessage.payload.item.content.push(invalidPart);
			await context.writeRecords();
			await expect(context.verify()).rejects.toThrow();
		},
	);
	it("带未知附件的同正文重复消息仍参与唯一性门禁", async () => {
		const context = await setupSkillEvidence();
		const duplicate = structuredClone(context.nativeMessage);
		duplicate.payload.item.id = "another-message";
		duplicate.payload.item.content.push({ type: "unknown_future_attachment" });
		await context.writeRecords([context.expansionRecord(), duplicate]);
		await expect(context.verify()).rejects.toThrow("唯一");
	});
	it.each(["missing", "duplicate", "after_turn_boundary", "modified_name", "modified_path"])(
		"Skill 展开记录 %s 时不猜测归属或忽略差异",
		async (scenario) => {
			const context = await setupSkillEvidence();
			const expansion = context.expansionRecord();
			const records: unknown[] = [expansion];
			if (scenario === "missing") records.length = 0;
			if (scenario === "duplicate") records.push(expansion);
			if (scenario === "after_turn_boundary")
				records.unshift({ type: "event_msg", payload: { type: "task_started", turn_id: "other" } });
			if (scenario === "modified_name")
				expansion.payload.content[0].text = context.expansionText({ ...context.skillReference, name: "other" });
			if (scenario === "modified_path")
				expansion.payload.content[0].text = context.expansionText({
					...context.skillReference,
					path: "/other/SKILL.md",
				});
			await context.writeRecords(records);
			await expect(context.verify()).rejects.toThrow();
		},
	);
	it.each([
		"disabled",
		"wrong_cwd",
		"catalog_error",
		"name_mismatch",
		"path_mismatch",
		"ambiguous_name",
		"not_explicitly_referenced",
	])("当前 catalog 为 %s 时历史接受独立核验", async (scenario) => {
		const context = await setupSkillEvidence();
		const catalog = context.catalogEntry;
		const selected = context.selectedSkill;
		if (scenario === "disabled") selected.enabled = false;
		if (scenario === "wrong_cwd") catalog.cwd = tmpdir();
		if (scenario === "catalog_error") catalog.errors.push({ message: "加载失败" });
		if (scenario === "name_mismatch") selected.name = "other";
		if (scenario === "path_mismatch") selected.path = context.directory;
		if (scenario === "ambiguous_name") catalog.skills.push({ ...selected, name: "other-plugin:base-branch-sync" });
		if (scenario === "not_explicitly_referenced") {
			context.nativeMessage.payload.item.content = [
				{ type: "text", text: context.text.replace("$base-branch-sync", "base-branch-sync") },
				context.skillReference,
			];
			context.input.promptSha256 = computeRvfTextSha256(
				context.text.replace("$base-branch-sync", "base-branch-sync"),
			);
			await context.writeRecords();
		}
		if (scenario === "not_explicitly_referenced") await expect(context.verify()).rejects.toThrow();
		else await expect(context.verify()).resolves.toBeTypeOf("function");
	});
	it.each(["完整引用", "唯一短名引用", "歧义短名引用", "错误命名空间"])(
		"RVF-005 可信规范展开配合短名附件时按规范名称判断%s",
		async (scenario) => {
			const context = await setupSkillEvidence();
			const canonicalName = "trusted-plugin:base-branch-sync";
			const otherCanonicalName = "other-plugin:base-branch-sync";
			const otherPath = join(context.directory, "other-installed-skill.md");
			const text = context.text.replace(
				"$base-branch-sync",
				scenario === "错误命名空间"
					? `$${otherCanonicalName}`
					: scenario === "完整引用"
						? `$${canonicalName}`
						: "$base-branch-sync",
			);
			context.input.promptSha256 = computeRvfTextSha256(text);
			context.nativeMessage.payload.item.content = [{ type: "text", text }, context.skillReference];
			const records = [
				context.expansionRecord(context.expansionText({ ...context.skillReference, name: canonicalName })),
			];
			if (scenario === "歧义短名引用") {
				const otherReference = { ...context.skillReference, name: otherCanonicalName, path: otherPath };
				context.nativeMessage.payload.item.content.push(otherReference);
				records.push(context.expansionRecord(context.expansionText(otherReference)));
			}
			await context.writeRecords(records);
			if (scenario === "歧义短名引用" || scenario === "错误命名空间")
				await expect(context.verify()).rejects.toThrow("显式引用");
			else {
				const revalidate = await context.verify();
				await expect(revalidate()).resolves.toBeUndefined();
			}
			expect(context.request).not.toHaveBeenCalled();
		},
	);
	it.each(["reference_path", "canonical_catalog_identity"])(
		"%s 的唯一命名空间短名与软链接可核验",
		async (expansionIdentity) => {
			const context = await setupSkillEvidence();
			context.selectedSkill.name = "trusted-plugin:base-branch-sync";
			const alias = join(context.directory, "installed-skill-alias.md");
			await symlink(context.skillPath, alias);
			context.skillReference.path = alias;
			await context.writeRecords([
				context.expansionRecord(
					expansionIdentity === "reference_path"
						? context.expansionText()
						: context.expansionText({
								...context.skillReference,
								name: context.selectedSkill.name,
								path: context.skillPath,
							}),
				),
			]);
			if (expansionIdentity === "canonical_catalog_identity")
				await expect(context.verify()).rejects.toThrow("历史归属");
			else await expect(context.verify()).resolves.toBeTypeOf("function");
		},
	);
	it.each(["file_changed", "catalog_disabled", "symlink_retargeted"])(
		"核验中 %s 不改变已核验历史事实",
		async (scenario) => {
			const context = await setupSkillEvidence();
			const alias = join(context.directory, "mutable-skill-alias.md");
			await symlink(context.skillPath, alias);
			context.skillReference.path = alias;
			await context.writeRecords();
			const revalidate = await context.verify();
			if (scenario === "file_changed") await writeFile(context.skillPath, "更新后的手册");
			if (scenario === "catalog_disabled") context.selectedSkill.enabled = false;
			if (scenario === "symlink_retargeted") {
				const replacement = join(context.directory, "different-installed-skill.md");
				await writeFile(replacement, context.skillBody);
				await rm(alias);
				await symlink(replacement, alias);
			}
			await expect(revalidate()).resolves.toBeUndefined();
		},
	);
	it("已有凭据绑定的转录前缀被改写时，即使正文仍一致也拒绝", async () => {
		const context = await setupSkillEvidence();
		const evidence = await readCodexNativeCloseoutPromptAcceptanceEvidence(context.input);
		const bytes = await readFile(context.input.transcriptPath, "utf8");
		await writeFile(
			context.input.transcriptPath,
			bytes.replace('"originator":"codex-tui"', '"originator": "codex-tui"'),
		);
		await expect(
			readCodexNativeCloseoutPromptAcceptanceEvidence({ ...context.input, previousTranscriptSnapshot: evidence }),
		).rejects.toThrow("前缀已改变");
	});
	it("多个已显式引用的 Skill 按原生附件顺序逐项核对，后续用户回合不抹去旧接受事实", async () => {
		const context = await setupSkillEvidence();
		const secondSkill = {
			type: "skill" as const,
			name: "rvf-land",
			path: join(context.directory, "installed-rvf-land.md"),
		};
		const body = "隔离的 RVF 收尾手册。\n";
		await writeFile(secondSkill.path, body);
		context.catalogEntry.skills.push({ ...secondSkill, enabled: true });
		const text = context.text.replace("请使用", "请使用 $rvf-land 和");
		context.input.promptSha256 = computeRvfTextSha256(text);
		context.nativeMessage.payload.item.content = [{ type: "text", text }, context.skillReference, secondSkill];
		await context.writeRecords([
			context.expansionRecord(),
			context.expansionRecord(context.expansionText(secondSkill, body)),
			{
				type: "event_msg",
				payload: { type: "task_started", turn_id: "later-user-turn", turn_attribution: { turn_trigger: "user" } },
			},
		]);
		await expect(context.verify()).resolves.toBeTypeOf("function");
	});
});
