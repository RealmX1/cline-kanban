import { describe, expect, it } from "vitest";
import { runtimeTaskSessionSummarySchema } from "../../../src/core/api-contract";
import {
	preserveRuntimeOnlySessionFieldsFromSameGeneration,
	projectTaskSessionSummaryForBrowser,
} from "../../../src/core/browser-task-session-summary-projection";
import { buildConditionalWorkspaceChangesResponse } from "../../../src/server/conditional-workspace-changes";

describe("条件 diff 与浏览器会话投影", () => {
	it("时间戳变化不重发正文，内容变化产生新版本", () => {
		const changes = {
			repoRoot: "/isolated",
			generatedAt: 1,
			files: [
				{
					path: "code.ts",
					status: "modified" as const,
					additions: 1,
					deletions: 0,
					oldText: "原文",
					newText: "完整新文",
				},
			],
		};
		const initial = buildConditionalWorkspaceChangesResponse(changes);
		expect(initial.status).toBe("changed");
		const unchanged = buildConditionalWorkspaceChangesResponse(
			{ ...changes, generatedAt: 2 },
			initial.contentVersion,
		);
		expect(unchanged).toEqual({ status: "unchanged", contentVersion: initial.contentVersion });
		expect(JSON.stringify(unchanged)).not.toContain("完整新文");
		expect(buildConditionalWorkspaceChangesResponse({ ...changes, files: [] }, initial.contentVersion).status).toBe(
			"changed",
		);
	});
	it("只剥离运行时字段，同代回存保留原件，新代不复活旧端点", () => {
		const summary = runtimeTaskSessionSummarySchema.parse({
			taskId: "task",
			state: "running",
			agentId: "codex",
			workspacePath: "/isolated",
			pid: 1,
			startedAt: 1,
			updatedAt: 1,
			lastOutputAt: 1,
			reviewReason: null,
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: { finalMessage: "完整活动文本" },
			runtimeSessionIncarnationId: "old-generation",
		});
		const persisted = {
			...summary,
			agentSessionForkReplayLaunchArguments: {
				sourceAgentId: "codex",
				modelArgumentLiteral: "model",
				appendSystemPromptText: "完整启动参数",
				settingsFilePath: null,
				capturedAt: 1,
			},
		};
		const projected = projectTaskSessionSummaryForBrowser(persisted);
		expect(projected).not.toHaveProperty("agentSessionForkReplayLaunchArguments");
		expect(JSON.stringify(projected)).toContain("完整活动文本");
		expect(
			preserveRuntimeOnlySessionFieldsFromSameGeneration(persisted, projected).agentSessionForkReplayLaunchArguments,
		).toEqual(persisted.agentSessionForkReplayLaunchArguments);
		expect(
			preserveRuntimeOnlySessionFieldsFromSameGeneration(persisted, {
				...projected,
				runtimeSessionIncarnationId: "new-generation",
			}).agentSessionForkReplayLaunchArguments,
		).toBeUndefined();
	});
	it("旧记录只在任务、项目、启动时间均相同且两侧都没有原生代际时保留内部字段", () => {
		const persisted = runtimeTaskSessionSummarySchema.parse({
			taskId: "task",
			state: "interrupted",
			agentId: "codex",
			workspacePath: "/isolated",
			pid: null,
			startedAt: 1,
			updatedAt: 1,
			lastOutputAt: null,
			reviewReason: null,
			exitCode: null,
			lastHookAt: null,
			agentSessionForkReplayLaunchArguments: {
				sourceAgentId: "codex",
				modelArgumentLiteral: "model",
				appendSystemPromptText: "保留原件",
				settingsFilePath: null,
				capturedAt: 1,
			},
		});
		const projected = projectTaskSessionSummaryForBrowser(persisted);
		expect(
			preserveRuntimeOnlySessionFieldsFromSameGeneration(persisted, projected).agentSessionForkReplayLaunchArguments,
		).toEqual(persisted.agentSessionForkReplayLaunchArguments);
		for (const incoming of [
			{ ...projected, taskId: "other" },
			{ ...projected, workspacePath: "/other" },
			{ ...projected, runtimeSessionIncarnationId: "new-generation" },
		])
			expect(
				preserveRuntimeOnlySessionFieldsFromSameGeneration(persisted, incoming)
					.agentSessionForkReplayLaunchArguments,
			).toBeUndefined();
	});
});
