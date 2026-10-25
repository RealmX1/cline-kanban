import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type RuntimePostDeployVerificationDeploymentGroup,
	runtimePostDeployVerificationDeploymentGroupSchema,
} from "../../../src/core/api-contract";
import type { KanbanBoardCardWorkUnitQualifiedReference } from "../../../src/core/inter-work-unit-relation-ledger-event-contract";
import type { ReferenceRelationModelingDraft } from "../../../src/core/work-unit-relation-modeling-api-contract";
import { resolveTaskPostDeployVerificationEntryNavigationTargetsFromSnapshot } from "../../../src/deployment/post-deploy-verification-entry-navigation-targets";
import {
	getLegacyGuidedVerificationStatePath,
	getPostDeployVerificationStatePath,
} from "../../../src/deployment/post-deploy-verification-state";
import { planReferenceRelationModelingChanges } from "../../../src/inter-work-unit-relation-ledger/reference-relation-modeling-change-planning";
import { createDeploymentApi } from "../../../src/trpc/deployment-api";
import { createTempDir } from "../../utilities/temp-dir";

const subject: KanbanBoardCardWorkUnitQualifiedReference = {
	workUnitType: "kanban_board_card",
	workspaceId: "project",
	taskId: "follow-up",
	taskIncarnationCreatedAtEpochMs: 10,
};
const anchor = { ...subject, workspaceId: "source-project", taskId: "source", taskIncarnationCreatedAtEpochMs: 1 };
const sourceEntry = {
	workspaceId: anchor.workspaceId,
	deploymentId: "00000000-0000-4000-8000-000000000001",
	taskId: anchor.taskId,
	taskIncarnationCreatedAtEpochMs: 1,
	selectedChecklistItemIds: ["assertion-a"],
};
function group(
	workspaceId: string,
	taskId: string,
	day: number,
	folded = false,
): RuntimePostDeployVerificationDeploymentGroup {
	return runtimePostDeployVerificationDeploymentGroupSchema.parse({
		workspaceId,
		deploymentId: `00000000-0000-4000-8000-${String(day).padStart(12, "0")}`,
		deployedSourceCommit: "abc",
		previousDeployedSourceCommit: null,
		deployedAtIso: `2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z`,
		foldedAtIso: folded ? "2026-11-01T00:00:00.000Z" : null,
		tasks: [
			{
				taskId,
				columnIdAtMatch: "validation",
				matchedCommits: [],
				inclusionReason: "validation_column",
				checklist: [],
				verifiedAt: null,
				boardMovedToDoneAt: null,
				pendingConfirmation: null,
				droppedReason: null,
			},
		],
	});
}
function relation(overrides: Partial<ReferenceRelationModelingDraft> = {}) {
	return planReferenceRelationModelingChanges(
		subject,
		[
			{
				draftId: "source-relation",
				replacesRelationId: null,
				expectedAssertedRelationStateVersion: null,
				counterpartWorkUnit: anchor,
				relationKind: "reference_requirement_originates_from",
				currentTaskIsStatementSubject: true,
				relationAssertionRationaleOneSentence: "来源于部署后验证",
				relationAssertionEvidencePointers: [],
				assertedRelationKindSpecificAttributes: { originatingPostDeployVerificationEntry: sourceEntry },
				...overrides,
			},
		],
		[],
		[],
		100,
	).relationsAfterChange[0];
}
function resolve(
	groups: RuntimePostDeployVerificationDeploymentGroup[],
	relations: ReturnType<typeof relation>[] = [],
) {
	return resolveTaskPostDeployVerificationEntryNavigationTargetsFromSnapshot({
		workspaceId: subject.workspaceId,
		taskId: subject.taskId,
		deploymentGroups: groups,
		subjectWorkUnit: subject,
		assertedRelations: relations,
	});
}

describe("Task 到自身及续接来源 PDV 条目的只读定位", () => {
	it("自身记录优先活跃组，排除跨项目同号卡；没有活跃记录时选最近历史", () => {
		const historical = group("project", "follow-up", 2, true);
		const active = group("project", "follow-up", 1);
		expect(resolve([historical, active, group("other", "follow-up", 3)]).map((target) => target.entry)).toEqual([
			{ workspaceId: "project", deploymentId: active.deploymentId, taskId: "follow-up" },
		]);
		expect(resolve([historical, group("project", "follow-up", 1, true)])[0]?.entry.deploymentId).toBe(
			historical.deploymentId,
		);
	});
	it("续接来源定位创建时的精确历史部署，保留所选断言，不随新部署漂移", () => {
		const targets = resolve(
			[group("source-project", "source", 1, true), group("source-project", "source", 2)],
			[relation()],
		);
		expect(targets).toMatchObject([
			{
				entry: { deploymentId: sourceEntry.deploymentId },
				navigationKind: "follow_up_origin_entry",
				availability: "retained",
				selectedChecklistItemIds: ["assertion-a"],
			},
		]);
	});
	it("自身和来源都存在时均返回，重复关系不会重复显示来源", () => {
		const source = relation();
		expect(
			resolve([group("project", "follow-up", 2), group("source-project", "source", 1)], [source, source]),
		).toHaveLength(2);
	});
	it("来源记录已裁剪时保留明确的不可用目标，不替换为最新部署", () => {
		expect(resolve([group("source-project", "source", 2)], [relation()])).toMatchObject([
			{ entry: { deploymentId: sourceEntry.deploymentId }, availability: "deployment_record_not_retained" },
		]);
	});
	it("旧生成器的来源证据可恢复定位，但必须精确匹配关系对端身份", () => {
		const legacy = relation({
			assertedRelationKindSpecificAttributes: {},
			relationAssertionEvidencePointers: [
				`PDV workspace=source-project deployment=${sourceEntry.deploymentId} task=source`,
			],
		});
		expect(resolve([group("source-project", "source", 1)], [legacy])).toHaveLength(1);
		legacy.relationAssertionEvidencePointers = [
			`PDV workspace=other deployment=${sourceEntry.deploymentId} task=source`,
		];
		expect(resolve([group("other", "source", 1)], [legacy])).toHaveLength(0);
	});
	it("旧摘要保留的首行来源也可恢复，普通正文中的相似文字不被解析", () => {
		const pointer = `PDV workspace=source-project deployment=${sourceEntry.deploymentId} task=source`;
		const legacy = relation({
			assertedRelationKindSpecificAttributes: {
				originatedRequirementPortionSummary: `${pointer}\n完整所选项索引：a`,
			},
		});
		expect(resolve([group("source-project", "source", 1)], [legacy])).toHaveLength(1);
		legacy.assertedRelationKindSpecificAttributes.originatedRequirementPortionSummary = `用户说 ${pointer}`;
		expect(resolve([group("source-project", "source", 1)], [legacy])).toHaveLength(0);
	});
	it("指针与来源任务的一世身份不符时不生成可点击目标", () => {
		const invalid = relation();
		invalid.assertedRelationKindSpecificAttributes.originatingPostDeployVerificationEntry = {
			...sourceEntry,
			taskIncarnationCreatedAtEpochMs: 999,
		};
		expect(resolve([group("source-project", "source", 1)], [invalid])).toHaveLength(0);
	});
	it("反向需求关系与撤销关系不被当成本任务的续接来源", () => {
		const revoked = { ...relation(), assertionEffectivenessState: "revoked" as const };
		const inverse = {
			...relation(),
			relationStatementSubjectWorkUnitRef: anchor,
			relationStatementAnchorWorkUnitRef: subject,
		};
		expect(resolve([group("source-project", "source", 1)], [revoked, inverse])).toHaveLength(0);
	});
});

describe.sequential("部署后验证定位查询的只读与故障边界", () => {
	let sandbox: ReturnType<typeof createTempDir>;
	let previousHome: string | undefined;
	beforeEach(() => {
		sandbox = createTempDir("kanban-pdv-entry-navigation-");
		previousHome = process.env.HOME;
		process.env.HOME = sandbox.path;
	});
	afterEach(() => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		sandbox.cleanup();
	});
	function api() {
		return createDeploymentApi({
			loadBoardTasksForWorkspace: async () => {
				throw new Error("只读定位不应对账或加载看板");
			},
			loadTaskAgentResponsePreview: async () => {
				throw new Error("只读定位不应启动会话");
			},
		});
	}
	function writeState(path = getPostDeployVerificationStatePath()) {
		mkdirSync(dirname(path), { recursive: true });
		const contents = JSON.stringify({ deploymentGroups: [group("project", "follow-up", 2)] });
		writeFileSync(path, contents);
		return contents;
	}
	it("账本暂不可用时返回自身目标和来源错误，状态文件逐字保持不变", async () => {
		const before = writeState();
		const result = await api().resolveTaskPostDeployVerificationEntryNavigationTargets(
			{ workspaceId: "project", workspacePath: sandbox.path },
			{ taskId: "follow-up" },
			vi.fn().mockRejectedValue(new Error("账本离线")),
		);
		expect(result.targets).toHaveLength(1);
		expect(result.originEntriesReadError).toContain("账本离线");
		expect(readFileSync(getPostDeployVerificationStatePath(), "utf8")).toBe(before);
	});
	it("损坏的状态文件抛出读取失败，不冒充没有记录，也不隔离或覆盖原文件", async () => {
		writeState();
		writeFileSync(getPostDeployVerificationStatePath(), "broken-json");
		await expect(
			api().resolveTaskPostDeployVerificationEntryNavigationTargets(
				{ workspaceId: "project", workspacePath: sandbox.path },
				{ taskId: "follow-up" },
				vi.fn(),
			),
		).rejects.toThrow();
		expect(readFileSync(getPostDeployVerificationStatePath(), "utf8")).toBe("broken-json");
	});
	it("仅有旧文件时等价只读恢复，保留旧文件且不执行迁移写入", async () => {
		const before = writeState(getLegacyGuidedVerificationStatePath());
		const result = await api().resolveTaskPostDeployVerificationEntryNavigationTargets(
			{ workspaceId: "project", workspacePath: sandbox.path },
			{ taskId: "follow-up" },
			vi.fn().mockRejectedValue(new Error("账本离线")),
		);
		expect(result.targets).toHaveLength(1);
		expect(existsSync(getPostDeployVerificationStatePath())).toBe(false);
		expect(readFileSync(getLegacyGuidedVerificationStatePath(), "utf8")).toBe(before);
	});
});
