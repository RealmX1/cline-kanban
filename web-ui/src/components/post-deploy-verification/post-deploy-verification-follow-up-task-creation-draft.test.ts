import {
	referenceRelationModelingDraftSchema,
	referenceRelationModelingEditorDraftSchema,
} from "@runtime-work-unit-relation-modeling-api-contract";
import { describe, expect, it } from "vitest";
import { runtimePostDeployVerificationChecklistItemSchema } from "../../../../src/core/api-contract";
import { buildPostDeployVerificationFollowUpTaskCreationDraftSeed } from "./post-deploy-verification-follow-up-task-creation-draft";
import { createPostDeployVerificationTaskReadModelTestFixture } from "./post-deploy-verification-task-read-model-test-fixtures";

const checklistItem = (id: string, checked = false) => ({
	id,
	label: `核对 ${id}`,
	checked,
	source: "custom" as const,
	kind: "guided_manual" as const,
	guidance: null,
	script: null,
	run: null,
	cleanup: null,
});

function buildSeedForChecklist(
	checklist: ReturnType<typeof runtimePostDeployVerificationChecklistItemSchema.parse>[],
	overrides: Partial<Parameters<typeof buildPostDeployVerificationFollowUpTaskCreationDraftSeed>[0]> = {},
) {
	return buildPostDeployVerificationFollowUpTaskCreationDraftSeed({
		workspaceId: "source-project",
		projectName: "来源项目",
		sourceTaskCreatedAt: 1,
		sourceTaskTitle: "来源任务",
		deploymentId: "deployment-1",
		deployedSourceCommit: "abcdef",
		deployedAtIso: "2026-10-18T00:00:00Z",
		task: createPostDeployVerificationTaskReadModelTestFixture({ checklist }),
		selectedChecklistItemIds: checklist.map((item) => item.id),
		...overrides,
	});
}

function parseSeedAsPersistedEditorDraft(seed: ReturnType<typeof buildSeedForChecklist>) {
	return referenceRelationModelingEditorDraftSchema.parse({
		referenceRelationDrafts: seed.referenceRelationDrafts,
		relationRevocations: [],
		createdTaskId: null,
		modelingSubmissionId: seed.initializationId,
		creationPrompt: seed.prompt,
		creationTitle: seed.title,
	});
}

describe("从 PDV 核对项生成新任务上下文", () => {
	it("只快照选择的未核对项，并预置新任务指向来源任务的需求关系", () => {
		const task = createPostDeployVerificationTaskReadModelTestFixture({
			checklist: [checklistItem("first"), checklistItem("second"), checklistItem("passed", true)],
		});
		const before = structuredClone(task);
		const seed = buildPostDeployVerificationFollowUpTaskCreationDraftSeed({
			workspaceId: "source-project",
			projectName: "来源项目",
			sourceTaskCreatedAt: 1,
			sourceTaskTitle: "[FEAT]来源任务",
			deploymentId: "deployment-1",
			deployedSourceCommit: "abcdef",
			deployedAtIso: "2026-10-18T00:00:00Z",
			task,
			selectedChecklistItemIds: ["second", "first", "passed", "removed"],
		});
		expect(seed.workspaceId).toBe("source-project");
		expect(seed.prompt).toContain("核对 first");
		expect(seed.prompt).toContain("核对 second");
		expect(seed.prompt).not.toContain("核对 passed");
		expect(seed.prompt).toContain("尚未核对，不代表验证失败");
		expect(seed.prompt).toContain("deployment-1");
		expect(seed.referenceRelationDrafts).toMatchObject([
			{
				relationKind: "reference_requirement_originates_from",
				currentTaskIsStatementSubject: true,
				counterpartWorkUnit: {
					workUnitType: "kanban_board_card",
					workspaceId: "source-project",
					taskId: task.taskId,
				},
			},
		]);
		expect(
			referenceRelationModelingDraftSchema.parse(seed.referenceRelationDrafts[0]).counterpartWorkUnit,
		).toMatchObject({ taskIncarnationCreatedAtEpochMs: 1 });
		expect(task).toEqual(before);
	});
	it("保留指引和脚本失败证据，且不把错误与未运行混为一谈", () => {
		const item = {
			...checklistItem("guided"),
			guidance: {
				steps: ["打开详情"],
				expectedObservation: "显示结果",
				failureSignature: "结果缺失",
				anchor: { view: "board" as const },
			},
		};
		const seed = buildPostDeployVerificationFollowUpTaskCreationDraftSeed({
			workspaceId: "source",
			projectName: "来源",
			sourceTaskCreatedAt: 1,
			sourceTaskTitle: "来源任务",
			deploymentId: "deploy",
			deployedSourceCommit: "abc",
			deployedAtIso: "2026-10-18T00:00:00Z",
			task: createPostDeployVerificationTaskReadModelTestFixture({
				checklist: [
					item,
					{
						...checklistItem("automated"),
						kind: "automated_script",
						script: { entrypoint: "run.js", interpreter: "node", timeoutMs: 60000 },
						run: {
							status: "failed",
							exitCode: 1,
							startedAtIso: null,
							finishedAtIso: null,
							outputExcerpt: "预期按钮不存在",
						},
					},
				],
			}),
			selectedChecklistItemIds: [item.id, "automated"],
		});
		expect(seed.prompt).toContain("打开详情");
		expect(seed.prompt).toContain("显示结果");
		expect(seed.prompt).toContain("结果缺失");
		expect(seed.prompt).toContain('"status":"failed"');
		expect(seed.prompt).toContain("预期按钮不存在");
		expect(seed.prompt).toContain("run.js");
	});
	it("51 项各带 4000 字符脚本输出时仍可保存，保留每项身份和验收尾段", () => {
		const checklist = Array.from({ length: 51 }, (_, index) =>
			runtimePostDeployVerificationChecklistItemSchema.parse({
				...checklistItem(`script-${index}`),
				kind: "automated_script",
				run: {
					status: "failed",
					exitCode: 1,
					startedAtIso: null,
					finishedAtIso: null,
					outputExcerpt: "输".repeat(4000),
				},
			}),
		);
		const seed = buildSeedForChecklist(checklist);
		expect(() => parseSeedAsPersistedEditorDraft(seed)).not.toThrow();
		const singleItemSeed = buildSeedForChecklist(checklist.slice(0, 1));
		expect(singleItemSeed.prompt).toContain(JSON.stringify(checklist[0]?.run));
		expect(singleItemSeed.prompt).not.toContain("摘要");
		for (const item of checklist) expect(seed.prompt).toContain(`核对项 ID：${item.id}；`);
		expect(seed.prompt).toContain("摘要");
		expect(seed.prompt).toContain("## 目标与验收");
		expect(seed.prompt).toContain("本任务不自动将它标成通过或移入 Done");
	});
	it.each([0, 1])("正文在真实 schema 上限加 %i 字符时保留全文或明确摘要", (extraCharacters) => {
		const maximumPromptCharacters =
			referenceRelationModelingEditorDraftSchema.shape.creationPrompt.unwrap().maxLength;
		if (maximumPromptCharacters === null) throw new Error("创建草稿应有明确正文长度上限。");
		const item = { ...checklistItem("prompt-boundary"), label: "" };
		const promptWithoutLabel = buildSeedForChecklist([item]).prompt;
		item.label = "名".repeat(maximumPromptCharacters + extraCharacters - promptWithoutLabel.length);
		const seed = buildSeedForChecklist([item]);
		expect(() => parseSeedAsPersistedEditorDraft(seed)).not.toThrow();
		if (extraCharacters === 0) {
			expect(seed.prompt).toContain(item.label);
			expect(seed.prompt.length).toBe(maximumPromptCharacters);
			expect(seed.prompt).not.toContain("摘要");
		} else {
			expect(seed.prompt).toContain("摘要");
			expect(seed.prompt).toContain(`核对项 ID：${item.id}；`);
		}
	});
	it("单项超长指引、名称和含转义字符的输出使用明确摘要，完整身份仍可追溯", () => {
		const item = runtimePostDeployVerificationChecklistItemSchema.parse({
			...checklistItem(`long-id-${"i".repeat(210000)}`),
			label: `长名称-${"名".repeat(210000)}`,
			guidance: {
				steps: ["步骤".repeat(110000)],
				expectedObservation: "预期".repeat(110000),
			},
			run: {
				status: "failed",
				exitCode: 1,
				startedAtIso: null,
				finishedAtIso: null,
				outputExcerpt: '\n"\\'.repeat(100000),
			},
		});
		const seed = buildSeedForChecklist([item]);
		expect(() => parseSeedAsPersistedEditorDraft(seed)).not.toThrow();
		expect(seed.prompt).toContain("摘要");
		expect(seed.prompt).toContain("## 目标与验收");
		expect(
			seed.referenceRelationDrafts[0]?.assertedRelationKindSpecificAttributes.originatedRequirementPortionSummary,
		).toContain(`${item.id}：${item.label}`);
	});
	it("大集合无法逐项容纳时明确标出省略数量，关系属性保留全部所选项索引", () => {
		const checklist = Array.from({ length: 5000 }, (_, index) => checklistItem(`many-${index}`));
		const seed = buildSeedForChecklist(checklist);
		expect(() => parseSeedAsPersistedEditorDraft(seed)).not.toThrow();
		expect(seed.prompt).toContain("未在正文逐项展示");
		expect(seed.prompt).toContain("originatedRequirementPortionSummary");
		const omissionCounts = seed.prompt.match(/正文仅展示前 (\d+) 项摘要；其余 (\d+) 项未在正文逐项展示/);
		expect(Number(omissionCounts?.[1]) + Number(omissionCounts?.[2])).toBe(checklist.length);
		const summary =
			seed.referenceRelationDrafts[0]?.assertedRelationKindSpecificAttributes.originatedRequirementPortionSummary;
		for (const item of checklist) expect(summary).toContain(`${item.id}：${item.label}`);
	});
	it("超长来源信息不破坏关系证据指针上限，关系保留完整来源和任务身份", () => {
		const workspaceId = `workspace-${"w".repeat(210000)}`;
		const deploymentId = `deployment-${"d".repeat(210000)}`;
		const taskId = `task-${"t".repeat(210000)}`;
		const seed = buildSeedForChecklist([checklistItem("source-boundary")], {
			workspaceId,
			deploymentId,
			projectName: "项目".repeat(110000),
			sourceTaskTitle: "任务".repeat(110000),
			deployedSourceCommit: "c".repeat(210000),
			task: createPostDeployVerificationTaskReadModelTestFixture({
				taskId,
				checklist: [checklistItem("source-boundary")],
			}),
		});
		expect(() => parseSeedAsPersistedEditorDraft(seed)).not.toThrow();
		expect(seed.referenceRelationDrafts[0]?.counterpartWorkUnit).toMatchObject({ workspaceId, taskId });
		expect(
			seed.referenceRelationDrafts[0]?.assertedRelationKindSpecificAttributes.originatedRequirementPortionSummary,
		).toContain(`deployment=${deploymentId}`);
	});
	it.each([0, 1])("关系证据指针在真实 schema 上限加 %i 字符时均生成合法草稿", (extraCharacters) => {
		const maximumPointerCharacters =
			referenceRelationModelingDraftSchema.shape.relationAssertionEvidencePointers.unwrap().element.maxLength;
		if (maximumPointerCharacters === null) throw new Error("关系证据指针应有明确长度上限。");
		const pointerPrefix = "PDV workspace=source-project deployment=";
		const pointerSuffix = " task=task-1";
		const deploymentId = "d".repeat(
			maximumPointerCharacters + extraCharacters - pointerPrefix.length - pointerSuffix.length,
		);
		const sourcePointer = `${pointerPrefix}${deploymentId}${pointerSuffix}`;
		const seed = buildSeedForChecklist([checklistItem("pointer-boundary")], { deploymentId });
		expect(() => parseSeedAsPersistedEditorDraft(seed)).not.toThrow();
		if (extraCharacters === 0) {
			expect(seed.referenceRelationDrafts[0]?.relationAssertionEvidencePointers).toEqual([sourcePointer]);
		} else {
			expect(
				seed.referenceRelationDrafts[0]?.assertedRelationKindSpecificAttributes.originatedRequirementPortionSummary,
			).toContain(sourcePointer);
		}
	});
	it("合法指引缺省可选失败特征与定位信息时省略相应行", () => {
		const seed = buildSeedForChecklist([
			runtimePostDeployVerificationChecklistItemSchema.parse({
				...checklistItem("optional-guidance"),
				guidance: { steps: ["打开详情"], expectedObservation: "显示结果" },
			}),
		]);
		expect(seed.prompt).toContain("打开详情");
		expect(seed.prompt).toContain("显示结果");
		expect(seed.prompt).not.toContain("失败特征：");
		expect(seed.prompt).not.toContain("定位信息：");
		expect(seed.prompt).not.toContain("undefined");
		expect(seed.prompt).not.toContain("null");
		expect(() => parseSeedAsPersistedEditorDraft(seed)).not.toThrow();
	});
	it("没有有效选项时拒绝生成空任务", () => {
		expect(() =>
			buildPostDeployVerificationFollowUpTaskCreationDraftSeed({
				workspaceId: "source",
				projectName: "来源",
				sourceTaskCreatedAt: 1,
				sourceTaskTitle: "来源任务",
				deploymentId: "deploy",
				deployedSourceCommit: "abc",
				deployedAtIso: "2026-10-18T00:00:00Z",
				task: createPostDeployVerificationTaskReadModelTestFixture(),
				selectedChecklistItemIds: [],
			}),
		).toThrow("请选择至少一个仍待核对的项目");
	});
});
