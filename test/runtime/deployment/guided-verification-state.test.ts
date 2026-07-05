import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
	RuntimeGuidedVerificationDeploymentGroup,
	RuntimeGuidedVerificationState,
	RuntimeGuidedVerificationTask,
} from "../../../src/core/api-contract";
import {
	computeRequiredAcknowledgementsForColumn,
	consumePendingConfirmation,
	consumePendingConfirmationAndMarkVerified,
	getActiveGroup,
	getGuidedVerificationStatePath,
	markTaskVerified,
	reconcileGroup,
	setPendingConfirmation,
	updateTaskChecklist,
} from "../../../src/deployment/guided-verification-state";
import { createTempDir } from "../../utilities/temp-dir";

// guided-verification-state 的 state 文件路径 = join(getRuntimeHomePath(), ...) = join(homedir(), ".cline", "kanban", ...)，
// homedir() 在 POSIX 下读 $HOME。故用「临时 HOME」把 state 文件重定向到隔离沙箱（沿用 runtime-config.test.ts 的 HOME 覆盖手法）。
// 所有「当前时间」用测试传入的固定 iso 字符串——模块本身不取时钟。
describe.sequential("guided-verification-state", () => {
	let sandbox: ReturnType<typeof createTempDir>;
	let previousHome: string | undefined;
	let previousUserProfile: string | undefined;

	beforeEach(() => {
		sandbox = createTempDir("kanban-guided-verification-state-");
		previousHome = process.env.HOME;
		previousUserProfile = process.env.USERPROFILE;
		process.env.HOME = sandbox.path;
		process.env.USERPROFILE = sandbox.path;
	});

	afterEach(() => {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		sandbox.cleanup();
	});

	// ── 固定测试 iso（模块不取时钟，全部由外部传入）─────────────────────────────
	const PAST_ISO = "2026-01-01T00:00:00.000Z";
	const NOW_ISO = "2026-06-01T00:00:00.000Z";
	const FAR_FUTURE_ISO = "2999-01-01T00:00:00.000Z";

	function stateFilePath(): string {
		return getGuidedVerificationStatePath();
	}

	function writeStateToDisk(state: RuntimeGuidedVerificationState): void {
		const path = stateFilePath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
	}

	function readStateFromDisk(): RuntimeGuidedVerificationState {
		return JSON.parse(readFileSync(stateFilePath(), "utf8")) as RuntimeGuidedVerificationState;
	}

	function findTaskOnDisk(deploymentId: string, taskId: string): RuntimeGuidedVerificationTask | undefined {
		return readStateFromDisk()
			.deploymentGroups.find((group) => group.deploymentId === deploymentId)
			?.tasks.find((task) => task.taskId === taskId);
	}

	// deploymentId 必须是合法 uuid（schema 约束），故用真 uuid。
	function newDeploymentId(): string {
		return randomUUID();
	}

	function buildTask(
		overrides: Partial<RuntimeGuidedVerificationTask> & { taskId: string },
	): RuntimeGuidedVerificationTask {
		return {
			taskId: overrides.taskId,
			columnIdAtMatch: overrides.columnIdAtMatch ?? "review",
			matchedCommits: overrides.matchedCommits ?? [],
			inclusionReason: overrides.inclusionReason ?? "commit_correlation",
			checklist: overrides.checklist ?? [{ id: "item-1", label: "验证项", checked: false, source: "commit" }],
			verifiedAt: overrides.verifiedAt ?? null,
			boardMovedToDoneAt: overrides.boardMovedToDoneAt ?? null,
			pendingConfirmation: overrides.pendingConfirmation ?? null,
			droppedReason: overrides.droppedReason ?? null,
		};
	}

	function buildGroup(
		overrides: Partial<RuntimeGuidedVerificationDeploymentGroup> & { deploymentId: string },
	): RuntimeGuidedVerificationDeploymentGroup {
		return {
			deploymentId: overrides.deploymentId,
			workspaceId: overrides.workspaceId ?? "ws-1",
			deployedSourceCommit: overrides.deployedSourceCommit ?? "a".repeat(40),
			previousDeployedSourceCommit: overrides.previousDeployedSourceCommit ?? null,
			deployedAtIso: overrides.deployedAtIso ?? PAST_ISO,
			foldedAtIso: overrides.foldedAtIso ?? null,
			tasks: overrides.tasks ?? [],
		};
	}

	it("token 过期后下次写盘 GC 清除 pendingConfirmation", async () => {
		const deploymentId = newDeploymentId();
		writeStateToDisk({
			deploymentGroups: [
				buildGroup({
					deploymentId,
					tasks: [
						buildTask({
							taskId: "task-expired-token",
							pendingConfirmation: {
								token: "tok-expired",
								// 过期时间早于 NOW_ISO → 下次写盘 GC 清除。
								expiresAtIso: PAST_ISO,
								requiredAcknowledgements: ["skip_validation"],
								columnIdAtIssuance: "review",
							},
						}),
					],
				}),
			],
		});

		// getActiveGroup 经 mutate 骨架读改写，写盘时归一化顺带 GC 过期 token。
		await getActiveGroup("ws-1", NOW_ISO);

		expect(findTaskOnDisk(deploymentId, "task-expired-token")?.pendingConfirmation).toBeNull();
	});

	it("consumePendingConfirmation：token 匹配则一次性消费、不匹配报 token_mismatch、过期报 expired 并清除", async () => {
		const deploymentId = newDeploymentId();
		writeStateToDisk({
			deploymentGroups: [
				buildGroup({
					deploymentId,
					tasks: [
						buildTask({
							taskId: "task-happy",
							pendingConfirmation: {
								token: "tok-happy",
								expiresAtIso: FAR_FUTURE_ISO,
								requiredAcknowledgements: ["skip_validation"],
								columnIdAtIssuance: "review",
							},
						}),
						buildTask({
							taskId: "task-mismatch",
							pendingConfirmation: {
								token: "tok-real",
								expiresAtIso: FAR_FUTURE_ISO,
								requiredAcknowledgements: ["skip_validation"],
								columnIdAtIssuance: "review",
							},
						}),
						buildTask({
							taskId: "task-stale",
							pendingConfirmation: {
								token: "tok-stale",
								expiresAtIso: PAST_ISO,
								requiredAcknowledgements: ["skip_validation"],
								columnIdAtIssuance: "review",
							},
						}),
					],
				}),
			],
		});

		// 先消费过期 token：走 consume 自身的 expired 分支（须在任何其它写盘之前，否则归一化 GC 会先清掉它 → no_pending_confirmation）。
		const stale = await consumePendingConfirmation(deploymentId, "task-stale", "tok-stale", NOW_ISO);
		expect(stale.ok).toBe(false);
		expect(stale.failureReason).toBe("expired");
		// 过期顺带清除。
		expect(findTaskOnDisk(deploymentId, "task-stale")?.pendingConfirmation).toBeNull();

		const happy = await consumePendingConfirmation(deploymentId, "task-happy", "tok-happy", NOW_ISO);
		expect(happy.ok).toBe(true);
		expect(findTaskOnDisk(deploymentId, "task-happy")?.pendingConfirmation).toBeNull();

		const mismatch = await consumePendingConfirmation(deploymentId, "task-mismatch", "tok-wrong", NOW_ISO);
		expect(mismatch.ok).toBe(false);
		expect(mismatch.failureReason).toBe("token_mismatch");
		// 不匹配不消费：token 仍在。
		expect(findTaskOnDisk(deploymentId, "task-mismatch")?.pendingConfirmation?.token).toBe("tok-real");
	});

	it("发放时列变化重发 token：setPendingConfirmation 覆盖后旧 token 失效（token_mismatch）", async () => {
		const deploymentId = newDeploymentId();
		writeStateToDisk({
			deploymentGroups: [buildGroup({ deploymentId, tasks: [buildTask({ taskId: "task-reissue" })] })],
		});

		// 首次发放（发放时列 review）。
		await setPendingConfirmation(
			deploymentId,
			"task-reissue",
			{
				token: "tok-old",
				expiresAtIso: FAR_FUTURE_ISO,
				requiredAcknowledgements: ["skip_validation"],
				columnIdAtIssuance: "review",
			},
			NOW_ISO,
		);
		// 列变化 → handler 重算 requiredAcknowledgements 并重发新 token（覆盖旧的）。
		await setPendingConfirmation(
			deploymentId,
			"task-reissue",
			{
				token: "tok-new",
				expiresAtIso: FAR_FUTURE_ISO,
				requiredAcknowledgements: ["skip_validation", "in_progress_active"],
				columnIdAtIssuance: "in_progress",
			},
			NOW_ISO,
		);

		// 用旧 token 确认 → 失效。
		const consumedOld = await consumePendingConfirmation(deploymentId, "task-reissue", "tok-old", NOW_ISO);
		expect(consumedOld.ok).toBe(false);
		expect(consumedOld.failureReason).toBe("token_mismatch");

		// 新 token 仍可用。
		const consumedNew = await consumePendingConfirmation(deploymentId, "task-reissue", "tok-new", NOW_ISO);
		expect(consumedNew.ok).toBe(true);
	});

	it("损坏 JSON：隔离改名 + 降级空组重建，不 throw", async () => {
		const path = stateFilePath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "{ this is not valid json", "utf8");

		// 读到损坏内容不应 throw；降级为空组（active 为 null）。
		const active = await getActiveGroup("ws-1", NOW_ISO);
		expect(active).toBeNull();

		// 主文件被重建为合法空组。
		expect(readStateFromDisk()).toEqual({ deploymentGroups: [] });

		// 损坏内容被隔离到 .corrupt-<ts> 兄弟文件。
		const dir = dirname(path);
		const corruptSiblings = readdirSync(dir).filter((entry) => entry.startsWith(`${basename(path)}.corrupt-`));
		expect(corruptSiblings).toHaveLength(1);
		expect(readFileSync(`${dir}/${corruptSiblings[0]}`, "utf8")).toBe("{ this is not valid json");
	});

	it("reconcile 双向：新进 validation 任务加入 + 删除/手动移出标 droppedReason，且 pendingConfirmation 在途的不被标 dropped（finding #3）", async () => {
		const deploymentId = newDeploymentId();
		writeStateToDisk({
			deploymentGroups: [
				buildGroup({
					deploymentId,
					tasks: [
						// 仍在 review → 保留。
						buildTask({ taskId: "review-kept", columnIdAtMatch: "review" }),
						// 看板上已不存在 → task_deleted。
						buildTask({ taskId: "deleted" }),
						// 已移入 trash 且无在途确认 → moved_out_manually。
						buildTask({ taskId: "moved-trash" }),
						// 已移入 trash 但 confirmation 在途（Web 正要 confirm）→ 不标 dropped（finding #3）。
						buildTask({
							taskId: "confirming",
							pendingConfirmation: {
								token: "tok-inflight",
								expiresAtIso: FAR_FUTURE_ISO,
								requiredAcknowledgements: ["skip_validation"],
								columnIdAtIssuance: "review",
							},
						}),
					],
				}),
			],
		});

		await reconcileGroup({
			deploymentId,
			currentBoardTasks: [
				{ taskId: "review-kept", columnId: "review" },
				{ taskId: "moved-trash", columnId: "trash" },
				{ taskId: "confirming", columnId: "trash" },
				// deploy 后新进 validation 列、组内尚无 → 动态加入。
				{ taskId: "new-validation", columnId: "validation" },
				// 注意：不含 "deleted" → 视为已从看板删除。
			],
			nowIso: NOW_ISO,
		});

		expect(findTaskOnDisk(deploymentId, "review-kept")?.droppedReason).toBeNull();
		expect(findTaskOnDisk(deploymentId, "deleted")?.droppedReason).toBe("task_deleted");
		expect(findTaskOnDisk(deploymentId, "moved-trash")?.droppedReason).toBe("moved_out_manually");
		// finding #3：在途确认的任务即便已在 trash 也不被误标。
		expect(findTaskOnDisk(deploymentId, "confirming")?.droppedReason).toBeNull();

		const added = findTaskOnDisk(deploymentId, "new-validation");
		expect(added?.inclusionReason).toBe("validation_column");
		expect(added?.droppedReason).toBeNull();
	});

	it("markTaskVerified 一并清除误标的 droppedReason（finding #3 纵深防御）", async () => {
		const deploymentId = newDeploymentId();
		writeStateToDisk({
			deploymentGroups: [
				buildGroup({
					deploymentId,
					tasks: [
						buildTask({
							taskId: "task-race-aftermath",
							checklist: [{ id: "item-1", label: "验证项", checked: true, source: "commit" }],
							// 竞态后遗症：reconcile 误标 + confirm 仍在途。
							droppedReason: "moved_out_manually",
							pendingConfirmation: {
								token: "tok",
								expiresAtIso: FAR_FUTURE_ISO,
								requiredAcknowledgements: ["skip_validation"],
								columnIdAtIssuance: "review",
							},
						}),
					],
				}),
			],
		});

		const marked = await markTaskVerified(deploymentId, "task-race-aftermath", NOW_ISO);
		expect(marked.ok).toBe(true);

		const persisted = findTaskOnDisk(deploymentId, "task-race-aftermath");
		expect(persisted?.verifiedAt).toBe(NOW_ISO);
		expect(persisted?.boardMovedToDoneAt).toBe(NOW_ISO);
		expect(persisted?.pendingConfirmation).toBeNull();
		// 关键：误标被清除，任务不再被 liveTasks(droppedReason===null) 过滤器排除出 done 计数。
		expect(persisted?.droppedReason).toBeNull();
	});

	it("consumePendingConfirmationAndMarkVerified：原子消费 token 并标记完成，一并清除误标 droppedReason（issue B）", async () => {
		const deploymentId = newDeploymentId();
		writeStateToDisk({
			deploymentGroups: [
				buildGroup({
					deploymentId,
					tasks: [
						buildTask({
							taskId: "task-atomic",
							checklist: [{ id: "item-1", label: "验证项", checked: true, source: "commit" }],
							// 竞态后遗症：reconcile 误标，confirm 仍在途。
							droppedReason: "moved_out_manually",
							pendingConfirmation: {
								token: "tok-ok",
								expiresAtIso: FAR_FUTURE_ISO,
								requiredAcknowledgements: ["skip_validation"],
								columnIdAtIssuance: "review",
							},
						}),
					],
				}),
			],
		});

		const marked = await consumePendingConfirmationAndMarkVerified(deploymentId, "task-atomic", "tok-ok", NOW_ISO);
		expect(marked.ok).toBe(true);
		expect(marked.alreadyVerified).toBeUndefined();

		const persisted = findTaskOnDisk(deploymentId, "task-atomic");
		expect(persisted?.verifiedAt).toBe(NOW_ISO);
		expect(persisted?.boardMovedToDoneAt).toBe(NOW_ISO);
		// token 一次性消费。
		expect(persisted?.pendingConfirmation).toBeNull();
		// 误标一并清除，不被 liveTasks(droppedReason===null) 过滤器排除出 done 计数。
		expect(persisted?.droppedReason).toBeNull();
	});

	it("consumePendingConfirmationAndMarkVerified：已 verified 则幂等成功、不再要求 token（issue B 恢复）", async () => {
		const deploymentId = newDeploymentId();
		writeStateToDisk({
			deploymentGroups: [
				buildGroup({
					deploymentId,
					tasks: [
						buildTask({
							taskId: "task-already",
							verifiedAt: PAST_ISO,
							boardMovedToDoneAt: PAST_ISO,
							// 上次成功 confirm 已清除 token。
							pendingConfirmation: null,
						}),
					],
				}),
			],
		});

		// 用任意 token 再次 confirm（模拟「confirm 成功但响应丢失、客户端重试」）→ 幂等成功、不覆盖首次完成时间。
		const marked = await consumePendingConfirmationAndMarkVerified(
			deploymentId,
			"task-already",
			"tok-whatever",
			NOW_ISO,
		);
		expect(marked.ok).toBe(true);
		expect(marked.alreadyVerified).toBe(true);
		expect(findTaskOnDisk(deploymentId, "task-already")?.verifiedAt).toBe(PAST_ISO);
	});

	it("consumePendingConfirmationAndMarkVerified：token 不匹配则不消费不标记（无绕过后门）", async () => {
		const deploymentId = newDeploymentId();
		writeStateToDisk({
			deploymentGroups: [
				buildGroup({
					deploymentId,
					tasks: [
						buildTask({
							taskId: "task-wrong-token",
							checklist: [{ id: "item-1", label: "验证项", checked: true, source: "commit" }],
							pendingConfirmation: {
								token: "tok-real",
								expiresAtIso: FAR_FUTURE_ISO,
								requiredAcknowledgements: ["skip_validation"],
								columnIdAtIssuance: "review",
							},
						}),
					],
				}),
			],
		});

		const marked = await consumePendingConfirmationAndMarkVerified(
			deploymentId,
			"task-wrong-token",
			"tok-wrong",
			NOW_ISO,
		);
		expect(marked.ok).toBe(false);
		expect(marked.failureReason).toBe("token_mismatch");

		const persisted = findTaskOnDisk(deploymentId, "task-wrong-token");
		// 未标记、token 仍在。
		expect(persisted?.verifiedAt).toBeNull();
		expect(persisted?.pendingConfirmation?.token).toBe("tok-real");
	});

	it("computeRequiredAcknowledgementsForColumn：合法来源列返回 acks、非法列返回 null（列门控单一真源，issue C）", () => {
		expect(computeRequiredAcknowledgementsForColumn("validation")).toEqual([]);
		expect(computeRequiredAcknowledgementsForColumn("review")).toEqual(["skip_validation"]);
		expect(computeRequiredAcknowledgementsForColumn("in_progress")).toEqual([
			"skip_validation",
			"in_progress_active",
		]);
		// 非法完成来源列一律 null（Web 拒绝，CLI 现也对齐拒绝）。
		expect(computeRequiredAcknowledgementsForColumn("backlog")).toBeNull();
		expect(computeRequiredAcknowledgementsForColumn("trash")).toBeNull();
	});

	it("历史组封顶 20：裁剪最旧折叠组，活跃组不被裁", async () => {
		const baseMs = Date.parse(PAST_ISO);
		const foldedGroups = Array.from({ length: 22 }, (_unused, index) =>
			buildGroup({
				deploymentId: newDeploymentId(),
				// 单调递增部署时间，确保裁剪按「最旧」确定。
				deployedAtIso: new Date(baseMs + index * 3_600_000).toISOString(),
				foldedAtIso: new Date(baseMs + index * 3_600_000 + 60_000).toISOString(),
			}),
		);
		const activeGroup = buildGroup({
			deploymentId: newDeploymentId(),
			deployedAtIso: new Date(baseMs + 100 * 3_600_000).toISOString(),
			foldedAtIso: null,
		});
		const oldestTwoIds = [foldedGroups[0].deploymentId, foldedGroups[1].deploymentId];
		writeStateToDisk({ deploymentGroups: [...foldedGroups, activeGroup] });

		// getActiveGroup 无 touchedDeploymentId → 纯 retention 裁剪。
		await getActiveGroup("ws-1", NOW_ISO);

		const persisted = readStateFromDisk();
		const foldedOnDisk = persisted.deploymentGroups.filter((group) => group.foldedAtIso !== null);
		const activeOnDisk = persisted.deploymentGroups.filter((group) => group.foldedAtIso === null);
		expect(foldedOnDisk).toHaveLength(20);
		// 活跃组恒保留。
		expect(activeOnDisk.map((group) => group.deploymentId)).toContain(activeGroup.deploymentId);
		// 最旧两个折叠组被裁掉。
		const persistedIds = new Set(persisted.deploymentGroups.map((group) => group.deploymentId));
		expect(persistedIds.has(oldestTwoIds[0])).toBe(false);
		expect(persistedIds.has(oldestTwoIds[1])).toBe(false);
	});

	it("finding #4：mutation 触达的最旧折叠组豁免裁剪，改动落盘不丢", async () => {
		const baseMs = Date.parse(PAST_ISO);
		// 21 个折叠组（> 封顶 20）；最旧一个含待勾选任务。
		const foldedGroups = Array.from({ length: 21 }, (_unused, index) =>
			buildGroup({
				deploymentId: newDeploymentId(),
				deployedAtIso: new Date(baseMs + index * 3_600_000).toISOString(),
				foldedAtIso: new Date(baseMs + index * 3_600_000 + 60_000).toISOString(),
				tasks:
					index === 0
						? [
								buildTask({
									taskId: "t-old",
									checklist: [{ id: "item-1", label: "验证项", checked: false, source: "commit" }],
								}),
							]
						: [],
			}),
		);
		const oldestId = foldedGroups[0].deploymentId;
		writeStateToDisk({ deploymentGroups: foldedGroups });

		// 勾选最旧折叠组内任务：若无豁免，normalize 会把该组裁掉 → ok 但不落盘（bug）。
		const result = await updateTaskChecklist(
			{
				deploymentId: oldestId,
				taskId: "t-old",
				operation: "toggle_checklist_item",
				itemId: "item-1",
				checked: true,
			},
			NOW_ISO,
		);
		expect(result.ok).toBe(true);

		// 豁免生效：该组仍在盘上，且勾选已落盘。
		const persistedTask = findTaskOnDisk(oldestId, "t-old");
		expect(persistedTask).toBeDefined();
		expect(persistedTask?.checklist.find((item) => item.id === "item-1")?.checked).toBe(true);
	});
});
