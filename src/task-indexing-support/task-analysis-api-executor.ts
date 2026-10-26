import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { RuntimeTaskImage } from "../core/api-contract";
import type { TaskAssistanceModelProviderAttempt } from "../core/task-assistance-model-provider-routing-contract";
import type { SharedTaskIndexingContext, TaskAnalysisContextSettings } from "../core/task-indexing-support-contract";
import type { ModelUsagePurpose } from "../model-provider-access/model-provider-usage-record";
import { requestTaskAssistanceJsonObject } from "../model-provider-access/task-assistance-model-provider-routing";
import { taskIndexingTextFingerprint } from "./shared-task-indexing-context";
import { StatelessTaskIndexingAgentExecutionError } from "./stateless-task-indexing-agent-execution-diagnostics";
import { TASK_ANALYSIS_SHARED_INSTRUCTIONS } from "./task-analysis-shared-prompt-prefix";

export interface TaskAnalysisApiExecutionActivity {
	eventKind: "api_request_started" | "agent_response_received" | "agent_execution_completed" | "diagnostic_warning";
	occurredAtEpochMs: number;
	message: string;
	inputByteCount?: number;
	modelExecutionTimeoutMs?: number;
}
export interface TaskAnalysisApiRequest<T> {
	/** 只为读取旧快照保留；执行模型由 API 路由与 provider 档案决定。 */
	settings?: TaskAnalysisContextSettings;
	instructionText: string;
	context?: SharedTaskIndexingContext;
	stableContextText?: string;
	queryText: string;
	outputSchema: z.ZodType<T>;
	validateOutput?: (value: T) => void;
	operationId?: string;
	stage?: string;
	timeoutMs?: number;
	abortSignal?: AbortSignal;
	modelUsagePurpose?: ModelUsagePurpose;
	questionImages?: RuntimeTaskImage[];
	onExecutionActivity?: (activity: TaskAnalysisApiExecutionActivity) => void;
}
export interface TaskAnalysisApiUsage {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	resolvedModelId: string | null;
	requestedModelId?: string | null;
	modelProviderId?: string;
}
export interface TaskAnalysisApiResult<T> {
	value: T;
	usage: TaskAnalysisApiUsage;
	stablePromptPrefixSha256: string;
	elapsedMs: number;
	diagnosticWarnings?: string[];
	attempts?: TaskAssistanceModelProviderAttempt[];
}
export function assembleTaskAnalysisApiPrompt(
	request: Pick<TaskAnalysisApiRequest<unknown>, "instructionText" | "context" | "stableContextText" | "queryText">,
) {
	const context = request.context;
	return {
		stablePrefix: `${TASK_ANALYSIS_SHARED_INSTRUCTIONS}\n\n${request.stableContextText ?? (context ? `L1 看板任务目录（仅供查找候选）：\n${context.levelOneBoardTaskIndexText}\n\nL2 本项目任务 recap（不是完成证明）：\n${context.levelTwoProjectTaskRecapsText}` : "")}`,
		query: `${context ? `L3 快照后追加变化（覆盖旧快照对应字段）：\n${context.levelThreeAppendedChangesText}\n\n` : ""}本次分析指令：\n${request.instructionText}\n\nL4 本次查询：\n${request.queryText}`,
	};
}
export async function executeTaskAnalysisApi<T>(request: TaskAnalysisApiRequest<T>): Promise<TaskAnalysisApiResult<T>> {
	const startedAt = Date.now();
	const prompt = assembleTaskAnalysisApiPrompt(request);
	const prefixHash = taskIndexingTextFingerprint(prompt.stablePrefix);
	const inputByteCount = Buffer.byteLength(prompt.stablePrefix + prompt.query);
	if (inputByteCount > 1_200_000)
		throw new StatelessTaskIndexingAgentExecutionError(
			"input_budget_exceeded",
			"任务 Context 超出输入预算，未静默丢弃材料。",
		);
	const purpose = request.modelUsagePurpose ?? "task_indexing_support_relation_analysis";
	const timeout = request.timeoutMs ?? (purpose === "task_project_assignment_analysis" ? 15_000 : 60_000);
	const emit = (eventKind: TaskAnalysisApiExecutionActivity["eventKind"], message: string) =>
		request.onExecutionActivity?.({
			eventKind,
			message,
			occurredAtEpochMs: Date.now(),
			inputByteCount,
			modelExecutionTimeoutMs: timeout,
		});
	emit("api_request_started", "正在通过 API 执行单轮分析");
	const result = await requestTaskAssistanceJsonObject(
		{
			modelUsagePurpose: purpose,
			operationId: request.operationId ?? randomUUID(),
			stage: request.stage ?? "relation_analysis",
			systemPrompt: prompt.stablePrefix,
			userPrompt: prompt.query,
			stablePromptPrefixSha256: prefixHash,
			requestTimeoutMs: timeout,
			abortSignal: request.abortSignal,
			questionImages: request.questionImages,
		},
		request.outputSchema,
		{
			validateParsedJsonObject: request.validateOutput,
			onAttempt: (attempt) =>
				emit(
					attempt.outcome === "completed" ? "agent_response_received" : "diagnostic_warning",
					`${attempt.modelProviderId} / ${attempt.requestedModelId ?? "未配置"}：${attempt.outcome === "completed" ? "结构化结果已通过校验" : (attempt.failureReason ?? "请求失败")}`,
				),
		},
	);
	if (result.status !== "completed") {
		const error = new StatelessTaskIndexingAgentExecutionError(
			result.unavailableReason,
			result.unavailableDetail ?? "任务辅助模型均不可用，请检查 API provider 配置。",
		);
		error.providerAttempts = result.attempts;
		throw error;
	}
	const successful = result.attempts.find((attempt) => attempt.outcome === "completed");
	emit("agent_execution_completed", "API 已返回完整结构化结果");
	return {
		value: result.parsedJsonObject,
		stablePromptPrefixSha256: prefixHash,
		elapsedMs: Date.now() - startedAt,
		attempts: result.attempts,
		usage: {
			inputTokens: successful?.inputTokens,
			outputTokens: successful?.outputTokens,
			cacheReadTokens: successful?.cacheReadTokens,
			cacheWriteTokens: successful?.cacheWriteTokens,
			resolvedModelId: successful?.resolvedModelId ?? null,
			requestedModelId: successful?.requestedModelId,
			modelProviderId: successful?.modelProviderId,
		},
	};
}
