// 会话回收期限账本：绝对期限落盘、每 task 至多一条 live、supersede、状态机推进、
// 上限裁剪、损坏容错、路径遍历拒绝、并发写串行、跨 workspace 聚合。
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	AGENT_SESSION_RUNTIME_RECLAMATION_GRACE_PERIOD_AFTER_RESPONSE_GENERATION_STOPPED_MS,
	computeAgentSessionRuntimeReclamationEligibleAt,
} from "../../src/core/session-activity";
import {
	buildAgentSessionReclamationDeadlineRecordId,
	clearAgentSessionReclamationDeadlineRecords,
	findLiveAgentSessionReclamationDeadlineRecord,
	isLiveAgentSessionReclamationState,
	type RecordAgentSessionRetentionDeadlineInput,
	readAgentSessionReclamationDeadlineRecords,
	readAllAgentSessionReclamationDeadlineRecords,
	recordAgentSessionRetentionDeadline,
	supersedeAgentSessionRetentionDeadlinesForTask,
	updateAgentSessionReclamationProgress,
} from "../../src/state/agent-session-reclamation-deadline-store";
import { getWorkspaceDirectoryPath } from "../../src/state/workspace-state";
import { withIsolatedWorkspaceHome } from "./isolated-workspace-home-fixture";

const STOPPED_AT = 1_700_000_000_000;

function stopAnchorInput(
	overrides: Partial<RecordAgentSessionRetentionDeadlineInput> = {},
): RecordAgentSessionRetentionDeadlineInput {
	return {
		taskId: "task-a",
		agentId: "claude",
		sessionTransport: "pty_terminal",
		runtimeSessionIncarnationId: "incarnation-1",
		agentResponseGenerationTurnSequence: 0,
		retentionAnchorKind: "agent_response_generation_stopped",
		retentionAnchorAt: STOPPED_AT,
		responseGenerationStopSignalConfidence: "harness_turn_complete",
		reclamationEligibleAt: computeAgentSessionRuntimeReclamationEligibleAt(STOPPED_AT),
		recordedAt: STOPPED_AT,
		...overrides,
	};
}

describe.sequential("agent-session-reclamation-deadline-store integration", () => {
	it("落盘的是绝对可回收时刻（锚点 + 宽限期），不是剩余时长", async () => {
		await withIsolatedWorkspaceHome(async (registerIsolatedWorkspace) => {
			const { workspaceId } = await registerIsolatedWorkspace("project-a");
			await recordAgentSessionRetentionDeadline(workspaceId, stopAnchorInput());

			const records = await readAgentSessionReclamationDeadlineRecords(workspaceId);
			expect(records).toHaveLength(1);
			expect(records[0]?.reclamationEligibleAt).toBe(
				STOPPED_AT + AGENT_SESSION_RUNTIME_RECLAMATION_GRACE_PERIOD_AFTER_RESPONSE_GENERATION_STOPPED_MS,
			);
			expect(records[0]?.retentionAnchorAt).toBe(STOPPED_AT);
			expect(records[0]?.reclamationState).toBe("grace_running");
			expect(records[0]?.recordId).toBe("task-a:incarnation-1:0");
		});
	});

	it("同一活体同一轮重复落库幂等，只刷新期限、不追加第二条", async () => {
		await withIsolatedWorkspaceHome(async (registerIsolatedWorkspace) => {
			const { workspaceId } = await registerIsolatedWorkspace("project-a");
			await recordAgentSessionRetentionDeadline(workspaceId, stopAnchorInput());
			await recordAgentSessionRetentionDeadline(
				workspaceId,
				stopAnchorInput({
					retentionAnchorAt: STOPPED_AT + 5_000,
					reclamationEligibleAt: computeAgentSessionRuntimeReclamationEligibleAt(STOPPED_AT + 5_000),
					recordedAt: STOPPED_AT + 5_000,
				}),
			);

			const records = await readAgentSessionReclamationDeadlineRecords(workspaceId);
			expect(records).toHaveLength(1);
			expect(records[0]?.retentionAnchorAt).toBe(STOPPED_AT + 5_000);
		});
	});

	it("新活体 / 新回合到来时旧记录置 superseded，维持每 task 至多一条 live", async () => {
		await withIsolatedWorkspaceHome(async (registerIsolatedWorkspace) => {
			const { workspaceId } = await registerIsolatedWorkspace("project-a");
			await recordAgentSessionRetentionDeadline(workspaceId, stopAnchorInput());
			// 同活体、下一轮。
			await recordAgentSessionRetentionDeadline(
				workspaceId,
				stopAnchorInput({ agentResponseGenerationTurnSequence: 1, recordedAt: STOPPED_AT + 10_000 }),
			);
			// 新活体（会话被重启过）。
			await recordAgentSessionRetentionDeadline(
				workspaceId,
				stopAnchorInput({
					runtimeSessionIncarnationId: "incarnation-2",
					agentResponseGenerationTurnSequence: 0,
					recordedAt: STOPPED_AT + 20_000,
				}),
			);

			const records = await readAgentSessionReclamationDeadlineRecords(workspaceId);
			expect(records).toHaveLength(3);
			const live = records.filter((record) => isLiveAgentSessionReclamationState(record.reclamationState));
			expect(live).toHaveLength(1);
			expect(live[0]?.recordId).toBe("task-a:incarnation-2:0");
			expect(findLiveAgentSessionReclamationDeadlineRecord(records, "task-a")?.recordId).toBe(
				"task-a:incarnation-2:0",
			);
		});
	});

	it("会话在到期前继续跑了 → supersede 该 task 全部 live 记录，不碰其它 task", async () => {
		await withIsolatedWorkspaceHome(async (registerIsolatedWorkspace) => {
			const { workspaceId } = await registerIsolatedWorkspace("project-a");
			await recordAgentSessionRetentionDeadline(workspaceId, stopAnchorInput());
			await recordAgentSessionRetentionDeadline(workspaceId, stopAnchorInput({ taskId: "task-b" }));

			const supersededCount = await supersedeAgentSessionRetentionDeadlinesForTask(
				workspaceId,
				"task-a",
				STOPPED_AT + 1_000,
			);
			expect(supersededCount).toBe(1);

			const records = await readAgentSessionReclamationDeadlineRecords(workspaceId);
			expect(findLiveAgentSessionReclamationDeadlineRecord(records, "task-a")).toBeNull();
			expect(findLiveAgentSessionReclamationDeadlineRecord(records, "task-b")?.taskId).toBe("task-b");

			// 幂等：没有 live 记录可作废时返回 0，不产生多余写入。
			expect(await supersedeAgentSessionRetentionDeadlinesForTask(workspaceId, "task-a", STOPPED_AT + 2_000)).toBe(
				0,
			);
		});
	});

	it("回收状态机推进：reclaiming → reclaim_failed（计次 + 退避）→ reclaimed", async () => {
		await withIsolatedWorkspaceHome(async (registerIsolatedWorkspace) => {
			const { workspaceId } = await registerIsolatedWorkspace("project-a");
			await recordAgentSessionRetentionDeadline(workspaceId, stopAnchorInput());
			const recordId = buildAgentSessionReclamationDeadlineRecordId({
				taskId: "task-a",
				runtimeSessionIncarnationId: "incarnation-1",
				agentResponseGenerationTurnSequence: 0,
			});

			await updateAgentSessionReclamationProgress(workspaceId, recordId, {
				reclamationState: "reclaiming",
				updatedAt: STOPPED_AT + 1,
				incrementAttemptCount: true,
			});
			const failed = await updateAgentSessionReclamationProgress(workspaceId, recordId, {
				reclamationState: "reclaim_failed",
				updatedAt: STOPPED_AT + 2,
				nextReclaimRetryAt: STOPPED_AT + 4_000,
				lastReclaimFailureReason: "SIGKILL 后仍存活",
			});
			expect(failed?.reclamationAttemptCount).toBe(1);
			expect(failed?.nextReclaimRetryAt).toBe(STOPPED_AT + 4_000);
			expect(isLiveAgentSessionReclamationState("reclaim_failed")).toBe(true);

			const reclaimed = await updateAgentSessionReclamationProgress(workspaceId, recordId, {
				reclamationState: "reclaimed",
				updatedAt: STOPPED_AT + 3,
				incrementAttemptCount: true,
				nextReclaimRetryAt: null,
				lastReclaimFailureReason: null,
			});
			expect(reclaimed?.reclamationAttemptCount).toBe(2);
			expect(isLiveAgentSessionReclamationState("reclaimed")).toBe(false);

			// 未知 recordId 返回 null，不静默创建。
			expect(
				await updateAgentSessionReclamationProgress(workspaceId, "no-such-record", {
					reclamationState: "reclaimed",
					updatedAt: STOPPED_AT + 4,
				}),
			).toBeNull();
		});
	});

	it("park 轨道：可存无期限（reclamationEligibleAt = null）", async () => {
		await withIsolatedWorkspaceHome(async (registerIsolatedWorkspace) => {
			const { workspaceId } = await registerIsolatedWorkspace("project-a");
			await recordAgentSessionRetentionDeadline(
				workspaceId,
				stopAnchorInput({
					retentionAnchorKind: "session_parked_awaiting_dispatched_background_work",
					responseGenerationStopSignalConfidence: null,
					reclamationEligibleAt: null,
				}),
			);
			const records = await readAgentSessionReclamationDeadlineRecords(workspaceId);
			expect(records[0]?.reclamationEligibleAt).toBeNull();
			expect(records[0]?.responseGenerationStopSignalConfidence).toBeNull();
			expect(records[0]?.retentionAnchorKind).toBe("session_parked_awaiting_dispatched_background_work");
		});
	});

	it("上限 200 丢最旧", async () => {
		await withIsolatedWorkspaceHome(async (registerIsolatedWorkspace) => {
			const { workspaceId } = await registerIsolatedWorkspace("project-a");
			for (let index = 0; index < 205; index += 1) {
				await recordAgentSessionRetentionDeadline(
					workspaceId,
					stopAnchorInput({ taskId: `task-${index}`, recordedAt: STOPPED_AT + index }),
				);
			}
			const records = await readAgentSessionReclamationDeadlineRecords(workspaceId);
			expect(records).toHaveLength(200);
			expect(records.some((record) => record.taskId === "task-0")).toBe(false);
			expect(records.some((record) => record.taskId === "task-204")).toBe(true);
		});
	});

	it("文件损坏 → fail-open 读成空，不抛（宁可少回收也不阻断启动）", async () => {
		await withIsolatedWorkspaceHome(async (registerIsolatedWorkspace) => {
			const { workspaceId } = await registerIsolatedWorkspace("project-a");
			await recordAgentSessionRetentionDeadline(workspaceId, stopAnchorInput());
			await writeFile(
				join(getWorkspaceDirectoryPath(workspaceId), "agent-session-reclamation-deadlines.json"),
				"{ 这不是合法 JSON",
				"utf8",
			);
			await expect(readAgentSessionReclamationDeadlineRecords(workspaceId)).resolves.toEqual([]);

			// schema 不匹配（合法 JSON 但形状错）同样 fail-open。
			await writeFile(
				join(getWorkspaceDirectoryPath(workspaceId), "agent-session-reclamation-deadlines.json"),
				JSON.stringify([{ recordId: "x" }]),
				"utf8",
			);
			await expect(readAgentSessionReclamationDeadlineRecords(workspaceId)).resolves.toEqual([]);
		});
	});

	it("workspaceId 逃逸 workspaces 根 → 拒绝访问", async () => {
		await withIsolatedWorkspaceHome(async (registerIsolatedWorkspace) => {
			await registerIsolatedWorkspace("project-a");
			await expect(readAgentSessionReclamationDeadlineRecords("../escaped")).rejects.toThrow(
				/outside workspaces root/,
			);
			await expect(recordAgentSessionRetentionDeadline("../escaped", stopAnchorInput())).rejects.toThrow(
				/outside workspaces root/,
			);
		});
	});

	it("并发写串行不丢", async () => {
		await withIsolatedWorkspaceHome(async (registerIsolatedWorkspace) => {
			const { workspaceId } = await registerIsolatedWorkspace("project-a");
			await Promise.all(
				Array.from({ length: 50 }, (_unused, index) =>
					recordAgentSessionRetentionDeadline(
						workspaceId,
						stopAnchorInput({ taskId: `task-${index}`, recordedAt: STOPPED_AT + index }),
					),
				),
			);
			expect(await readAgentSessionReclamationDeadlineRecords(workspaceId)).toHaveLength(50);
		});
	});

	it("readAll 聚合多 workspace，空 workspace 不出现；clear 清空", async () => {
		await withIsolatedWorkspaceHome(async (registerIsolatedWorkspace) => {
			const first = await registerIsolatedWorkspace("project-a");
			const second = await registerIsolatedWorkspace("project-b");
			const empty = await registerIsolatedWorkspace("project-c");
			await recordAgentSessionRetentionDeadline(first.workspaceId, stopAnchorInput());
			await recordAgentSessionRetentionDeadline(first.workspaceId, stopAnchorInput({ taskId: "task-b" }));
			await recordAgentSessionRetentionDeadline(second.workspaceId, stopAnchorInput({ taskId: "task-c" }));

			const all = await readAllAgentSessionReclamationDeadlineRecords();
			expect(all[first.workspaceId]).toHaveLength(2);
			expect(all[second.workspaceId]).toHaveLength(1);
			expect(all[empty.workspaceId]).toBeUndefined();

			await clearAgentSessionReclamationDeadlineRecords(first.workspaceId);
			expect(await readAgentSessionReclamationDeadlineRecords(first.workspaceId)).toEqual([]);
		});
	});
});
