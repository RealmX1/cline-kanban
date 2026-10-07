import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultAcpSummary } from "../../../src/acp-client-session/acp-session-state";
import {
	projectUniqueNativeInProgressWorkPhaseGoal,
	resolveAgentCurrentWorkPhaseGoalForDisplay,
} from "../../../src/core/agent-current-work-phase-goal";
import {
	runtimeRenameCurrentTaskRequestSchema,
	runtimeSetCurrentWorkPhaseGoalRequestSchema,
	runtimeTaskSessionSummarySchema,
} from "../../../src/core/api-contract";
import { mergeSummaryWithFacets } from "../../../src/core/session-activity";
import { readClaudeNativeTaskListCurrentWorkPhaseGoal } from "../../../src/terminal/claude-native-task-list-current-work-phase-goal-projection";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";

const explicitGoal = {
	goalText: "验证整个阶段的交付结果",
	source: "agent_explicit_declaration" as const,
	updatedAt: 100,
	owningNativeConversationSessionId: "native-1",
	owningKanbanTaskConversationSessionId: "task-1",
};
const nativeGoal = {
	...explicitGoal,
	goalText: "修复保存错误",
	source: "acp_structured_plan" as const,
	updatedAt: 120,
};
function summary() {
	return {
		...createDefaultAcpSummary("task-1", "omp"),
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "omp" as const,
			nativeSessionId: "native-1",
			transcriptPath: null,
			observedAt: 1,
		},
		agentCurrentWorkPhaseGoal: explicitGoal,
		agentNativeCurrentWorkPhaseGoal: nativeGoal,
	};
}

describe("阶段目标与稳定 Task 名称的边界", () => {
	it("显式声明优先，清除后回退原生；真实新输入只把旧声明标为历史", () => {
		const seeded = summary();
		expect(resolveAgentCurrentWorkPhaseGoalForDisplay(seeded)?.goalText).toBe(explicitGoal.goalText);
		expect(resolveAgentCurrentWorkPhaseGoalForDisplay({ ...seeded, agentCurrentWorkPhaseGoal: null })?.goalText).toBe(
			nativeGoal.goalText,
		);
		const historical = mergeSummaryWithFacets(seeded, { agentCurrentWorkPhaseGoalInvalidatedAt: 130 });
		expect(resolveAgentCurrentWorkPhaseGoalForDisplay(historical)?.isHistorical).toBe(true);
		expect(
			resolveAgentCurrentWorkPhaseGoalForDisplay({
				...historical,
				agentNativeCurrentWorkPhaseGoal: { ...nativeGoal, updatedAt: 140 },
			})?.goalText,
		).toBe(nativeGoal.goalText);
	});
	it("同一对话跨 compaction、Stop、重启保留；新的原生对话不继承", () => {
		const seeded = summary();
		const stopped = mergeSummaryWithFacets(seeded, {
			turnOwner: "user",
			liveness: "live",
			userTurnKind: "review",
			updatedAt: 200,
		});
		const reloaded = runtimeTaskSessionSummarySchema.parse(JSON.parse(JSON.stringify(stopped)));
		expect(resolveAgentCurrentWorkPhaseGoalForDisplay(reloaded)?.goalText).toBe(explicitGoal.goalText);
		const next = mergeSummaryWithFacets(reloaded, {
			agentNativeConversationSessionIdentity: {
				...seeded.agentNativeConversationSessionIdentity,
				nativeSessionId: "native-2",
			},
		});
		expect(resolveAgentCurrentWorkPhaseGoalForDisplay(next)).toBeNull();
	});
	it("同原生对话的新 incarnation 只显示上次目标；旁支归属与无原生身份均不串会话", () => {
		const seeded = {
			...summary(),
			runtimeSessionIncarnationId: "current-incarnation",
			agentCurrentWorkPhaseGoal: { ...explicitGoal, owningRuntimeSessionIncarnationId: "prior-incarnation" },
			agentNativeCurrentWorkPhaseGoal: null,
		};
		expect(resolveAgentCurrentWorkPhaseGoalForDisplay(seeded)?.isHistorical).toBe(true);
		expect(resolveAgentCurrentWorkPhaseGoalForDisplay({ ...seeded, taskId: "by-the-way" })).toBeNull();
		const withoutNativeId = {
			...seeded,
			agentNativeConversationSessionIdentity: null,
			agentCurrentWorkPhaseGoal: {
				...explicitGoal,
				owningNativeConversationSessionId: null,
				owningRuntimeSessionIncarnationId: "current-incarnation",
			},
		};
		expect(resolveAgentCurrentWorkPhaseGoalForDisplay(withoutNativeId)?.isHistorical).toBe(false);
		expect(
			resolveAgentCurrentWorkPhaseGoalForDisplay({
				...withoutNativeId,
				runtimeSessionIncarnationId: "new-incarnation",
			}),
		).toBeNull();
	});
	it("真实 manager 持久摘要重建保留目标，失效时戳单调且拒绝跨 incarnation 写入", () => {
		const manager = new TerminalSessionManager();
		const seeded = { ...summary(), runtimeSessionIncarnationId: "incarnation-1" };
		manager.hydrateFromRecord({ "task-1": JSON.parse(JSON.stringify(seeded)) });
		expect(manager.getSummary("task-1")?.agentCurrentWorkPhaseGoal).toEqual(explicitGoal);
		manager.invalidateCurrentWorkPhaseGoalAfterDeliveredUserPrompt("task-1", 150);
		manager.invalidateCurrentWorkPhaseGoalAfterDeliveredUserPrompt("task-1", 130);
		expect(manager.getSummary("task-1")?.agentCurrentWorkPhaseGoalInvalidatedAt).toBe(150);
		expect(resolveAgentCurrentWorkPhaseGoalForDisplay(manager.getSummary("task-1"))?.isHistorical).toBe(true);
		expect(
			manager.applyCurrentWorkPhaseGoal("task-1", {
				...explicitGoal,
				owningRuntimeSessionIncarnationId: "old-incarnation",
			}),
		).toBeNull();
		expect(manager.getSummary("task-1")?.agentCurrentWorkPhaseGoal).toEqual(explicitGoal);
	});
	it("阶段目标写入保持 facet 与两种输出时间不变", () => {
		const seeded = {
			...summary(),
			lastConversationProgressObservation: {
				observedAtMs: 30,
				evidenceKind: "structured_agent_session_event" as const,
			},
			agentResponseGenerationStopped: null,
		};
		const next = mergeSummaryWithFacets(seeded, {
			agentCurrentWorkPhaseGoal: { ...explicitGoal, goalText: "新的阶段" },
			updatedAt: 150,
		});
		expect([next.turnOwner, next.liveness, next.userTurnKind]).toEqual([
			seeded.turnOwner,
			seeded.liveness,
			seeded.userTurnKind,
		]);
		expect(next.lastConversationProgressObservation).toEqual(seeded.lastConversationProgressObservation);
		expect(next.agentResponseGenerationStopped).toBeNull();
	});
	it("原生清单仅接受唯一进行中项，优先 activeForm，过长目标不截断猜测", () => {
		expect(
			projectUniqueNativeInProgressWorkPhaseGoal([
				{ status: "in_progress", subject: "修复保存", activeForm: "正在验证保存" },
			]),
		).toBe("正在验证保存");
		expect(projectUniqueNativeInProgressWorkPhaseGoal([{ status: "pending", subject: "未来工作" }])).toBeNull();
		expect(
			projectUniqueNativeInProgressWorkPhaseGoal([
				{ status: "in_progress", content: "甲" },
				{ status: "in_progress", content: "乙" },
			]),
		).toBeNull();
		expect(
			projectUniqueNativeInProgressWorkPhaseGoal([{ status: "in_progress", content: "字".repeat(161) }]),
		).toBeNull();
	});
	it("名称和阶段命令拒绝空白、超长以及任意目标覆盖", () => {
		expect(runtimeRenameCurrentTaskRequestSchema.parse({ title: "  [FIX]修复\n名称  ", reason: "原因" }).title).toBe(
			"[FIX]修复 名称",
		);
		for (const input of [
			{ title: " ", reason: "原因" },
			{ title: "字".repeat(81), reason: "原因" },
			{ title: "名称", reason: " " },
			{ title: "名称", reason: "原因", taskId: "other" },
		])
			expect(runtimeRenameCurrentTaskRequestSchema.safeParse(input).success).toBe(false);
		expect(runtimeSetCurrentWorkPhaseGoalRequestSchema.safeParse({ goal: " " }).success).toBe(false);
		expect(runtimeSetCurrentWorkPhaseGoalRequestSchema.safeParse({ goal: "字".repeat(161) }).success).toBe(false);
	});
	it("Claude 文件精确归属且必须在新输入后更新，共享清单和过期文件不冒充当前阶段", async () => {
		const root = await mkdtemp(join(tmpdir(), "kanban-native-phase-goal-test-"));
		try {
			await mkdir(join(root, "native-1"));
			const file = join(root, "native-1", "1.json");
			await writeFile(file, JSON.stringify({ subject: "修复保存", activeForm: "验证保存", status: "in_progress" }));
			await utimes(file, new Date(1000), new Date(1000));
			const input = {
				nativeConversationSessionId: "native-1",
				reportedTaskListId: "native-1",
				claudeTasksDirectory: root,
			};
			expect(await readClaudeNativeTaskListCurrentWorkPhaseGoal(input)).toEqual({
				goalText: "验证保存",
				updatedAt: 1000,
			});
			expect(
				await readClaudeNativeTaskListCurrentWorkPhaseGoal({ ...input, reportedTaskListId: "shared-list" }),
			).toBeNull();
			expect(
				await readClaudeNativeTaskListCurrentWorkPhaseGoal({ ...input, userPromptDeliveredAt: 1001 }),
			).toBeNull();
			await writeFile(
				join(root, "native-1", "2.json"),
				JSON.stringify({ subject: "另一项", status: "in_progress" }),
			);
			expect(await readClaudeNativeTaskListCurrentWorkPhaseGoal(input)).toBeNull();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
