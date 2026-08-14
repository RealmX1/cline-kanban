// 「agent 发起、正等用户拍板」的决策账本：每个 workspace 一个
// agent-raised-pending-user-decisions.json（与 board.json / notifications.json 同级）。
//
// 存在意义：会话在宽限期到期后会被回收，进程一死，那个「agent 刚问了你一个问题」的 TUI 画面
// 就没了。本账本让问题正文与结构化选项**独立于会话进程存活**，用户下次进入任务时由 UI 主动
// 重现，回答后再幂等送回恢复出来的 agent。落库发生在 agent 提问的**那一刻**（不是等到期才落），
// 故 crash / kill -9 / 断电同样不丢。
//
// 刻意的类型层面约束：decisionKind 只有「普通提问」与「工具授权请求」两种，**没有 plan_review**。
// 计划审批不做 carry-forward（用户拍板），把它排除在枚举之外即从类型上杜绝「计划审批冒充普通
// 提问被重现」——这是本仓 userTurnKind 采集里刻意区分 plan_review / question 的同一条不变量。
//
// 骨架（串行写队列 / 原子写 / 损坏容错 / 上限裁剪 / 路径遍历守卫）对齐 notification-log-store.ts。
//
// 隐私：问题正文与选项**只**写入本文件（与 board/sessions 同目录同权限），绝不进普通诊断日志、
// [user-turn-kind] 日志或 latestHookActivity。tool_permission_request 只存工具名与参数**摘要**，
// 不存参数正文，避免把命令行 / 路径 / 密钥落进盘。
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
	type RuntimeAgentRaisedDecisionQuestion,
	runtimeAgentIdSchema,
	runtimeAgentRaisedDecisionQuestionSchema,
	runtimeAgentSessionTransportSchema,
} from "../core/api-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getWorkspaceDirectoryPath, getWorkspacesRootPath, listWorkspaceIndexEntries } from "./workspace-state";

const AGENT_RAISED_PENDING_USER_DECISION_FILENAME = "agent-raised-pending-user-decisions.json";

// 每 workspace 上限。已回答 / 已放弃的记录留作审计与「答案是否已送达」追踪，超限丢最旧。
const MAX_RECORDS_PER_WORKSPACE = 200;

export const AGENT_RAISED_PENDING_USER_DECISION_SCHEMA_VERSION = 2;

// ⚠️ 有意不包含 plan_review：计划审批不做 durable carry-forward。新增取值前请回读本文件头部注释。
export const agentRaisedPendingUserDecisionKindSchema = z.enum([
	// agent 在问一个需要你回答的普通问题（Claude AskUserQuestion / Cline ask_followup_question / …）。
	"ordinary_user_question",
	// agent 在请求一次工具授权（Claude PermissionRequest / ACP session/request_permission / …）。
	"tool_permission_request",
]);
export type AgentRaisedPendingUserDecisionKind = z.infer<typeof agentRaisedPendingUserDecisionKindSchema>;

export const agentRaisedPendingUserDecisionStatusSchema = z.enum([
	// 等用户拍板（会话是否还活着都不影响本状态）。
	"pending",
	// 用户已给出答案（是否已送达 agent 见 answerDeliveryState）。
	"answered",
	// 用户显式放弃回答（终态）。
	"dismissed",
	// 同一 task 上出现了更新的同类决策，本条作废（终态）。
	"superseded",
]);
export type AgentRaisedPendingUserDecisionStatus = z.infer<typeof agentRaisedPendingUserDecisionStatusSchema>;

export const agentRaisedPendingUserDecisionAnswerDeliveryStateSchema = z.enum([
	"not_answered",
	// 答案已原子落盘、期限已作废，但尚未投递（会话可能还没恢复起来）。
	"answer_recorded",
	"delivery_in_progress",
	"delivered",
	"delivery_failed",
]);
export type AgentRaisedPendingUserDecisionAnswerDeliveryState = z.infer<
	typeof agentRaisedPendingUserDecisionAnswerDeliveryStateSchema
>;

const agentRaisedPendingUserDecisionOptionSchema = z.object({
	optionId: z.string(),
	label: z.string(),
	description: z.string().optional(),
});
export type AgentRaisedPendingUserDecisionOption = z.infer<typeof agentRaisedPendingUserDecisionOptionSchema>;

const agentRaisedPendingUserDecisionAnswerSchema = z.object({
	selectedOptionIds: z.array(z.string()),
	freeformText: z.string().nullable(),
	orderedQuestionAnswers: z
		.array(
			z.object({
				decisionQuestionId: z.string(),
				selectedOptionIds: z.array(z.string()),
				freeformText: z.string().nullable(),
			}),
		)
		.optional(),
	answeredAt: z.number(),
});
export type AgentRaisedPendingUserDecisionAnswer = z.infer<typeof agentRaisedPendingUserDecisionAnswerSchema>;

const persistedAgentRaisedPendingUserDecisionSchema = z.object({
	// 稳定去重键。由采集侧用 harness 提供的稳定标识构造（Claude 的 tool_use_id / ACP 的 decisionId /
	// Cline 的 toolCallId），故同一次提问被重复观测到时不会落成两条。
	decisionId: z.string(),
	taskId: z.string(),
	workspaceId: z.string(),
	agentId: runtimeAgentIdSchema.nullable(),
	sessionTransport: runtimeAgentSessionTransportSchema,
	decisionKind: agentRaisedPendingUserDecisionKindSchema,
	// 问题正文（markdown）。tool_permission_request 时是「agent 请求使用 X 工具」的可读描述。
	questionMarkdown: z.string(),
	options: z.array(agentRaisedPendingUserDecisionOptionSchema),
	allowsFreeformAnswer: z.boolean(),
	orderedQuestions: z.array(runtimeAgentRaisedDecisionQuestionSchema).optional(),
	askedAt: z.number(),
	// 提问当时该会话的回收期限（epoch ms，null = 无期限）。仅用于 UI 说明「这个问题等了多久才被回收」。
	graceDeadlineAt: z.number().nullable(),
	// 会话因到期被回收的时刻；未被回收则为 null（问题仍可直接答给活着的会话）。
	reclaimedAt: z.number().nullable(),
	// 提问时所属活体与回合序号。答案回投时用来判断「是否需要先恢复会话」。
	originRuntimeSessionIncarnationId: z.string().nullable(),
	originTurnSequence: z.number().int().nonnegative(),
	// 采集来源的自解释标签："claude:AskUserQuestion" / "acp:session/request_permission" / …
	// 仅存信号名，不存 payload 正文。
	sourceHarnessSignal: z.string(),
	status: agentRaisedPendingUserDecisionStatusSchema,
	supersededByDecisionId: z.string().nullable(),
	answer: agentRaisedPendingUserDecisionAnswerSchema.nullable(),
	answerDeliveryState: agentRaisedPendingUserDecisionAnswerDeliveryStateSchema,
	// 幂等键：语义与 task-message-injections.json 一致——同一条答案无论重试多少次，只会真正
	// 送进 agent 一次。
	answerDeliveryIdempotencyKey: z.string(),
	lastAnswerDeliveryFailureReason: z.string().nullable(),
	createdAt: z.number(),
	updatedAt: z.number(),
	payloadSchemaVersion: z.number().int().nonnegative(),
});
export type PersistedAgentRaisedPendingUserDecision = z.infer<typeof persistedAgentRaisedPendingUserDecisionSchema>;

const persistedAgentRaisedPendingUserDecisionFileSchema = z.array(persistedAgentRaisedPendingUserDecisionSchema);

export interface RecordAgentRaisedPendingUserDecisionInput {
	decisionId: string;
	taskId: string;
	workspaceId: string;
	agentId: z.infer<typeof runtimeAgentIdSchema> | null;
	sessionTransport: z.infer<typeof runtimeAgentSessionTransportSchema>;
	decisionKind: AgentRaisedPendingUserDecisionKind;
	questionMarkdown: string;
	options: AgentRaisedPendingUserDecisionOption[];
	allowsFreeformAnswer: boolean;
	orderedQuestions?: RuntimeAgentRaisedDecisionQuestion[];
	askedAt: number;
	graceDeadlineAt: number | null;
	originRuntimeSessionIncarnationId: string | null;
	originTurnSequence: number;
	sourceHarnessSignal: string;
}

export function resolveAgentRaisedPendingUserDecisionOrderedQuestions(
	record: Pick<
		PersistedAgentRaisedPendingUserDecision,
		"allowsFreeformAnswer" | "options" | "orderedQuestions" | "questionMarkdown"
	>,
): RuntimeAgentRaisedDecisionQuestion[] {
	if (record.orderedQuestions && record.orderedQuestions.length > 0) {
		return record.orderedQuestions;
	}
	return [
		{
			decisionQuestionId: "question-0",
			headerMarkdown: null,
			questionMarkdown: record.questionMarkdown,
			selectionMode: "single",
			options: record.options,
			allowsFreeformAnswer: record.allowsFreeformAnswer,
		},
	];
}

export function buildAgentRaisedPendingUserDecisionAnswerDeliveryIdempotencyKey(decisionId: string): string {
	return `agent-raised-pending-user-decision-answer:${decisionId}`;
}

// 「仍需 UI 呈现或仍需投递」的记录：等人拍板的，以及已答但尚未确认送达的。
// 接受 null / undefined（各写入函数在记录不存在 / 迁移非法时返回 null），故调用方无需非空断言。
export function isOpenAgentRaisedPendingUserDecision(
	record: PersistedAgentRaisedPendingUserDecision | null | undefined,
): boolean {
	if (record == null) {
		return false;
	}
	if (record.status === "pending") {
		return true;
	}
	return record.status === "answered" && record.answerDeliveryState !== "delivered";
}

function getAgentRaisedPendingUserDecisionPath(workspaceId: string): string {
	// 防路径遍历：与 notification-log-store 同一守卫（workspace 目录必须是 workspaces 根的直接子目录）。
	// 本 store 的回答入口经 tRPC 从客户端 input 拿 workspaceId，故这条守卫是必需的、不是形式主义。
	const workspaceDirectory = resolve(getWorkspaceDirectoryPath(workspaceId));
	const workspacesRoot = resolve(getWorkspacesRootPath());
	if (dirname(workspaceDirectory) !== workspacesRoot) {
		throw new Error(
			`Refusing agent raised pending user decision access outside workspaces root for workspaceId: ${workspaceId}`,
		);
	}
	return join(workspaceDirectory, AGENT_RAISED_PENDING_USER_DECISION_FILENAME);
}

async function readRawDecisions(workspaceId: string): Promise<PersistedAgentRaisedPendingUserDecision[]> {
	const path = getAgentRaisedPendingUserDecisionPath(workspaceId);
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT") {
			return [];
		}
		throw error;
	}
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(raw) as unknown;
	} catch {
		// 损坏容错：不让一份坏文件炸掉整个快照构建。代价是那些待答问题不再被重现（与「重复投递
		// 一个已答问题」相比，这是更安全的失败方向）。
		return [];
	}
	const parsed = persistedAgentRaisedPendingUserDecisionFileSchema.safeParse(parsedJson);
	return parsed.success ? parsed.data : [];
}

async function writeDecisions(workspaceId: string, records: PersistedAgentRaisedPendingUserDecision[]): Promise<void> {
	await lockedFileSystem.writeJsonFileAtomic(getAgentRaisedPendingUserDecisionPath(workspaceId), records, {
		lock: null,
	});
}

const writeQueueByWorkspaceId = new Map<string, Promise<unknown>>();

function enqueueWrite<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
	const previous = writeQueueByWorkspaceId.get(workspaceId) ?? Promise.resolve();
	const next = previous.then(operation, operation);
	writeQueueByWorkspaceId.set(
		workspaceId,
		next.catch(() => undefined),
	);
	return next;
}

function capDecisions(records: PersistedAgentRaisedPendingUserDecision[]): PersistedAgentRaisedPendingUserDecision[] {
	if (records.length <= MAX_RECORDS_PER_WORKSPACE) {
		return records;
	}
	return records.slice(records.length - MAX_RECORDS_PER_WORKSPACE);
}

export async function readAgentRaisedPendingUserDecisions(
	workspaceId: string,
): Promise<PersistedAgentRaisedPendingUserDecision[]> {
	return await readRawDecisions(workspaceId);
}

export async function readAllAgentRaisedPendingUserDecisions(): Promise<
	Record<string, PersistedAgentRaisedPendingUserDecision[]>
> {
	const indexEntries = await listWorkspaceIndexEntries();
	const result: Record<string, PersistedAgentRaisedPendingUserDecision[]> = {};
	await Promise.all(
		indexEntries.map(async (entry) => {
			const records = await readRawDecisions(entry.workspaceId);
			if (records.length > 0) {
				result[entry.workspaceId] = records;
			}
		}),
	);
	return result;
}

// agent 提问的那一刻落库。同 decisionId 重复调用幂等（harness 重发同一 hook 不会落成两条）。
// 同 task 上出现新的待答决策时，把该 task 既有的 pending 记录置 superseded 并互相链接——UI 只
// 呈现最新那条，但审计轨迹保留。
export async function recordAgentRaisedPendingUserDecision(
	workspaceId: string,
	input: RecordAgentRaisedPendingUserDecisionInput,
): Promise<PersistedAgentRaisedPendingUserDecision> {
	return await enqueueWrite(workspaceId, async () => {
		const records = await readRawDecisions(workspaceId);
		const existing = records.find((record) => record.decisionId === input.decisionId);
		if (existing !== undefined) {
			return existing;
		}
		const nextRecord: PersistedAgentRaisedPendingUserDecision = {
			decisionId: input.decisionId,
			taskId: input.taskId,
			workspaceId: input.workspaceId,
			agentId: input.agentId,
			sessionTransport: input.sessionTransport,
			decisionKind: input.decisionKind,
			questionMarkdown: input.questionMarkdown,
			options: input.options,
			allowsFreeformAnswer: input.allowsFreeformAnswer,
			orderedQuestions: input.orderedQuestions ?? [
				{
					decisionQuestionId: "question-0",
					headerMarkdown: null,
					questionMarkdown: input.questionMarkdown,
					selectionMode: "single",
					options: input.options,
					allowsFreeformAnswer: input.allowsFreeformAnswer,
				},
			],
			askedAt: input.askedAt,
			graceDeadlineAt: input.graceDeadlineAt,
			reclaimedAt: null,
			originRuntimeSessionIncarnationId: input.originRuntimeSessionIncarnationId,
			originTurnSequence: input.originTurnSequence,
			sourceHarnessSignal: input.sourceHarnessSignal,
			status: "pending",
			supersededByDecisionId: null,
			answer: null,
			answerDeliveryState: "not_answered",
			answerDeliveryIdempotencyKey: buildAgentRaisedPendingUserDecisionAnswerDeliveryIdempotencyKey(
				input.decisionId,
			),
			lastAnswerDeliveryFailureReason: null,
			createdAt: input.askedAt,
			updatedAt: input.askedAt,
			payloadSchemaVersion: AGENT_RAISED_PENDING_USER_DECISION_SCHEMA_VERSION,
		};
		const withSuperseded = records.map((record) =>
			record.taskId === input.taskId && record.status === "pending"
				? {
						...record,
						status: "superseded" as const,
						supersededByDecisionId: input.decisionId,
						updatedAt: input.askedAt,
					}
				: record,
		);
		await writeDecisions(workspaceId, capDecisions([...withSuperseded, nextRecord]));
		return nextRecord;
	});
}

// 会话因到期被回收：把该 task 所有 pending 记录标上 reclaimedAt（状态仍是 pending——问题还等着人答，
// 只是提问它的那个进程没了）。
export async function markAgentRaisedPendingUserDecisionsReclaimed(
	workspaceId: string,
	taskId: string,
	reclaimedAt: number,
): Promise<number> {
	return await enqueueWrite(workspaceId, async () => {
		const records = await readRawDecisions(workspaceId);
		let markedCount = 0;
		const nextRecords = records.map((record) => {
			if (record.taskId === taskId && record.status === "pending" && record.reclaimedAt === null) {
				markedCount += 1;
				return { ...record, reclaimedAt, updatedAt: reclaimedAt };
			}
			return record;
		});
		if (markedCount === 0) {
			return 0;
		}
		await writeDecisions(workspaceId, nextRecords);
		return markedCount;
	});
}

// 用户给出答案：原子写 answer + answerDeliveryState="answer_recorded"。
// 调用方**必须**在此之后才去恢复会话与投递（见计划 §7.4 的严格顺序：先作废计时、再动进程）。
// 已回答过的记录再次调用返回 null，绝不覆盖既有答案（幂等守门的第一道）。
export async function recordAgentRaisedPendingUserDecisionAnswer(
	workspaceId: string,
	decisionId: string,
	answer: AgentRaisedPendingUserDecisionAnswer,
): Promise<PersistedAgentRaisedPendingUserDecision | null> {
	return await enqueueWrite(workspaceId, async () => {
		const records = await readRawDecisions(workspaceId);
		const existing = records.find((record) => record.decisionId === decisionId);
		if (existing === undefined || existing.status !== "pending") {
			return null;
		}
		const answered: PersistedAgentRaisedPendingUserDecision = {
			...existing,
			status: "answered",
			answer,
			answerDeliveryState: "answer_recorded",
			updatedAt: answer.answeredAt,
		};
		await writeDecisions(
			workspaceId,
			records.map((record) => (record.decisionId === decisionId ? answered : record)),
		);
		return answered;
	});
}

// 推进答案投递状态机。合法迁移在此单点强制，故「已 delivered 又被要求投递」在存储层就被拒绝，
// 而不是指望每个调用方自己记得检查。
const ANSWER_DELIVERY_STATE_TRANSITIONS: Record<
	AgentRaisedPendingUserDecisionAnswerDeliveryState,
	readonly AgentRaisedPendingUserDecisionAnswerDeliveryState[]
> = {
	not_answered: ["answer_recorded"],
	answer_recorded: ["delivery_in_progress"],
	delivery_in_progress: ["delivered", "delivery_failed"],
	delivery_failed: ["delivery_in_progress"],
	delivered: [],
};

export function isLegalAgentRaisedPendingUserDecisionAnswerDeliveryTransition(
	from: AgentRaisedPendingUserDecisionAnswerDeliveryState,
	to: AgentRaisedPendingUserDecisionAnswerDeliveryState,
): boolean {
	return ANSWER_DELIVERY_STATE_TRANSITIONS[from].includes(to);
}

export async function updateAgentRaisedPendingUserDecisionAnswerDeliveryState(
	workspaceId: string,
	decisionId: string,
	input: {
		answerDeliveryState: AgentRaisedPendingUserDecisionAnswerDeliveryState;
		updatedAt: number;
		lastAnswerDeliveryFailureReason?: string | null;
	},
): Promise<PersistedAgentRaisedPendingUserDecision | null> {
	return await enqueueWrite(workspaceId, async () => {
		const records = await readRawDecisions(workspaceId);
		const existing = records.find((record) => record.decisionId === decisionId);
		if (existing === undefined) {
			return null;
		}
		if (
			!isLegalAgentRaisedPendingUserDecisionAnswerDeliveryTransition(
				existing.answerDeliveryState,
				input.answerDeliveryState,
			)
		) {
			return null;
		}
		const updated: PersistedAgentRaisedPendingUserDecision = {
			...existing,
			answerDeliveryState: input.answerDeliveryState,
			lastAnswerDeliveryFailureReason:
				input.lastAnswerDeliveryFailureReason !== undefined
					? input.lastAnswerDeliveryFailureReason
					: existing.lastAnswerDeliveryFailureReason,
			updatedAt: input.updatedAt,
		};
		await writeDecisions(
			workspaceId,
			records.map((record) => (record.decisionId === decisionId ? updated : record)),
		);
		return updated;
	});
}

export async function dismissAgentRaisedPendingUserDecision(
	workspaceId: string,
	decisionId: string,
	dismissedAt: number,
): Promise<PersistedAgentRaisedPendingUserDecision | null> {
	return await enqueueWrite(workspaceId, async () => {
		const records = await readRawDecisions(workspaceId);
		const existing = records.find((record) => record.decisionId === decisionId);
		if (existing === undefined || existing.status !== "pending") {
			return null;
		}
		const dismissed: PersistedAgentRaisedPendingUserDecision = {
			...existing,
			status: "dismissed",
			updatedAt: dismissedAt,
		};
		await writeDecisions(
			workspaceId,
			records.map((record) => (record.decisionId === decisionId ? dismissed : record)),
		);
		return dismissed;
	});
}

export async function clearAgentRaisedPendingUserDecisions(workspaceId: string): Promise<void> {
	await enqueueWrite(workspaceId, async () => {
		await writeDecisions(workspaceId, []);
	});
}
