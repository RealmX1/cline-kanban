import { describe, expect, it } from "vitest";
import {
	buildExpandedForegroundViewUrl,
	parseExpandedForegroundViewTarget,
	removeExpandedForegroundViewFromUrl,
} from "@/expanded-foreground-view/expanded-foreground-view-navigation";

describe("前台视图 URL 与来源隔离", () => {
	const target = {
		viewKind: "task_relations" as const,
		workspaceId: "other-project",
		taskId: "same-id",
		taskIncarnationCreatedAtEpochMs: 123,
	};
	it("完整身份往返，保留来源项目、任务、其他参数和片段", () => {
		const url = buildExpandedForegroundViewUrl("/source?task=source-task&filter=running#position", target);
		expect(parseExpandedForegroundViewTarget(url)).toEqual({ target, error: null });
		expect(removeExpandedForegroundViewFromUrl(url)).toBe("/source?task=source-task&filter=running#position");
	});
	it("可视化链接固定阅读中的产物版本", () => {
		const visualization = {
			...target,
			viewKind: "task_visualization" as const,
			visualizationArtifactId: "artifact-id",
			revisionId: "revision-id",
		};
		expect(
			parseExpandedForegroundViewTarget(buildExpandedForegroundViewUrl("/source", visualization)).target,
		).toEqual(visualization);
	});
	it("拒绝缺失、无效或歧义身份，不退回裸 ID 查询", () => {
		for (const suffix of [
			"",
			"&expandedTaskIncarnationCreatedAtEpochMs=NaN",
			"&expandedTaskIncarnationCreatedAtEpochMs=-1",
		]) {
			const result = parseExpandedForegroundViewTarget(
				`/source?expandedView=task_relations&expandedWorkspaceId=p&expandedTaskId=t${suffix}`,
			);
			expect(result.target).toBeNull();
			expect(result.error).toBeTruthy();
		}
	});
	it("没有前台参数时保持普通应用导航", () => {
		expect(parseExpandedForegroundViewTarget("/source?task=a")).toEqual({ target: null, error: null });
	});
});
