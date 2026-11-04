import { createHash } from "node:crypto";
import { z } from "zod";

export const fingerprint = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");
export const taskIdSchema = z
	.string()
	.regex(/^[a-z0-9_-]+$/u)
	.refine((id) => id !== "d55ee", "d55ee 不在实验范围");
export const experimentWorkloadTaskIdSchema = taskIdSchema.refine((id) => id !== "dd679", "dd679 不在实验工作负载范围");
export const objectIdSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const absolutePathSchema = z.string().startsWith("/");
const positiveInteger = z.number().int().positive();

export const experimentInputSchema = z
	.object({
		schemaVersion: z.literal(1),
		workspaceId: z.string().min(1),
		requestArrivedAt: positiveInteger,
		projectPath: absolutePathSchema,
		baseRef: z.string().min(1),
		boardPath: absolutePathSchema,
		sessionsPath: absolutePathSchema,
		workflowEvidencePaths: z.array(absolutePathSchema),
		tasks: z
			.array(
				z.object({
					taskId: experimentWorkloadTaskIdSchema,
					taskIncarnationCreatedAt: positiveInteger,
					worktreePath: absolutePathSchema,
					implementationActivityAt: positiveInteger,
					originalCohortEvidencePath: absolutePathSchema.optional(),
					dependsOn: z.array(experimentWorkloadTaskIdSchema),
					review: z.object({
						candidateCommit: objectIdSchema,
						candidateTree: objectIdSchema,
						completedAt: positiveInteger,
						evidencePaths: z.array(absolutePathSchema).min(1),
					}),
				}),
			)
			.min(1),
	})
	.superRefine((input, context) => {
		if (new Set(input.tasks.map((task) => task.taskId)).size !== input.tasks.length)
			context.addIssue({ code: "custom", message: "候选任务 ID 重复" });
		for (const task of input.tasks) {
			if (
				(task.implementationActivityAt > input.requestArrivedAt ||
					task.implementationActivityAt < input.requestArrivedAt - 24 * 60 * 60 * 1000) &&
				!(task.originalCohortEvidencePath && task.taskIncarnationCreatedAt <= input.requestArrivedAt)
			)
				context.addIssue({ code: "custom", message: `${task.taskId} 不在原始需求的 24 小时时间窗内` });
		}
	});
export type ExperimentInput = z.infer<typeof experimentInputSchema>;
export type CandidateInput = ExperimentInput["tasks"][number];

export interface OrderingCandidate {
	taskId: string;
	readyAt: number;
	codeChangedLines: number;
	dependsOn: string[];
}

export function validateTaskOrder(tasks: OrderingCandidate[], order: string[]): string[] {
	const ids = tasks.map((task) => task.taskId);
	if (new Set(ids).size !== ids.length || ids.some((id) => !experimentWorkloadTaskIdSchema.safeParse(id).success))
		throw new Error("候选身份重复或超出范围");
	if (order.length !== ids.length || new Set(order).size !== ids.length || order.some((id) => !ids.includes(id)))
		throw new Error("排列必须恰好覆盖所有候选一次");
	for (const task of tasks) {
		for (const dependency of task.dependsOn)
			if (!ids.includes(dependency) || order.indexOf(dependency) >= order.indexOf(task.taskId))
				throw new Error(`依赖未满足：${dependency} → ${task.taskId}`);
	}
	return order;
}

export function deriveTaskOrder(tasks: OrderingCandidate[], strategy: "fifo" | "smallest-change-first"): string[] {
	const remaining = [...tasks];
	const order: string[] = [];
	while (remaining.length) {
		const available = remaining.filter((task) => task.dependsOn.every((id) => order.includes(id)));
		if (!available.length) throw new Error("存在依赖环、缺失依赖或不可拆交付；未丢弃任何任务");
		available.sort(
			(left, right) =>
				(strategy === "smallest-change-first" ? left.codeChangedLines - right.codeChangedLines : 0) ||
				left.readyAt - right.readyAt ||
				left.taskId.localeCompare(right.taskId, "en"),
		);
		order.push(available[0].taskId);
		remaining.splice(remaining.indexOf(available[0]), 1);
	}
	return validateTaskOrder(tasks, order);
}

export const frozenNativeHistorySchema = z.object({
	parentSessionId: z.string().uuid(),
	lastCompletedTurnId: z.string().min(1),
	turnIds: z.array(z.string()).min(1),
	model: z.string().min(1),
	effort: z.string().min(1),
	sha256: z.string().length(64),
	byteLength: positiveInteger,
});

/** 只接受完整的原生完成边界；被截断的尾行和在途回合不会悄悄丢弃。 */
export function inspectCompletedNativeHistory(text: string, expectedSessionId: string) {
	const rows = text
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	const metadata = rows.find((row) => row.type === "session_meta")?.payload;
	if (metadata?.id !== expectedSessionId) throw new Error("原生转录身份不匹配");
	const started = rows.filter((row) => row.type === "event_msg" && row.payload?.type === "task_started");
	const completed = rows.filter((row) => row.type === "event_msg" && row.payload?.type === "task_complete");
	const context = [...rows].reverse().find((row) => row.type === "turn_context")?.payload;
	const last = completed.at(-1)?.payload?.turn_id;
	if (!last || context?.turn_id !== last || started.at(-1)?.payload?.turn_id !== last)
		throw new Error("最后一个原生回合尚未完整结束");
	return frozenNativeHistorySchema.parse({
		parentSessionId: expectedSessionId,
		lastCompletedTurnId: last,
		turnIds: started.map((row) => row.payload.turn_id),
		model: context.model,
		effort: context.effort,
		sha256: fingerprint(text),
		byteLength: Buffer.byteLength(text),
	});
}

export const usageFrameSchema = z.object({
	method: z.literal("thread/tokenUsage/updated"),
	params: z.object({
		threadId: z.string(),
		turnId: z.string(),
		tokenUsage: z.object({
			total: z
				.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() })
				.passthrough(),
			last: z.object({
				inputTokens: z.number().int().nonnegative(),
				cachedInputTokens: z.number().int().nonnegative(),
				outputTokens: z.number().int().nonnegative(),
				reasoningOutputTokens: z.number().int().nonnegative().optional(),
			}),
		}),
	}),
});

/** 累计水位核对逐请求连续性；历史水位只作起点，不计入本回合消费。 */
export function summarizeNewTurnUsage(
	frames: unknown[],
	threadId: string,
	turnId: string,
	cumulativeUsageBeforeTurn?: { inputTokens: number; outputTokens: number },
) {
	const requests = new Map<string, z.infer<typeof usageFrameSchema>["params"]["tokenUsage"]>();
	const problems: string[] = [];
	let previousTotal = cumulativeUsageBeforeTurn;
	for (const frame of frames) {
		const header = z
			.object({
				method: z.string().optional(),
				params: z.object({ threadId: z.string(), turnId: z.string() }).passthrough().optional(),
			})
			.passthrough()
			.safeParse(frame);
		if (
			!header.success ||
			header.data.method !== "thread/tokenUsage/updated" ||
			header.data.params?.threadId !== threadId
		)
			continue;
		const parsed = usageFrameSchema.safeParse(frame);
		if (header.data.params.turnId !== turnId) {
			if (!cumulativeUsageBeforeTurn && !requests.size && parsed.success)
				previousTotal = parsed.data.params.tokenUsage.total;
			continue;
		}
		if (!parsed.success) {
			problems.push("用量通知缺失有效字段");
			continue;
		}
		const { total, last } = parsed.data.params.tokenUsage;
		if (last.cachedInputTokens > last.inputTokens || (last.reasoningOutputTokens ?? 0) > last.outputTokens) {
			problems.push("缓存或推理用量超出所属总量");
			continue;
		}
		const identity = JSON.stringify([total.inputTokens, total.outputTokens]);
		if (requests.has(identity) && JSON.stringify(requests.get(identity)?.last) !== JSON.stringify(last))
			problems.push("相同累计水位存在不一致用量");
		requests.set(identity, { total, last });
	}
	if (!requests.size) problems.push("缺少绑定新回合的计量；不能记为零");
	const orderedRequests = [...requests.values()].sort(
		(left, right) =>
			left.total.inputTokens + left.total.outputTokens - right.total.inputTokens - right.total.outputTokens,
	);
	if (!previousTotal) problems.push("缺少新回合执行前累计水位或可核对的私有前缀，不能假定从零开始");
	for (const { total, last } of orderedRequests) {
		if (
			previousTotal &&
			(previousTotal.inputTokens + last.inputTokens !== total.inputTokens ||
				previousTotal.outputTokens + last.outputTokens !== total.outputTokens)
		)
			problems.push("累计水位与逐请求用量不连续，需补读绑定原件");
		previousTotal = total;
	}
	const totals = orderedRequests
		.map(({ last }) => last)
		.reduce(
			(sum, usage) => ({
				inputTokens: sum.inputTokens + usage.inputTokens,
				cachedInputTokens: sum.cachedInputTokens + usage.cachedInputTokens,
				outputTokens: sum.outputTokens + usage.outputTokens,
			}),
			{ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
		);
	return {
		status: problems.length ? "unknown" : "measured",
		requests: orderedRequests.map(({ last }) => last),
		totals: problems.length
			? null
			: { ...totals, uncachedInputTokens: totals.inputTokens - totals.cachedInputTokens },
		problems,
	};
}

export const pilotProtocolSchema = z.object({
	schemaVersion: z.literal(1),
	maximumRepairRoundsPerTask: z.literal(2),
	commandTimeoutMs: positiveInteger,
	turnTimeoutMs: positiveInteger,
	maximumModelTurns: positiveInteger.nullable().default(null),
	maximumReportedTokens: positiveInteger.nullable().default(null),
	validationCommands: z.array(z.array(z.string()).min(1)).min(1),
	model: z.string().min(1),
	effort: z.string().min(1),
});

export type RecoveryAction =
	| "already-completed"
	| "inspect-private-evidence-before-retry"
	| "execute-prepared-operation";
export function decideOperationRecovery(status: string): RecoveryAction {
	if (status === "completed") return "already-completed";
	if (status === "prepared") return "execute-prepared-operation";
	return "inspect-private-evidence-before-retry";
}
