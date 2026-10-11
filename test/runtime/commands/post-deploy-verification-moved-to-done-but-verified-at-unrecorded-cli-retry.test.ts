import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { registerDeploymentCommand } from "../../../src/commands/deployment";
import {
	buildKanbanCliCompletionAuthorizedBeforeMoveIntoDone,
	decideKanbanCliRetryForTaskMovedToDoneButVerifiedAtUnrecorded,
	formatKanbanCliPostDeployVerificationCompletionRetryCommand,
	type KanbanCliPostDeployVerificationCompletionEntryPoint,
} from "../../../src/commands/post-deploy-verification-moved-to-done-but-verified-at-unrecorded-cli-retry";
import type * as TaskCommandModule from "../../../src/commands/task";
import {
	type RuntimeBoardColumnId,
	type RuntimeBoardData,
	type RuntimePostDeployVerificationAcknowledgement,
	type RuntimePostDeployVerificationChecklistItem,
	type RuntimePostDeployVerificationPendingConfirmation,
	type RuntimePostDeployVerificationState,
	type RuntimePostDeployVerificationTask,
	type RuntimePostDeployVerificationUncheckedChecklistItemClosureReason,
	runtimeBoardDataSchema,
	runtimePostDeployVerificationPendingConfirmationSchema,
} from "../../../src/core/api-contract";
import { buildPostDeployVerificationTaskFieldsAddedForDeploymentAttributionAndClosureWithDefaults } from "../../../src/deployment/post-deploy-verification-deployment-group-task-assembly";
import { getPostDeployVerificationStatePath } from "../../../src/deployment/post-deploy-verification-state";
import type * as WorkspaceStateModule from "../../../src/state/workspace-state";
import { createTempDir } from "../../utilities/temp-dir";

// CLI 层回归（RVF-005）：照「移入 Done 成功、verifiedAt 未记」时打印的重跑命令原样重跑，runtime 由假 tRPC client 代替。
const fakeKanbanRuntimeObservedByCliRerun = vi.hoisted(() => ({
	boardOfWorkspace: null as RuntimeBoardData | null,
	printedJsonPayloads: [] as unknown[],
	markVerifiedAfterKanbanCliMovedItToDoneInputs: [] as unknown[],
	moveTaskCardIntoDoneInputs: [] as unknown[],
}));

vi.mock("../../../src/commands/task", async (importOriginal) => {
	const original = await importOriginal<typeof TaskCommandModule>();
	const fakeRuntimeTrpcClient = {
		workspace: {
			getState: {
				query: async () => ({ board: fakeKanbanRuntimeObservedByCliRerun.boardOfWorkspace, sessions: {} }),
			},
		},
		deployment: {
			markPostDeployVerificationTaskVerifiedAfterKanbanCliMovedItToDone: {
				mutate: async (input: unknown) => {
					fakeKanbanRuntimeObservedByCliRerun.markVerifiedAfterKanbanCliMovedItToDoneInputs.push(input);
					return { ok: true, task: null };
				},
			},
		},
		taskCardAction: {
			moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktree: {
				mutate: async (input: unknown) => {
					fakeKanbanRuntimeObservedByCliRerun.moveTaskCardIntoDoneInputs.push(input);
					throw new Error("the rerun must not move the task again");
				},
			},
		},
	};
	return {
		...original,
		createRuntimeTrpcClient: () =>
			fakeRuntimeTrpcClient as unknown as ReturnType<typeof original.createRuntimeTrpcClient>,
		printJson: (payload: unknown) => {
			fakeKanbanRuntimeObservedByCliRerun.printedJsonPayloads.push(payload);
		},
	};
});

vi.mock("../../../src/state/workspace-state", async (importOriginal) => {
	const original = await importOriginal<typeof WorkspaceStateModule>();
	return {
		...original,
		loadWorkspaceBoardById: async () => {
			if (!fakeKanbanRuntimeObservedByCliRerun.boardOfWorkspace) {
				throw new Error("test board not set");
			}
			return fakeKanbanRuntimeObservedByCliRerun.boardOfWorkspace;
		},
		loadWorkspaceContextById: async (workspaceId: string) =>
			({ workspaceId, repoPath: "/nonexistent-kanban-cli-rerun-test-repo" }) as unknown as Awaited<
				ReturnType<typeof original.loadWorkspaceContextById>
			>,
	};
});

const NOW_ISO = "2026-10-01T12:00:00.000Z";
const IN_FLIGHT_RECORD_EXPIRES_AT_ISO = "2026-10-01T12:15:00.000Z";
const IN_FLIGHT_CONFIRMATION_TOKEN = "in-flight-confirmation-token";

// 构造「CLI 已移入 Done、runtime 补记 verifiedAt 失败」时盘上的任务：verifiedAt=null、留有在途完成记录。
// 默认 checklist 全勾（空）；带原因结案的场景传入未勾项与移列前写进在途记录的逐项原因。
function buildTaskMovedToDoneWithInFlightCompletionRecord(input: {
	columnIdAtIssuance: RuntimeBoardColumnId;
	recordedAcknowledgements: RuntimePostDeployVerificationAcknowledgement[];
	expiresAtIso?: string;
	checklist?: RuntimePostDeployVerificationChecklistItem[];
	recordedUncheckedChecklistItemClosureReasons?: RuntimePostDeployVerificationUncheckedChecklistItemClosureReason[];
}): RuntimePostDeployVerificationTask {
	return {
		taskId: "task-moved-to-done",
		columnIdAtMatch: input.columnIdAtIssuance,
		matchedCommits: [],
		inclusionReason: "validation_column",
		checklist: input.checklist ?? [],
		verifiedAt: null,
		boardMovedToDoneAt: null,
		pendingConfirmation: {
			token: IN_FLIGHT_CONFIRMATION_TOKEN,
			expiresAtIso: input.expiresAtIso ?? IN_FLIGHT_RECORD_EXPIRES_AT_ISO,
			requiredAcknowledgements: input.recordedAcknowledgements,
			columnIdAtIssuance: input.columnIdAtIssuance,
			...(input.recordedUncheckedChecklistItemClosureReasons
				? {
						kanbanCliCompletionAuthorizedBeforeMoveIntoDone: {
							authorizedAtIso: NOW_ISO,
							confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag: false,
							uncheckedChecklistItemClosureReasons: input.recordedUncheckedChecklistItemClosureReasons,
						},
					}
				: {}),
		},
		droppedReason: null,
		...buildPostDeployVerificationTaskFieldsAddedForDeploymentAttributionAndClosureWithDefaults(),
	};
}

const verificationCompleteEntryPoint: KanbanCliPostDeployVerificationCompletionEntryPoint = {
	kind: "verification_complete_without_confirmation_token",
};

function buildUncheckedGuidedManualChecklistItem(id: string): RuntimePostDeployVerificationChecklistItem {
	return {
		id,
		label: `unchecked item ${id}`,
		checked: false,
		source: "authored",
		kind: "guided_manual",
		guidance: null,
		script: null,
		run: null,
		cleanup: null,
	};
}

const RECORDED_CLOSURE_REASON_FOR_ITEM_A: RuntimePostDeployVerificationUncheckedChecklistItemClosureReason = {
	checklistItemId: "item-a",
	uncheckedChecklistItemClosureReasonCode: "manual_reproduction_cost_exceeds_verification_value",
};

describe("移入 Done 成功、verifiedAt 未记：CLI 原样重跑的补记判定", () => {
	it("validation 来源（空 acks）：重跑 verification-complete 放行补记，不算 forced", () => {
		const decision = decideKanbanCliRetryForTaskMovedToDoneButVerifiedAtUnrecorded({
			task: buildTaskMovedToDoneWithInFlightCompletionRecord({
				columnIdAtIssuance: "validation",
				recordedAcknowledgements: [],
			}),
			entryPoint: verificationCompleteEntryPoint,
			nowIso: NOW_ISO,
		});
		expect(decision).toEqual({
			retryAllowed: true,
			sourceColumnIdBeforeMoveToDone: "validation",
			inFlightCompletionRecordExpiresAtIso: IN_FLIGHT_RECORD_EXPIRES_AT_ISO,
			confirmedAcknowledgements: [],
			confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag: false,
			uncheckedChecklistItemClosureReasons: [],
		});
	});

	it("review 来源（非空 acks）：无 token 的 verification-complete 不放行，避免伪造 skip_validation 确认", () => {
		const decision = decideKanbanCliRetryForTaskMovedToDoneButVerifiedAtUnrecorded({
			task: buildTaskMovedToDoneWithInFlightCompletionRecord({
				columnIdAtIssuance: "review",
				recordedAcknowledgements: ["skip_validation"],
			}),
			entryPoint: verificationCompleteEntryPoint,
			nowIso: NOW_ISO,
		});
		expect(decision.retryAllowed).toBe(false);
		expect(decision).toMatchObject({ requiredAcknowledgements: ["skip_validation"] });
	});

	it("token 路径：同 token + 同 acks 放行；token 或 acks 不符一律拒绝", () => {
		const task = buildTaskMovedToDoneWithInFlightCompletionRecord({
			columnIdAtIssuance: "in_progress",
			recordedAcknowledgements: ["skip_validation", "in_progress_active"],
		});
		expect(
			decideKanbanCliRetryForTaskMovedToDoneButVerifiedAtUnrecorded({
				task,
				entryPoint: {
					kind: "verification_confirm_with_confirmation_token",
					presentedConfirmationToken: IN_FLIGHT_CONFIRMATION_TOKEN,
					presentedAcknowledgements: ["in_progress_active", "skip_validation"],
				},
				nowIso: NOW_ISO,
			}),
		).toMatchObject({
			retryAllowed: true,
			sourceColumnIdBeforeMoveToDone: "in_progress",
			confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag: false,
			uncheckedChecklistItemClosureReasons: [],
		});
		expect(
			decideKanbanCliRetryForTaskMovedToDoneButVerifiedAtUnrecorded({
				task,
				entryPoint: {
					kind: "verification_confirm_with_confirmation_token",
					presentedConfirmationToken: "some-other-token",
					presentedAcknowledgements: ["skip_validation", "in_progress_active"],
				},
				nowIso: NOW_ISO,
			}),
		).toEqual({ retryAllowed: false, error: "Confirmation token mismatch." });
		expect(
			decideKanbanCliRetryForTaskMovedToDoneButVerifiedAtUnrecorded({
				task,
				entryPoint: {
					kind: "verification_confirm_with_confirmation_token",
					presentedConfirmationToken: IN_FLIGHT_CONFIRMATION_TOKEN,
					presentedAcknowledgements: ["skip_validation"],
				},
				nowIso: NOW_ISO,
			}).retryAllowed,
		).toBe(false);
	});

	it("--force 路径：acks 与在途记录完全一致才放行，并保留 forced 证据", () => {
		const task = buildTaskMovedToDoneWithInFlightCompletionRecord({
			columnIdAtIssuance: "review",
			recordedAcknowledgements: ["skip_validation"],
		});
		expect(
			decideKanbanCliRetryForTaskMovedToDoneButVerifiedAtUnrecorded({
				task,
				entryPoint: {
					kind: "verification_confirm_with_force_break_glass",
					presentedAcknowledgements: ["skip_validation"],
				},
				nowIso: NOW_ISO,
			}),
		).toMatchObject({ retryAllowed: true, confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag: true });
		expect(
			decideKanbanCliRetryForTaskMovedToDoneButVerifiedAtUnrecorded({
				task,
				entryPoint: { kind: "verification_confirm_with_force_break_glass", presentedAcknowledgements: [] },
				nowIso: NOW_ISO,
			}),
		).toMatchObject({ retryAllowed: false, requiredAcknowledgements: ["skip_validation"] });
	});

	it("无在途记录（手动拖入 Done）、记录已过期、时间不可解析、来源列非法、已 verified：一律不放行", () => {
		const validationTask = buildTaskMovedToDoneWithInFlightCompletionRecord({
			columnIdAtIssuance: "validation",
			recordedAcknowledgements: [],
		});
		const rejectedTasks: RuntimePostDeployVerificationTask[] = [
			{ ...validationTask, pendingConfirmation: null },
			buildTaskMovedToDoneWithInFlightCompletionRecord({
				columnIdAtIssuance: "validation",
				recordedAcknowledgements: [],
				expiresAtIso: NOW_ISO,
			}),
			buildTaskMovedToDoneWithInFlightCompletionRecord({
				columnIdAtIssuance: "validation",
				recordedAcknowledgements: [],
				expiresAtIso: "not-an-iso-timestamp",
			}),
			buildTaskMovedToDoneWithInFlightCompletionRecord({
				columnIdAtIssuance: "backlog",
				recordedAcknowledgements: [],
			}),
			{ ...validationTask, verifiedAt: "2026-10-01T11:59:00.000Z" },
		];
		for (const task of rejectedTasks) {
			expect(
				decideKanbanCliRetryForTaskMovedToDoneButVerifiedAtUnrecorded({
					task,
					entryPoint: verificationCompleteEntryPoint,
					nowIso: NOW_ISO,
				}).retryAllowed,
			).toBe(false);
		}
	});
});

// 2026-10-11 之前（f6f08d5e）api-contract.ts 的 pendingConfirmation schema 逐字副本：回滚到旧 binary 时它解析状态文件，
// 任一条记录解析失败，整个文件就会被隔离成 .corrupt-*、降级为空组。
const pendingConfirmationSchemaOfKanbanBinaryBefore20261011 = z.object({
	token: z.string(),
	expiresAtIso: z.string(),
	requiredAcknowledgements: z.array(z.enum(["skip_validation", "in_progress_active"])),
	columnIdAtIssuance: z.enum(["backlog", "in_progress", "review", "validation", "trash"]),
	kanbanCliCompletionAuthorizedBeforeMoveIntoDone: z
		.object({
			authorizedAtIso: z.string(),
			forcedCompletionWithoutAllVerificationsPassed: z.boolean(),
		})
		.optional(),
});

describe("CLI 在途完成记录与旧 binary 的兼容", () => {
	it("新写入的「已授权」标记两个 force 字段同值双写，旧 binary 的 schema 能解析，新 schema 也读得出逐项原因", () => {
		for (const forced of [true, false]) {
			const inFlightCompletionRecord: RuntimePostDeployVerificationPendingConfirmation = {
				token: IN_FLIGHT_CONFIRMATION_TOKEN,
				expiresAtIso: IN_FLIGHT_RECORD_EXPIRES_AT_ISO,
				requiredAcknowledgements: ["skip_validation"],
				columnIdAtIssuance: "review",
				kanbanCliCompletionAuthorizedBeforeMoveIntoDone: buildKanbanCliCompletionAuthorizedBeforeMoveIntoDone({
					authorizedAtIso: NOW_ISO,
					confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag: forced,
					uncheckedChecklistItemClosureReasons: [
						{
							checklistItemId: "authored:a",
							uncheckedChecklistItemClosureReasonCode: "manual_reproduction_cost_exceeds_verification_value",
						},
					],
				}),
			};
			const persistedJson = JSON.parse(JSON.stringify(inFlightCompletionRecord)) as unknown;

			expect(pendingConfirmationSchemaOfKanbanBinaryBefore20261011.parse(persistedJson)).toMatchObject({
				kanbanCliCompletionAuthorizedBeforeMoveIntoDone: { forcedCompletionWithoutAllVerificationsPassed: forced },
			});
			expect(runtimePostDeployVerificationPendingConfirmationSchema.parse(persistedJson)).toMatchObject({
				kanbanCliCompletionAuthorizedBeforeMoveIntoDone: {
					confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag: forced,
					uncheckedChecklistItemClosureReasons: [{ checklistItemId: "authored:a" }],
				},
			});
		}
	});

	it("只写新字段的记录旧 binary 解析失败（本用例守住的回归）", () => {
		expect(
			pendingConfirmationSchemaOfKanbanBinaryBefore20261011.safeParse({
				token: IN_FLIGHT_CONFIRMATION_TOKEN,
				expiresAtIso: IN_FLIGHT_RECORD_EXPIRES_AT_ISO,
				requiredAcknowledgements: [],
				columnIdAtIssuance: "validation",
				kanbanCliCompletionAuthorizedBeforeMoveIntoDone: {
					authorizedAtIso: NOW_ISO,
					confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag: false,
				},
			}).success,
		).toBe(false);
	});
});

describe("带原因结案的任务：补记只认在途记录里移列前写下的原因", () => {
	it("在途记录的原因覆盖全部未勾项：照提示重跑（不带 --closure-reason-*）即放行，原因原样取回", () => {
		const decision = decideKanbanCliRetryForTaskMovedToDoneButVerifiedAtUnrecorded({
			task: buildTaskMovedToDoneWithInFlightCompletionRecord({
				columnIdAtIssuance: "validation",
				recordedAcknowledgements: [],
				checklist: [buildUncheckedGuidedManualChecklistItem("item-a")],
				recordedUncheckedChecklistItemClosureReasons: [RECORDED_CLOSURE_REASON_FOR_ITEM_A],
			}),
			entryPoint: verificationCompleteEntryPoint,
			nowIso: NOW_ISO,
		});
		expect(decision).toMatchObject({
			retryAllowed: true,
			uncheckedChecklistItemClosureReasons: [RECORDED_CLOSURE_REASON_FOR_ITEM_A],
		});
	});

	it("移列后 checklist 多出在途记录没给原因的未勾项：不放行，并列出缺原因的项", () => {
		const decision = decideKanbanCliRetryForTaskMovedToDoneButVerifiedAtUnrecorded({
			task: buildTaskMovedToDoneWithInFlightCompletionRecord({
				columnIdAtIssuance: "review",
				recordedAcknowledgements: ["skip_validation"],
				checklist: [
					buildUncheckedGuidedManualChecklistItem("item-a"),
					buildUncheckedGuidedManualChecklistItem("item-added-after-move"),
				],
				recordedUncheckedChecklistItemClosureReasons: [RECORDED_CLOSURE_REASON_FOR_ITEM_A],
			}),
			entryPoint: {
				kind: "verification_confirm_with_force_break_glass",
				presentedAcknowledgements: ["skip_validation"],
			},
			nowIso: NOW_ISO,
		});
		expect(decision.retryAllowed).toBe(false);
		expect(decision).toMatchObject({ error: expect.stringContaining("item-added-after-move") });
		expect(decision).not.toMatchObject({ error: expect.stringContaining("item-a (") });
	});

	it("有未勾项却没有任何在途原因（旧形状记录）：不放行", () => {
		const task = buildTaskMovedToDoneWithInFlightCompletionRecord({
			columnIdAtIssuance: "validation",
			recordedAcknowledgements: [],
			checklist: [buildUncheckedGuidedManualChecklistItem("item-a")],
		});
		expect(
			decideKanbanCliRetryForTaskMovedToDoneButVerifiedAtUnrecorded({
				task,
				entryPoint: verificationCompleteEntryPoint,
				nowIso: NOW_ISO,
			}).retryAllowed,
		).toBe(false);
	});
});

describe.sequential("CLI 照提示原样重跑（不带 --closure-reason-*）：带原因结案的任务只补记、不报缺原因", () => {
	// 部署组键在 schema 里必须是 uuid。
	const DEPLOYMENT_ID_OF_GROUP_WITH_TASK_MOVED_TO_DONE = "0d6f2a3e-5b1c-4c8e-9a7d-2f4e6b8c1a3d";
	let sandbox: ReturnType<typeof createTempDir>;
	let previousHome: string | undefined;
	let previousExitCode: typeof process.exitCode;

	beforeEach(() => {
		sandbox = createTempDir("kanban-post-deploy-verification-cli-rerun-without-closure-reason-options-");
		previousHome = process.env.HOME;
		process.env.HOME = sandbox.path;
		previousExitCode = process.exitCode;
		fakeKanbanRuntimeObservedByCliRerun.boardOfWorkspace = null;
		fakeKanbanRuntimeObservedByCliRerun.printedJsonPayloads.length = 0;
		fakeKanbanRuntimeObservedByCliRerun.markVerifiedAfterKanbanCliMovedItToDoneInputs.length = 0;
		fakeKanbanRuntimeObservedByCliRerun.moveTaskCardIntoDoneInputs.length = 0;
	});

	afterEach(() => {
		process.exitCode = previousExitCode;
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		sandbox.cleanup();
	});

	function placeTaskOnBoardColumnAndWriteState(input: {
		boardColumnId: RuntimeBoardColumnId;
		task: RuntimePostDeployVerificationTask;
	}): void {
		fakeKanbanRuntimeObservedByCliRerun.boardOfWorkspace = runtimeBoardDataSchema.parse({
			columns: [
				{
					id: input.boardColumnId,
					title: input.boardColumnId,
					cards: [
						{
							id: input.task.taskId,
							prompt: "task prompt",
							startInPlanMode: false,
							baseRef: "main",
							createdAt: 0,
							updatedAt: 0,
						},
					],
				},
			],
		});
		const state: RuntimePostDeployVerificationState = {
			deploymentGroups: [
				{
					deploymentId: DEPLOYMENT_ID_OF_GROUP_WITH_TASK_MOVED_TO_DONE,
					workspaceId: "ws-1",
					deployedSourceCommit: "a".repeat(40),
					previousDeployedSourceCommit: null,
					deployedAtIso: "2026-10-01T11:00:00.000Z",
					foldedAtIso: null,
					tasks: [input.task],
				},
			],
		};
		mkdirSync(dirname(getPostDeployVerificationStatePath()), { recursive: true });
		writeFileSync(getPostDeployVerificationStatePath(), JSON.stringify(state, null, 2), "utf8");
	}

	async function runKanbanCli(argv: string[]): Promise<unknown> {
		const program = new Command();
		program.exitOverride();
		registerDeploymentCommand(program);
		await program.parseAsync(argv, { from: "user" });
		return fakeKanbanRuntimeObservedByCliRerun.printedJsonPayloads.at(-1);
	}

	// 命令用真实时钟判过期，在途记录的过期时间放在真实「现在」之后。
	const inFlightRecordExpiresAtIsoAfterRealNow = (): string => new Date(Date.now() + 10 * 60 * 1000).toISOString();

	it("verification-complete：用在途记录里的原因补记", async () => {
		placeTaskOnBoardColumnAndWriteState({
			boardColumnId: "trash",
			task: buildTaskMovedToDoneWithInFlightCompletionRecord({
				columnIdAtIssuance: "validation",
				recordedAcknowledgements: [],
				expiresAtIso: inFlightRecordExpiresAtIsoAfterRealNow(),
				checklist: [buildUncheckedGuidedManualChecklistItem("item-a")],
				recordedUncheckedChecklistItemClosureReasons: [RECORDED_CLOSURE_REASON_FOR_ITEM_A],
			}),
		});
		const printed = await runKanbanCli(
			formatKanbanCliPostDeployVerificationCompletionRetryCommand({
				deploymentId: DEPLOYMENT_ID_OF_GROUP_WITH_TASK_MOVED_TO_DONE,
				taskId: "task-moved-to-done",
				entryPoint: verificationCompleteEntryPoint,
			})
				.split(" ")
				.slice(1),
		);
		expect(printed).toMatchObject({ ok: true, moved: false, recordedVerificationForTaskAlreadyMovedToDone: true });
		expect(fakeKanbanRuntimeObservedByCliRerun.markVerifiedAfterKanbanCliMovedItToDoneInputs).toEqual([
			expect.objectContaining({
				deploymentId: DEPLOYMENT_ID_OF_GROUP_WITH_TASK_MOVED_TO_DONE,
				taskId: "task-moved-to-done",
				confirmedAcknowledgements: [],
				uncheckedChecklistItemClosureReasons: [RECORDED_CLOSURE_REASON_FOR_ITEM_A],
			}),
		]);
		expect(fakeKanbanRuntimeObservedByCliRerun.moveTaskCardIntoDoneInputs).toEqual([]);
	});

	it("verification-confirm --token --ack：用在途记录里的原因补记", async () => {
		placeTaskOnBoardColumnAndWriteState({
			boardColumnId: "trash",
			task: buildTaskMovedToDoneWithInFlightCompletionRecord({
				columnIdAtIssuance: "review",
				recordedAcknowledgements: ["skip_validation"],
				expiresAtIso: inFlightRecordExpiresAtIsoAfterRealNow(),
				checklist: [buildUncheckedGuidedManualChecklistItem("item-a")],
				recordedUncheckedChecklistItemClosureReasons: [RECORDED_CLOSURE_REASON_FOR_ITEM_A],
			}),
		});
		const printed = await runKanbanCli(
			formatKanbanCliPostDeployVerificationCompletionRetryCommand({
				deploymentId: DEPLOYMENT_ID_OF_GROUP_WITH_TASK_MOVED_TO_DONE,
				taskId: "task-moved-to-done",
				entryPoint: {
					kind: "verification_confirm_with_confirmation_token",
					presentedConfirmationToken: IN_FLIGHT_CONFIRMATION_TOKEN,
					presentedAcknowledgements: ["skip_validation"],
				},
			})
				.split(" ")
				.slice(1),
		);
		expect(printed).toMatchObject({ ok: true, moved: false, recordedVerificationForTaskAlreadyMovedToDone: true });
		expect(fakeKanbanRuntimeObservedByCliRerun.markVerifiedAfterKanbanCliMovedItToDoneInputs).toEqual([
			expect.objectContaining({
				confirmedAcknowledgements: ["skip_validation"],
				uncheckedChecklistItemClosureReasons: [RECORDED_CLOSURE_REASON_FOR_ITEM_A],
			}),
		]);
		expect(fakeKanbanRuntimeObservedByCliRerun.moveTaskCardIntoDoneInputs).toEqual([]);
	});

	it("任务不在 Done 时仍照旧要求命令行给未勾项原因", async () => {
		placeTaskOnBoardColumnAndWriteState({
			boardColumnId: "validation",
			task: {
				...buildTaskMovedToDoneWithInFlightCompletionRecord({
					columnIdAtIssuance: "validation",
					recordedAcknowledgements: [],
					checklist: [buildUncheckedGuidedManualChecklistItem("item-a")],
				}),
				pendingConfirmation: null,
			},
		});
		const printed = await runKanbanCli([
			"deployment",
			"verification-complete",
			"--deployment-id",
			DEPLOYMENT_ID_OF_GROUP_WITH_TASK_MOVED_TO_DONE,
			"--task-id",
			"task-moved-to-done",
		]);
		expect(printed).toMatchObject({ ok: false, error: expect.stringContaining("Checklist is not fully checked") });
		expect(fakeKanbanRuntimeObservedByCliRerun.markVerifiedAfterKanbanCliMovedItToDoneInputs).toEqual([]);
		expect(fakeKanbanRuntimeObservedByCliRerun.moveTaskCardIntoDoneInputs).toEqual([]);
	});
});

describe("补记失败时回给调用者的原样重跑命令", () => {
	it("三种入口各自还原成同一条可重跑的 kanban 命令", () => {
		const target = { deploymentId: "deploy-1", taskId: "task-1" };
		expect(
			formatKanbanCliPostDeployVerificationCompletionRetryCommand({
				...target,
				entryPoint: verificationCompleteEntryPoint,
			}),
		).toBe("kanban deployment verification-complete --deployment-id deploy-1 --task-id task-1");
		expect(
			formatKanbanCliPostDeployVerificationCompletionRetryCommand({
				...target,
				entryPoint: {
					kind: "verification_confirm_with_confirmation_token",
					presentedConfirmationToken: "token-1",
					presentedAcknowledgements: ["skip_validation", "in_progress_active"],
				},
			}),
		).toBe(
			"kanban deployment verification-confirm --deployment-id deploy-1 --task-id task-1 --token token-1 --ack skip_validation,in_progress_active",
		);
		expect(
			formatKanbanCliPostDeployVerificationCompletionRetryCommand({
				...target,
				entryPoint: { kind: "verification_confirm_with_force_break_glass", presentedAcknowledgements: [] },
			}),
		).toBe("kanban deployment verification-confirm --deployment-id deploy-1 --task-id task-1 --force");
	});
});
