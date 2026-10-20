import { mkdirSync } from "node:fs";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { registerSupportCommand } from "../../src/commands/support";
import { loadRuntimeConfig } from "../../src/config/runtime-config";
import type { RuntimeBoardCard, RuntimeBoardData } from "../../src/core/api-contract";
import { getKanbanRuntimePort, setKanbanRuntimePort } from "../../src/core/runtime-endpoint";
import { incomingWorkItemSchema } from "../../src/core/task-indexing-support-contract";
import { referenceRelationModelingSuggestionsRequestSchema } from "../../src/core/work-unit-relation-modeling-api-contract";
import {
	activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture,
	readRecordedInterWorkUnitRelationProjectionOfActiveKanbanRuntimeLiveCapture,
	runInterWorkUnitRelationLedgerClientOperationOfActiveKanbanRuntimeLiveCapture,
} from "../../src/inter-work-unit-relation-ledger/kanban-runtime-inter-work-unit-relation-ledger-live-capture-activation";
import { registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture } from "../../src/state/workspace-board-persistence-funnel-task-mutation-event-capture-port";
import { loadWorkspaceBoardById, loadWorkspaceContext, saveWorkspaceState } from "../../src/state/workspace-state";
import { collectTaskIndexingMaterials } from "../../src/task-indexing-support/collect-task-indexing-materials";
import {
	taskIndexingMaterialIdentityKey,
	taskIndexingMaterialRequirementsFingerprint,
} from "../../src/task-indexing-support/incoming-work-item-relation-analysis";
import { createTaskIndexingSupportRuntimeService } from "../../src/task-indexing-support/task-indexing-support-runtime-service";
import { type RuntimeTrpcContext, runtimeAppRouter } from "../../src/trpc/app-router";
import { createWorkUnitRelationAssertionWriteApi } from "../../src/trpc/work-unit-relation-assertion-write-api";
import { createWorkUnitRelationReadApi } from "../../src/trpc/work-unit-relation-read-api";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";

describe("共享任务索引经 CLI、tRPC、headless 桩、board 与关系账本的完整链路", { timeout: 60000 }, () => {
	it("保守建卡、追加发现、未核验关系、重启重试和旧发现补查共用内核", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const previousPort = getKanbanRuntimePort();
		vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
		const projectPath = join(fixture.ownedIntegrationProjectsDirectoryPath, "task-indexing-project");
		const executableDirectory = join(fixture.isolatedHomeDirectoryPath, "model-harness-executables");
		mkdirSync(projectPath, { recursive: true });
		mkdirSync(executableDirectory, { recursive: true });
		fixture.createNonBareRepositoryAtOwnedPath({ repositoryPath: projectPath, initialBranchName: "main" });
		const auditPath = join(executableDirectory, "calls.jsonl");
		const fakeClaudePath = join(executableDirectory, "claude");
		await writeFile(
			fakeClaudePath,
			`#!${process.execPath}\nconst fs = require('node:fs');let text='';process.stdin.on('data',chunk=>text+=chunk);process.stdin.on('end',()=>{const query=JSON.parse(text.split('L4 本次查询：\\n').at(-1));const ref=query.knownTaskIdentities.find(ref=>ref.taskId==='old01');const noRelation=query.incomingWorkItem.title.includes('无关');const partial=query.incomingWorkItem.title.includes('部分');const candidates=noRelation?[]:[{task_reference:ref,relation_kind:'reference_concerns_behavior_or_state_of',confidence:'high',coverage:partial?'partial_overlap':'fully_covers_incoming_work',rationale:'当前任务明确承担该问题',evidence:['src/example.ts:1'],cross_project:false}];if(query.incomingWorkItem.existing_finding_task&&['interactive-relation-suggestion','strict-self-validation'].includes(query.incomingWorkItem.work_item_key))candidates.unshift({...candidates[0],task_reference:query.incomingWorkItem.existing_finding_task});fs.appendFileSync(${JSON.stringify(auditPath)},JSON.stringify({title:query.incomingWorkItem.title,knownTaskIdentities:query.knownTaskIdentities,hasHostTaskEnvironment:!!process.env.KANBAN_TASK_ID,argv:process.argv.slice(2)})+'\\n');process.stdout.write(JSON.stringify({type:'result',subtype:'success',structured_output:{relation_candidates:candidates},usage:{input_tokens:100,cache_read_input_tokens:1000,output_tokens:20}})+'\\n');});`,
		);
		await chmod(fakeClaudePath, 0o700);
		vi.stubEnv("PATH", `${executableDirectory}:${process.env.PATH ?? ""}`);
		const createCard = (id: string, title: string, prompt: string, createdAt: number): RuntimeBoardCard => ({
			id,
			title,
			prompt,
			createdAt,
			updatedAt: createdAt,
			baseRef: "main",
			startInPlanMode: true,
		});
		const findingPrompt =
			"KANBAN_TASK_ORIGIN=rvf_validated_out_of_scope_finding\nKANBAN_SUPPORT_AGENT_RELATION_TRIAGE_STATUS=not_triaged\n\n问题与完整证据";
		const board: RuntimeBoardData = {
			columns: [
				{ id: "backlog", title: "Backlog", cards: [createCard("rvf01", "[RVF 发现] 完全覆盖", findingPrompt, 2)] },
				{
					id: "in_progress",
					title: "In Progress",
					cards: [createCard("old01", "修复问题", "当前任务明确承担该问题，要求与证据齐全。", 1)],
				},
				{ id: "review", title: "Review", cards: [] },
				{ id: "validation", title: "Validation", cards: [] },
				{ id: "trash", title: "Done", cards: [] },
			],
		};
		await saveWorkspaceState(projectPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, { board, sessions: {} });
		const workspace = await loadWorkspaceContext(projectPath, { autoCreateIfMissing: false });
		const scope = { workspaceId: workspace.workspaceId, workspacePath: workspace.repoPath };
		const activeCapture = activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture();
		const relationWrite = createWorkUnitRelationAssertionWriteApi({
			readRecordedInterWorkUnitRelationProjection:
				readRecordedInterWorkUnitRelationProjectionOfActiveKanbanRuntimeLiveCapture,
			runInterWorkUnitRelationLedgerClientOperation:
				runInterWorkUnitRelationLedgerClientOperationOfActiveKanbanRuntimeLiveCapture,
			getWorkspacePathById: (id) => (id === scope.workspaceId ? projectPath : null),
		});
		const dependencies = {
			listLiveSessionSummaries: () => [],
			loadScopedRuntimeConfig: async () => await loadRuntimeConfig(projectPath),
			broadcastState: vi.fn(),
			referenceAssertionWritePort: relationWrite,
		};
		let service = createTaskIndexingSupportRuntimeService(dependencies);
		const context = () =>
			({
				requestedWorkspaceId: scope.workspaceId,
				workspaceScope: scope,
				kanbanRequestOriginActorEvidence: {
					decodedCliActorClaimsRequestHeader: { cliActorClaimsRequestHeaderStatus: "absent" },
				},
				taskIndexingSupportApi: service,
			}) as RuntimeTrpcContext;
		const server = createServer(
			createHTTPHandler({ basePath: "/api/trpc/", router: runtimeAppRouter, createContext: context }),
		);
		try {
			await activeCapture.eagerBoardStateBaselineEstablishmentForEveryIndexedWorkspaceCompletion;
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("隔离测试服务器未分配端口");
			expect(address.port).not.toBe(3484);
			setKanbanRuntimePort(address.port);
			const output: string[] = [];
			const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk, encodingOrCallback, callback) => {
				output.push(String(chunk));
				const possibleCallbacks: unknown[] = [encodingOrCallback, callback];
				for (const completion of possibleCallbacks) if (typeof completion === "function") completion();
				return true;
			});
			try {
				const program = new Command();
				program.command("task");
				registerSupportCommand(program);
				await program.parseAsync(["support", "get-task-indexing-context", "--project-path", projectPath], {
					from: "user",
				});
				expect(JSON.parse(output.join("")).workspaceId).toBe(scope.workspaceId);
			} finally {
				stdout.mockRestore();
			}
			const caller = () => runtimeAppRouter.createCaller(context());
			const work = (key: string, title: string) =>
				incomingWorkItemSchema.parse({
					schema_version: 1,
					work_item_key: key,
					title,
					prompt: "该问题的完整要求",
					origin: "rvf_validated_out_of_scope_finding",
				});
			const existingTaskSuggestions = await service.suggestReferenceRelationsForTaskModeling(
				scope,
				referenceRelationModelingSuggestionsRequestSchema.parse({
					workUnit: {
						workUnitSelectorKind: "kanban_board_card_by_bare_task_id",
						bareTaskId: "rvf01",
						workspaceId: scope.workspaceId,
					},
				}),
			);
			expect(existingTaskSuggestions.availability).toBe("available");
			expect(
				existingTaskSuggestions.candidates.map((candidate) => candidate.relationDraft.counterpartWorkUnit),
			).toEqual([
				{
					workUnitType: "kanban_board_card",
					workspaceId: scope.workspaceId,
					taskId: "old01",
					taskIncarnationCreatedAtEpochMs: 1,
				},
			]);
			const draftTaskSuggestions = await service.suggestReferenceRelationsForTaskModeling(
				scope,
				referenceRelationModelingSuggestionsRequestSchema.parse({
					workUnit: null,
					draftTaskTitle: "创建中任务",
					draftTaskPrompt: "当前问题的完整要求",
				}),
			);
			expect(draftTaskSuggestions.candidates).toHaveLength(1);
			await expect(
				service.analyzeIncomingWorkItem(scope, {
					...work("strict-self-validation", "补查自身严格校验"),
					existing_finding_task: {
						workUnitType: "kanban_board_card",
						workspaceId: scope.workspaceId,
						taskId: "rvf01",
						taskIncarnationCreatedAtEpochMs: 2,
					},
				}),
			).rejects.toThrow("发现卡自身");
			const linked = await caller().support.triageIncomingWorkItem(work("linked", "完全覆盖"));
			expect(linked).toMatchObject({ decision: "linked_to_existing_task", linked_task_id: "old01" });
			const created = await caller().support.triageIncomingWorkItem(work("partial", "部分重叠"));
			expect(created.decision).toBe("created_task_with_possible_relations");
			const noRelation = await caller().support.triageIncomingWorkItem({
				...work("none", "[RVF 发现] 无关问题"),
				prompt: findingPrompt,
			});
			expect(noRelation.decision).toBe("created_task_without_relations");
			await service.close();
			service = createTaskIndexingSupportRuntimeService(dependencies);
			expect(await caller().support.triageIncomingWorkItem(work("partial", "部分重叠"))).toEqual(created);
			const backfill = await service.backfillUntriagedRvfFindings(scope);
			expect(backfill.results).toHaveLength(2);
			expect(backfill.results).toEqual(
				expect.arrayContaining([
					{ taskId: "rvf01", status: "completed" },
					{ taskId: noRelation.created_task_id, status: "already_completed" },
				]),
			);
			expect(
				(await service.backfillUntriagedRvfFindings(scope)).results.every(
					(entry) => entry.status === "already_completed",
				),
			).toBe(true);
			const current = await loadWorkspaceBoardById(scope.workspaceId);
			const cards = current.columns.flatMap((column) => column.cards);
			expect(cards).toHaveLength(4);
			expect(cards.find((card) => card.id === "rvf01")?.prompt).toBe(findingPrompt);
			expect(cards.find((card) => card.id === "rvf01")?.taskCommentEntries).toHaveLength(1);
			expect(cards.find((card) => card.id === created.created_task_id)).toMatchObject({
				startInPlanMode: true,
				autoReviewEnabled: false,
			});
			expect(cards.find((card) => card.id === created.created_task_id)).not.toHaveProperty("parentSessionId");
			const readApi = createWorkUnitRelationReadApi({
				readRecordedInterWorkUnitRelationProjection:
					readRecordedInterWorkUnitRelationProjectionOfActiveKanbanRuntimeLiveCapture,
				getWorkspacePathById: () => projectPath,
				readLatestNotificationSummaryTextOfTaskCard: async () => null,
			});
			const neighborhood = await readApi.getRelationNeighborhoodSummary({
				workUnit: {
					workUnitSelectorKind: "kanban_board_card_by_bare_task_id",
					bareTaskId: "old01",
					workspaceId: scope.workspaceId,
				},
			});
			expect(neighborhood.assertedRelations).toHaveLength(2);
			for (const relation of neighborhood.assertedRelations)
				expect(relation).toMatchObject({
					relationAsserterActorKind: "kanban_runtime_system_component",
					relationAsserterWorkUnitRef: null,
					decisionSourcesOfEffectiveAssertion: ["strategy_requires_no_user_review"],
				});
			// 新 support 证据不能继承已有用户确认；用户否定后的墓碑也不能绕过。
			const selectedRelation = neighborhood.assertedRelations.find(
				(relation) =>
					relation.relationStatementSubjectWorkUnitRef.workUnitType === "kanban_board_card" &&
					relation.relationStatementSubjectWorkUnitRef.taskId === created.created_task_id,
			);
			if (
				!selectedRelation ||
				selectedRelation.relationStatementSubjectWorkUnitRef.workUnitType !== "kanban_board_card"
			)
				throw new Error("缺少新卡关系");
			const subject = selectedRelation.relationStatementSubjectWorkUnitRef;
			const counterpart = selectedRelation.relationStatementAnchorWorkUnitRef;
			if (counterpart.workUnitType !== "kanban_board_card") throw new Error("对端身份不正确");
			const selector = (taskId: string) => ({
				workUnitSelectorKind: "kanban_board_card_by_bare_task_id" as const,
				bareTaskId: taskId,
				workspaceId: scope.workspaceId,
			});
			const userEvidence = {
				decodedCliActorClaimsRequestHeader: { cliActorClaimsRequestHeaderStatus: "absent" as const },
				webUiPageLoadRequestOriginNonceVerificationStatus: "verified" as const,
			};
			const gesture = {
				triggeringDomEventIsTrusted: true,
				navigatorWebdriver: false,
				navigatorUserAgent: "isolated-test",
			};
			const confirmed = await relationWrite.assertReferenceRelationDirectlyAsWebUiUser(
				{
					subjectWorkUnit: selector(subject.taskId),
					counterpartWorkUnit: selector(counterpart.taskId),
					relationKind: "reference_concerns_behavior_or_state_of",
					relationAssertionRationaleOneSentence: "用户确认原关系",
					relationAssertionEvidencePointers: ["src/example.ts:1"],
					assertedRelationKindSpecificAttributes: {
						concernNature: "checks_scope_overlap_with",
						concernedAspectSummary: "原问题",
					},
					webUiUserDecisionClientCharacteristics: gesture,
				},
				userEvidence,
			);
			const expectedRequirementsFingerprintByTaskIdentity = Object.fromEntries(
				(
					await collectTaskIndexingMaterials({
						workspaceId: scope.workspaceId,
						listLiveSessionSummaries: () => [],
						includeRecapSources: false,
					})
				).materials.map((material) => [
					taskIndexingMaterialIdentityKey(material),
					taskIndexingMaterialRequirementsFingerprint(material),
				]),
			);
			const supportCandidate = {
				task_reference: counterpart,
				relation_kind: "reference_concerns_behavior_or_state_of" as const,
				confidence: "medium" as const,
				coverage: "partial_overlap" as const,
				cross_project: false,
				rationale: "另一条未核验 support 发现",
				evidence: ["src/example.ts:1"],
			};
			await relationWrite.assertUnverifiedReferenceRelationAsTaskIndexingSupport({
				subject,
				candidate: { ...supportCandidate, evidence: ["new-evidence.ts:2"] },
				expectedRequirementsFingerprintByTaskIdentity,
			});
			const unchanged = (
				await readApi.getRelationNeighborhoodSummary({ workUnit: selector(subject.taskId) })
			).assertedRelations.find((relation) => relation.relationId === selectedRelation.relationId);
			expect(unchanged?.assertedRelationStateVersion).toBe(confirmed.assertedRelation.assertedRelationStateVersion);
			expect(unchanged?.relationAssertionEvidencePointers).not.toContain("new-evidence.ts:2");
			await relationWrite.revokeEffectiveRelationAssertionDirectlyAsWebUiUser(
				{
					relationId: selectedRelation.relationId,
					relationAssertionRevocationReason: "relation_was_incorrect",
					webUiUserDecisionClientCharacteristics: gesture,
				},
				userEvidence,
			);
			await expect(
				relationWrite.assertUnverifiedReferenceRelationAsTaskIndexingSupport({
					subject,
					candidate: supportCandidate,
					expectedRequirementsFingerprintByTaskIdentity,
				}),
			).rejects.toThrow("suppressed");
			const failureWorkItem = {
				...work("partial-write-recovery", "[RVF 发现] 部分失败后恢复"),
				prompt: findingPrompt,
			};
			const workItemFile = join(executableDirectory, "incoming-work-item.json");
			await writeFile(workItemFile, JSON.stringify(failureWorkItem));
			const failedOutput: string[] = [];
			const previousExitCode = process.exitCode;
			const stdoutDuringFailure = vi
				.spyOn(process.stdout, "write")
				.mockImplementation((chunk, encodingOrCallback, callback) => {
					failedOutput.push(String(chunk));
					const possibleCallbacks: unknown[] = [encodingOrCallback, callback];
					for (const completion of possibleCallbacks) if (typeof completion === "function") completion();
					return true;
				});
			const temporarilyUnavailableRelationWrite = vi
				.spyOn(relationWrite, "assertUnverifiedReferenceRelationAsTaskIndexingSupport")
				.mockRejectedValue(new Error("关系账本暂不可用"));
			try {
				const program = new Command();
				program.command("task");
				registerSupportCommand(program);
				await program.parseAsync(
					[
						"support",
						"triage-incoming-work-item",
						"--project-path",
						projectPath,
						"--work-item-file",
						workItemFile,
					],
					{ from: "user" },
				);
				expect(process.exitCode).toBe(1);
				const failure = JSON.parse(failedOutput.join(""));
				expect(failure).toMatchObject({
					ok: false,
					error: {
						operation_id: expect.stringMatching(/^incoming-work-item-/u),
						completed_steps: ["create_backlog_task", "append_related_finding"],
						started_steps: [
							"create_backlog_task",
							"append_related_finding",
							"assert_unverified_reference_relations",
						],
					},
				});
			} finally {
				stdoutDuringFailure.mockRestore();
				temporarilyUnavailableRelationWrite.mockRestore();
				process.exitCode = previousExitCode;
			}
			const recoveredByBackfill = await service.backfillUntriagedRvfFindings(scope);
			expect(recoveredByBackfill.results.filter((entry) => entry.status === "completed")).toHaveLength(1);
			const recovered = await caller().support.triageIncomingWorkItem(failureWorkItem);
			expect(recovered.decision).toBe("created_task_with_possible_relations");
			expect(
				(await loadWorkspaceBoardById(scope.workspaceId)).columns.flatMap((column) => column.cards),
			).toHaveLength(5);
			const calls = (await readFile(auditPath, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(calls).toHaveLength(8);
			expect(calls[0].knownTaskIdentities.map((reference: { taskId: string }) => reference.taskId)).toEqual([
				"old01",
			]);
			expect(calls[1].knownTaskIdentities.map((reference: { taskId: string }) => reference.taskId).sort()).toEqual([
				"old01",
				"rvf01",
			]);
			expect(calls.every((call) => !call.hasHostTaskEnvironment && call.argv.includes("--safe-mode"))).toBe(true);
		} finally {
			await service.close();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await activeCapture.deactivate();
			registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(null);
			setKanbanRuntimePort(previousPort);
			vi.unstubAllEnvs();
		}
	});
});
