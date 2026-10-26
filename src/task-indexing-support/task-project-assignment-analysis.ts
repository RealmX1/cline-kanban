import { z } from "zod";
import type { TaskAnalysisContextSettings, TaskIndexingMaterial } from "../core/task-indexing-support-contract";
import { taskIndexingTextFingerprint } from "./shared-task-indexing-context";
import { executeTaskAnalysisApi } from "./task-analysis-api-executor";
import { collectProjectAssignmentLightweightContext } from "./task-project-assignment-lightweight-context";

const projectAssignmentModelOutputSchema = z.object({
	suggestedWorkspaceId: z.string().nullable(),
	rationale: z.string().min(1).max(4000),
	confidence: z.enum(["high", "medium", "low"]),
});

export async function analyzeTaskProjectAssignment(input: {
	workspaceId: string;
	operationId: string;
	title: string;
	prompt: string;
	settings: TaskAnalysisContextSettings;
	/** 兼容旧调用；项目归属不再消费这些重型材料。 */
	materials?: TaskIndexingMaterial[];
	abortSignal?: AbortSignal;
}) {
	const { projects, contextCompleteness } = await collectProjectAssignmentLightweightContext(
		`${input.title}\n${input.prompt}`,
	);
	if (!projects.some((project) => project.workspaceId === input.workspaceId))
		throw new Error("任务所属项目已失效，请重新选择。");
	const result = await executeTaskAnalysisApi({
		settings: input.settings,
		modelUsagePurpose: "task_project_assignment_analysis",
		operationId: input.operationId,
		stage: "project_assignment",
		stableContextText: `已注册项目完整目录及标题示例（仅辅助判断）：\n${JSON.stringify(projects)}\n材料限制：${JSON.stringify(contextCompleteness)}`,
		abortSignal: input.abortSignal,
		instructionText:
			"判断本次任务是否适合当前项目。只有其他已注册项目明显更合适时才提出变更；信息不足、通用工作或当前项目合适时 suggestedWorkspaceId 返回 null。不得创建或修改项目、卡片或关系。说明依据。",
		queryText: JSON.stringify({
			currentWorkspaceId: input.workspaceId,
			task: { title: input.title, prompt: input.prompt },
		}),
		outputSchema: projectAssignmentModelOutputSchema,
		validateOutput: (value) => {
			if (
				value.suggestedWorkspaceId &&
				!projects.some((project) => project.workspaceId === value.suggestedWorkspaceId)
			)
				throw new Error("AI 返回了未注册项目，未采用建议。");
		},
	});
	const suggested = result.value.suggestedWorkspaceId;
	const project = suggested ? projects.find((entry) => entry.workspaceId === suggested) : null;
	if (suggested && !project) throw new Error("AI 返回了未注册项目，未采用建议。");
	return {
		operationId: input.operationId,
		inputFingerprint: taskIndexingTextFingerprint(JSON.stringify([input.workspaceId, input.title, input.prompt])),
		currentWorkspaceId: input.workspaceId,
		suggestedWorkspaceId: suggested === input.workspaceId ? null : suggested,
		suggestedProjectName: suggested === input.workspaceId ? null : (project?.name ?? null),
		rationale: result.value.rationale,
		confidence: result.value.confidence,
		stablePromptPrefixSha256: result.stablePromptPrefixSha256,
	};
}
