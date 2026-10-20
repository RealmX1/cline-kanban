import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type IncomingWorkItemRelationCandidate,
	incomingWorkItemSchema,
	type TaskIndexingMaterial,
} from "../../../src/core/task-indexing-support-contract";
import { lockedFileSystem } from "../../../src/fs/locked-file-system";
import {
	activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture,
	readRecordedInterWorkUnitRelationProjectionOfActiveKanbanRuntimeLiveCapture,
	runInterWorkUnitRelationLedgerClientOperationOfActiveKanbanRuntimeLiveCapture,
} from "../../../src/inter-work-unit-relation-ledger/kanban-runtime-inter-work-unit-relation-ledger-live-capture-activation";
import { registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture } from "../../../src/state/workspace-board-persistence-funnel-task-mutation-event-capture-port";
import {
	loadWorkspaceBoardById,
	loadWorkspaceContext,
	mutateWorkspaceState,
	saveWorkspaceState,
} from "../../../src/state/workspace-state";
import { collectTaskIndexingMaterials } from "../../../src/task-indexing-support/collect-task-indexing-materials";
import {
	selectFullyCoveringExistingTask,
	taskIndexingMaterialRequirementsFingerprint,
	validateIncomingWorkItemRelationCandidates,
} from "../../../src/task-indexing-support/incoming-work-item-relation-analysis";
import {
	type IncomingWorkItemTriageEffects,
	listDurableIncomingWorkItemTriageOperations,
	triageIncomingWorkItemWithDurableOperation,
} from "../../../src/task-indexing-support/incoming-work-item-triage-operation";
import { taskIndexingTextFingerprint } from "../../../src/task-indexing-support/shared-task-indexing-context";
import { createWorkUnitRelationAssertionWriteApi } from "../../../src/trpc/work-unit-relation-assertion-write-api";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../../utilities/task-mutation-intent-for-test-fixture";

const reference = (taskId: string, workspaceId = "project") => ({
	workUnitType: "kanban_board_card" as const,
	workspaceId,
	taskId,
	taskIncarnationCreatedAtEpochMs: 1,
});
const item = incomingWorkItemSchema.parse({
	schema_version: 1,
	work_item_key: "finding",
	title: "修复问题",
	prompt: "要求与证据",
});
const candidate = (
	coverage: IncomingWorkItemRelationCandidate["coverage"] = "fully_covers_incoming_work",
): IncomingWorkItemRelationCandidate => ({
	task_reference: reference("old"),
	relation_kind: "reference_concerns_behavior_or_state_of",
	confidence: "high",
	coverage,
	rationale: "完整承担该要求",
	evidence: ["src/example.ts:1"],
	cross_project: false,
});
const material: TaskIndexingMaterial = {
	taskReference: reference("old"),
	projectName: "项目",
	title: "修复问题",
	prompt: "要求与证据",
	columnId: "in_progress",
	latestNotificationSummaryText: null,
	latestHookFinalMessage: null,
	claudeAwaySummary: null,
	missingContextParts: [],
};
const cleanup: string[] = [];
afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function harness(candidates: IncomingWorkItemRelationCandidate[]) {
	const directory = await mkdtemp(join(tmpdir(), "incoming-work-item-triage-test-"));
	cleanup.push(directory);
	const calls: string[] = [];
	const seen = new Set<string>();
	const effects: IncomingWorkItemTriageEffects = {
		allocateTaskIdentity: async () => reference("new"),
		readCurrentMaterials: async () => [
			material,
			...(seen.has("create")
				? [
						{
							...material,
							taskReference: reference("new"),
							title: item.title,
							prompt: item.prompt,
							columnId: "backlog",
						},
					]
				: []),
		],
		analyze: async () => {
			calls.push("analyze");
			return { relation_candidates: candidates };
		},
		createBacklogTask: async () => {
			if (!seen.has("create")) {
				calls.push("create");
				seen.add("create");
			}
		},
		appendComment: async (input) => {
			if (!seen.has(input.commentId)) {
				calls.push(`comment:${input.taskReference.taskId}`);
				seen.add(input.commentId);
			}
		},
		assertUnverifiedRelations: async () => {
			calls.push("relations");
		},
		recordDisposition: async () => {
			calls.push("disposition");
		},
	};
	const run = (workItem = item) =>
		triageIncomingWorkItemWithDurableOperation({
			workspaceId: "project",
			item: workItem,
			operationDirectoryPath: directory,
			effects,
		});
	return { directory, calls, effects, run };
}

async function isolatedLedgerRaceHarness(onWriteGuardRead?: () => Promise<void>) {
	const fixture = createIsolatedGitTestWorkspaceFixture();
	vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
	vi.stubEnv(
		"KANBAN_INTER_WORK_UNIT_RELATION_LEDGER_STORAGE_ROOT",
		join(fixture.isolatedHomeDirectoryPath, "relation-ledger"),
	);
	const projectPath = join(fixture.ownedIntegrationProjectsDirectoryPath, "fingerprint-race-project");
	await mkdir(projectPath, { recursive: true });
	fixture.createNonBareRepositoryAtOwnedPath({ repositoryPath: projectPath, initialBranchName: "main" });
	await saveWorkspaceState(projectPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
		board: {
			columns: [
				{
					id: "backlog",
					title: "Backlog",
					cards: [
						{
							id: "source",
							title: item.title,
							prompt: item.prompt,
							createdAt: 2,
							updatedAt: 2,
							baseRef: "main",
							startInPlanMode: true,
						},
					],
				},
				{
					id: "in_progress",
					title: "In Progress",
					cards: [
						{
							id: "old",
							title: material.title,
							prompt: material.prompt,
							createdAt: 1,
							updatedAt: 1,
							baseRef: "main",
							startInPlanMode: true,
						},
					],
				},
			],
		},
		sessions: {},
	});
	const { workspaceId } = await loadWorkspaceContext(projectPath);
	const activeCapture = activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture();
	await activeCapture.eagerBoardStateBaselineEstablishmentForEveryIndexedWorkspaceCompletion;
	const writeApi = createWorkUnitRelationAssertionWriteApi({
		readRecordedInterWorkUnitRelationProjection:
			readRecordedInterWorkUnitRelationProjectionOfActiveKanbanRuntimeLiveCapture,
		runInterWorkUnitRelationLedgerClientOperation: (operation) =>
			runInterWorkUnitRelationLedgerClientOperationOfActiveKanbanRuntimeLiveCapture(
				async (client, instance) =>
					await operation(
						{
							readInterWorkUnitRelationAssertionWriteGuardState: async (input) => {
								const guard = await client.readInterWorkUnitRelationAssertionWriteGuardState(input);
								await onWriteGuardRead?.();
								return guard;
							},
							commitInterWorkUnitRelationAssertionStateTransitionWithCompareAndSet: (input) =>
								client.commitInterWorkUnitRelationAssertionStateTransitionWithCompareAndSet(input),
						},
						instance,
					),
			),
		getWorkspacePathById: () => projectPath,
	});
	const updateCandidatePrompt = async (prompt: string) =>
		await mutateWorkspaceState(projectPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, ({ board }) => ({
			board: {
				...board,
				columns: board.columns.map((column) => ({
					...column,
					cards: column.cards.map((card) => (card.id === "old" ? { ...card, prompt } : card)),
				})),
			},
			value: undefined,
		}));
	const readMaterials = async () =>
		(
			await collectTaskIndexingMaterials({
				workspaceId,
				listLiveSessionSummaries: () => [],
				includeRecapSources: false,
			})
		).materials;
	const readCommittedRelations = async () =>
		await runInterWorkUnitRelationLedgerClientOperationOfActiveKanbanRuntimeLiveCapture(async (client) =>
			(await client.listCommittedEvents({})).filter(
				(event) => event.eventKind === "relation_affecting_confirmable_change_created_and_routed",
			),
		);
	return {
		fixture,
		workspaceId,
		projectPath,
		writeApi,
		updateCandidatePrompt,
		readMaterials,
		readCommittedRelations,
		close: async () => {
			await activeCapture.deactivate();
			registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(null);
			vi.unstubAllEnvs();
		},
	};
}

describe("新工作项分诊的保守处置与可恢复回执", () => {
	it.each([
		[[candidate()], "linked_to_existing_task", false],
		[[candidate("partial_overlap")], "created_task_with_possible_relations", true],
		[[], "created_task_without_relations", true],
	] as const)("三种处置按证据执行，并且同键重试不重复写入", async (candidates, decision, created) => {
		const h = await harness([...candidates]);
		const result = await h.run();
		expect(result.decision).toBe(decision);
		expect(h.calls.includes("create")).toBe(created);
		const calls = [...h.calls];
		expect(await h.run()).toEqual(result);
		expect(h.calls).toEqual(calls);
	});
	it("并发同键只分析和建卡一次，失败后从已提交步骤恢复", async () => {
		const h = await harness([]);
		let failed = false;
		h.effects.recordDisposition = async () => {
			if (!failed) {
				failed = true;
				throw new Error("账本暂不可用");
			}
			h.calls.push("disposition");
		};
		await expect(h.run()).rejects.toThrow("operation");
		const results = await Promise.all([h.run(), h.run()]);
		expect(results[0]).toEqual(results[1]);
		expect(h.calls.filter((call) => call === "create")).toHaveLength(1);
		expect(h.calls.filter((call) => call === "analyze")).toHaveLength(1);
	});
	it("发现卡补查保留原卡，不建第二张卡，并排除自身", async () => {
		const h = await harness([candidate()]);
		const result = await h.run({ ...item, existing_finding_task: reference("finding") });
		expect(result.existing_finding_task_preserved).toBe(true);
		expect(h.calls).not.toContain("create");
		expect(h.calls).toContain("comment:finding");
	});
	it("同键不同正文拒绝覆盖回执；分析后要求发生变化时拒绝写入", async () => {
		const h = await harness([candidate()]);
		h.effects.analyze = async () => {
			h.effects.readCurrentMaterials = async () => [{ ...material, prompt: "要求已变化" }];
			return { relation_candidates: [candidate()] };
		};
		await expect(h.run()).rejects.toThrow("要求");
		expect(h.calls).not.toContain("create");
		await expect(h.run({ ...item, prompt: "另一个正文" })).rejects.toThrow("同一");
	});
	it.each([{ evidence: [] }, { evidence: [""] }, { evidence: [" \t\n"] }])(
		"空白证据 $evidence 不授予完整覆盖，也不能抑制建卡",
		async ({ evidence }) => {
			const unverifiedCandidate = { ...candidate(), evidence };
			const analysis = validateIncomingWorkItemRelationCandidates({
				workspaceId: "project",
				item,
				analysis: { relation_candidates: [unverifiedCandidate] },
				materials: [material],
				fullRequirements: [material],
			});
			expect(analysis.relation_candidates[0]).toMatchObject({
				coverage: "partial_overlap",
				confidence: "medium",
				evidence: [],
			});
			expect(selectFullyCoveringExistingTask(analysis)).toBeNull();
			const h = await harness([unverifiedCandidate]);
			expect((await h.run()).decision).toBe("created_task_with_possible_relations");
			expect(h.calls).toContain("create");
		},
	);
	it("混合空白证据会规范化，有效完整覆盖仍关联已有任务", async () => {
		const analysis = validateIncomingWorkItemRelationCandidates({
			workspaceId: "project",
			item,
			analysis: { relation_candidates: [{ ...candidate(), evidence: ["", "  src/example.ts:1 \n", " \t"] }] },
			materials: [material],
			fullRequirements: [material],
		});
		expect(analysis.relation_candidates[0]).toMatchObject({
			coverage: "fully_covers_incoming_work",
			confidence: "high",
			evidence: ["src/example.ts:1"],
		});
		const h = await harness(analysis.relation_candidates);
		expect((await h.run()).decision).toBe("linked_to_existing_task");
		expect(h.calls).not.toContain("create");
	});
	it("普通候选缺少证据仍保留，非法证据类型继续拒绝", () => {
		const analyze = (evidence: unknown[]) =>
			validateIncomingWorkItemRelationCandidates({
				workspaceId: "project",
				item,
				analysis: { relation_candidates: [{ ...candidate("partial_overlap"), evidence }] },
				materials: [material],
				fullRequirements: [material],
			});
		expect(analyze([" \t"]).relation_candidates[0]).toMatchObject({
			coverage: "partial_overlap",
			confidence: "high",
			evidence: [],
		});
		expect(() => analyze([123])).toThrow();
	});
	it("建卡之后候选要求变化时最终账本拒写，并保留副作用回执供安全重试", async () => {
		const h = await isolatedLedgerRaceHarness();
		try {
			const directory = join(h.fixture.isolatedHomeDirectoryPath, "durable-triage-operations");
			const calls: string[] = [];
			const scopedCandidate = { ...candidate("partial_overlap"), task_reference: reference("old", h.workspaceId) };
			const subject = { ...reference("new", h.workspaceId), taskIncarnationCreatedAtEpochMs: 2 };
			const effects: IncomingWorkItemTriageEffects = {
				allocateTaskIdentity: async () => subject,
				readCurrentMaterials: h.readMaterials,
				analyze: async () => ({ relation_candidates: [scopedCandidate] }),
				createBacklogTask: async () => {
					calls.push("create");
					await mutateWorkspaceState(h.projectPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, ({ board }) => ({
						board: {
							...board,
							columns: board.columns.map((column) =>
								column.id === "backlog"
									? {
											...column,
											cards: [
												...column.cards,
												{
													id: subject.taskId,
													title: item.title,
													prompt: item.prompt,
													createdAt: 2,
													updatedAt: 2,
													baseRef: "main",
													startInPlanMode: true,
												},
											],
										}
									: column,
							),
						},
						value: undefined,
					}));
					await h.updateCandidatePrompt("用户改写了候选要求");
				},
				appendComment: async () => {
					calls.push("comment");
				},
				assertUnverifiedRelations: async (input) => {
					await h.writeApi.assertUnverifiedReferenceRelationAsTaskIndexingSupport({
						subject: input.subject,
						candidate: scopedCandidate,
						expectedRequirementsFingerprintByTaskIdentity: input.expectedRequirementsFingerprintByTaskIdentity,
					});
				},
				recordDisposition: async () => {
					calls.push("disposition");
				},
			};
			const run = () =>
				triageIncomingWorkItemWithDurableOperation({
					workspaceId: h.workspaceId,
					item,
					operationDirectoryPath: directory,
					effects,
				});
			await expect(run()).rejects.toThrow("要求");
			expect(await h.readCommittedRelations()).toHaveLength(0);
			expect(await listDurableIncomingWorkItemTriageOperations(directory)).toMatchObject([
				{
					completed: false,
					completedSteps: ["create_backlog_task", "append_related_finding"],
					startedSteps: ["create_backlog_task", "append_related_finding", "assert_unverified_reference_relations"],
				},
			]);
			await expect(run()).rejects.toThrow("要求");
			expect(calls).toEqual(["create", "comment"]);
			await h.updateCandidatePrompt(material.prompt);
			await expect(run()).resolves.toMatchObject({ decision: "created_task_with_possible_relations" });
			expect(calls).toEqual(["create", "comment", "disposition"]);
			expect(await h.readCommittedRelations()).toHaveLength(1);
		} finally {
			await h.close();
		}
	});

	it("最终账本提交前的并发改写等待同一 board 锁，完成后释放锁且关系仍绑定原要求", async () => {
		let markGuardRead!: () => void;
		const guardRead = new Promise<void>((resolve) => {
			markGuardRead = resolve;
		});
		let allowGuardToContinue!: () => void;
		const releaseGuard = new Promise<void>((resolve) => {
			allowGuardToContinue = resolve;
		});
		const h = await isolatedLedgerRaceHarness(async () => {
			markGuardRead();
			await releaseGuard;
		});
		let write: Promise<void> | undefined;
		let edit: Promise<unknown> | undefined;
		try {
			const expectedRequirementsFingerprintByTaskIdentity = Object.fromEntries(
				(await h.readMaterials()).map((material) => [
					JSON.stringify(material.taskReference),
					taskIndexingMaterialRequirementsFingerprint(material),
				]),
			);
			write = h.writeApi.assertUnverifiedReferenceRelationAsTaskIndexingSupport({
				subject: { ...reference("source", h.workspaceId), taskIncarnationCreatedAtEpochMs: 2 },
				candidate: { ...candidate("partial_overlap"), task_reference: reference("old", h.workspaceId) },
				expectedRequirementsFingerprintByTaskIdentity,
			});
			await guardRead;
			const lockAcquisition = vi.spyOn(lockedFileSystem, "withLock");
			let editCompleted = false;
			edit = h.updateCandidatePrompt("提交期间的用户新要求").then(() => {
				editCompleted = true;
			});
			await vi.waitFor(() =>
				expect(lockAcquisition).toHaveBeenCalledWith(
					expect.objectContaining({ type: "directory" }),
					expect.any(Function),
				),
			);
			lockAcquisition.mockRestore();
			expect(editCompleted).toBe(false);
			expect(
				(await loadWorkspaceBoardById(h.workspaceId)).columns
					.flatMap((column) => column.cards)
					.find((card) => card.id === "old")?.prompt,
			).toBe(material.prompt);
			allowGuardToContinue();
			await write;
			await edit;
			expect(
				(await loadWorkspaceBoardById(h.workspaceId)).columns
					.flatMap((column) => column.cards)
					.find((card) => card.id === "old")?.prompt,
			).toBe("提交期间的用户新要求");
			expect(await h.readCommittedRelations()).toMatchObject([
				{
					eventPayload: {
						proposedInterWorkUnitRelationAssertion: {
							endpointPlanFingerprintsAtAssertion: {
								anchorEndpointPlanFingerprint: taskIndexingTextFingerprint(JSON.stringify(material.prompt)),
							},
						},
					},
				},
			]);
		} finally {
			allowGuardToContinue();
			await Promise.allSettled([write, edit]);
			vi.restoreAllMocks();
			await h.close();
		}
	});

	it("跨项目、缺少完整要求、Done 和不实身份均不能压制新卡", () => {
		const analyze = (materials: TaskIndexingMaterial[], fullRequirements: TaskIndexingMaterial[]) =>
			validateIncomingWorkItemRelationCandidates({
				workspaceId: "project",
				item,
				analysis: { relation_candidates: [candidate()] },
				materials,
				fullRequirements,
			});
		expect(analyze([material], []).relation_candidates[0]?.coverage).toBe("partial_overlap");
		expect(analyze([{ ...material, columnId: "trash" }], [material]).relation_candidates[0]?.coverage).toBe(
			"partial_overlap",
		);
		expect(() => analyze([], [])).toThrow("不存在");
		const cross = { ...candidate(), task_reference: reference("old", "other") };
		expect(
			validateIncomingWorkItemRelationCandidates({
				workspaceId: "project",
				item,
				analysis: { relation_candidates: [cross] },
				materials: [{ ...material, taskReference: cross.task_reference }],
				fullRequirements: [material],
			}).relation_candidates[0],
		).toMatchObject({ cross_project: true, coverage: "partial_overlap" });
	});
});
