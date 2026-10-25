import { z } from "zod";
import type { TaskIndexingMaterial, TaskIndexingSupportExecutorSettings } from "../core/task-indexing-support-contract";
import { deriveProjectDisplayNameFromRepoPath } from "../projects/project-display-name";
import { listWorkspaceIndexEntries } from "../state/workspace-state";
import { taskIndexingTextFingerprint } from "./shared-task-indexing-context";
import { executeStatelessTaskIndexingAgent } from "./stateless-task-indexing-agent-executor";
import { TASK_ANALYSIS_SHARED_CONTEXT_VERSION } from "./task-analysis-shared-prompt-prefix";
import { loadAndAdvanceSharedTaskIndexingContext } from "./task-indexing-support-storage";

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
	settings: TaskIndexingSupportExecutorSettings;
	materials: TaskIndexingMaterial[];
	abortSignal?: AbortSignal;
}) {
	const projects = (await listWorkspaceIndexEntries()).map((entry) => ({
		workspaceId: entry.workspaceId,
		name: deriveProjectDisplayNameFromRepoPath(entry.repoPath),
		repositoryPath: entry.repoPath,
	}));
	if (!projects.some((project) => project.workspaceId === input.workspaceId))
		throw new Error("任务所属项目已失效，请重新选择。");
	const context = await loadAndAdvanceSharedTaskIndexingContext({
		workspaceId: input.workspaceId,
		settings: input.settings,
		materials: input.materials,
		instructionVersion: TASK_ANALYSIS_SHARED_CONTEXT_VERSION,
		now: Date.now(),
		forModelRequest: true,
	});
	const result = await executeStatelessTaskIndexingAgent({
		settings: input.settings,
		modelUsagePurpose: "task_project_assignment_analysis",
		context,
		abortSignal: input.abortSignal,
		instructionText:
			"判断本次任务是否适合当前项目。只有其他已注册项目明显更合适时才提出变更；信息不足、通用工作或当前项目合适时 suggestedWorkspaceId 返回 null。不得创建或修改项目、卡片或关系。说明依据。",
		queryText: JSON.stringify({
			currentWorkspaceId: input.workspaceId,
			projects,
			task: { title: input.title, prompt: input.prompt },
		}),
		outputSchema: projectAssignmentModelOutputSchema,
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
