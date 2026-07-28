// 「agent 要用户拍板」的双向通道。ACP 里有两类：session/request_permission（工具授权）与
// form 型 elicitation（omp 的 plan 审批走它）。两者都是**请求-响应**：agent 会一直挂着等回复，
// 所以每一个 pending 决策必须最终被 resolve —— 取消路径也必须回，否则 agent 侧永远卡住。
//
// 决策以聊天消息的形式呈现（meta.userDecision），前端点按钮后经 tRPC 回传 decisionId + 选择。
import type {
	RuntimeTaskAgentUserDecision,
	RuntimeTaskAgentUserDecisionOption,
	RuntimeTaskAgentUserDecisionOutcome,
} from "../core/api-contract";
import type {
	AcpCreateElicitationRequest,
	AcpCreateElicitationResponse,
	AcpRequestPermissionRequest,
	AcpRequestPermissionResponse,
} from "./acp-protocol-boundary";
import type { AcpUserDecisionBroker } from "./acp-task-session-service";

export interface AcpPendingUserDecisionPresentation {
	taskId: string;
	decision: RuntimeTaskAgentUserDecision;
	// 展示给用户的 markdown 正文（工具标题 / elicitation 的 message）。
	promptMarkdown: string;
}

export interface AcpPendingUserDecisionBrokerHandlers {
	// 决策产生时把它呈现出去（落成聊天消息并广播）。
	presentDecision(presentation: AcpPendingUserDecisionPresentation): void;
	// 决策落定后回写同一条消息，使按钮变成「已选 X」。
	settleDecision(taskId: string, decisionId: string, resolution: AcpUserDecisionResolution): void;
}

export interface AcpUserDecisionResolution {
	outcome: RuntimeTaskAgentUserDecisionOutcome;
	optionId: string | null;
}

interface PendingDecisionRecord {
	taskId: string;
	kind: RuntimeTaskAgentUserDecision["kind"];
	resolve(resolution: AcpUserDecisionResolution): void;
}

export class AcpPendingUserDecisionBroker implements AcpUserDecisionBroker {
	private readonly pendingByDecisionId = new Map<string, PendingDecisionRecord>();
	private nextDecisionSequence = 0;

	constructor(private readonly handlers: AcpPendingUserDecisionBrokerHandlers) {}

	async requestToolPermission(
		taskId: string,
		request: AcpRequestPermissionRequest,
	): Promise<AcpRequestPermissionResponse> {
		const options: RuntimeTaskAgentUserDecisionOption[] = request.options.map((option) => ({
			optionId: option.optionId,
			label: option.name,
			kind: option.kind,
		}));
		const resolution = await this.awaitUserResolution({
			taskId,
			kind: "tool_permission",
			options,
			promptMarkdown: buildToolPermissionPromptMarkdown(request),
		});
		if (resolution.outcome === "selected" && resolution.optionId) {
			return { outcome: { outcome: "selected", optionId: resolution.optionId } };
		}
		return { outcome: { outcome: "cancelled" } };
	}

	async requestElicitation(
		taskId: string,
		request: AcpCreateElicitationRequest,
	): Promise<AcpCreateElicitationResponse> {
		// v1 只支持 form 型 elicitation 中「从若干候选里选一个」这一形态——omp 的 plan 审批正是它。
		// 其它形态（自由文本表单、URL 型）暂时以 decline 回绝，而不是假装接受。
		const options = extractElicitationSelectOptions(request);
		if (options.length === 0) {
			return { action: "decline" };
		}
		const resolution = await this.awaitUserResolution({
			taskId,
			kind: "elicitation_form",
			options,
			promptMarkdown: request.message,
		});
		if (resolution.outcome === "selected" && resolution.optionId) {
			return buildElicitationAcceptResponse(resolution.optionId);
		}
		return { action: resolution.outcome === "declined" ? "decline" : "cancel" };
	}

	// 用户点了按钮。返回 false 表示这个 decisionId 已经不在等待中（重复点击 / 已被取消）。
	resolvePendingDecision(taskId: string, decisionId: string, resolution: AcpUserDecisionResolution): boolean {
		const pending = this.pendingByDecisionId.get(decisionId);
		if (!pending || pending.taskId !== taskId) {
			return false;
		}
		this.pendingByDecisionId.delete(decisionId);
		this.handlers.settleDecision(taskId, decisionId, resolution);
		pending.resolve(resolution);
		return true;
	}

	// ACP 规范硬性要求：发出 session/cancel 后必须把所有 pending 的授权请求以 cancelled 回掉，
	// 否则 agent 侧会一直挂着。连接断开时同理——不回的话 promise 永远悬着。
	cancelPendingDecisions(taskId: string): void {
		for (const [decisionId, pending] of [...this.pendingByDecisionId.entries()]) {
			if (pending.taskId !== taskId) {
				continue;
			}
			this.pendingByDecisionId.delete(decisionId);
			const resolution: AcpUserDecisionResolution = { outcome: "cancelled", optionId: null };
			this.handlers.settleDecision(taskId, decisionId, resolution);
			pending.resolve(resolution);
		}
	}

	private awaitUserResolution(input: {
		taskId: string;
		kind: RuntimeTaskAgentUserDecision["kind"];
		options: RuntimeTaskAgentUserDecisionOption[];
		promptMarkdown: string;
	}): Promise<AcpUserDecisionResolution> {
		this.nextDecisionSequence += 1;
		const decisionId = `${input.taskId}-decision-${this.nextDecisionSequence}`;
		return new Promise<AcpUserDecisionResolution>((resolve) => {
			this.pendingByDecisionId.set(decisionId, { taskId: input.taskId, kind: input.kind, resolve });
			this.handlers.presentDecision({
				taskId: input.taskId,
				promptMarkdown: input.promptMarkdown,
				decision: {
					decisionId,
					kind: input.kind,
					options: input.options,
					resolvedOutcome: null,
					resolvedOptionId: null,
				},
			});
		});
	}
}

function buildToolPermissionPromptMarkdown(request: AcpRequestPermissionRequest): string {
	const title = request.toolCall.title ?? request.toolCall.toolCallId;
	return `**Permission requested**\n\n${title}`;
}

// form 型 elicitation 的「单选」形态：requestedSchema 里某个属性带 enum / oneOf 候选。
function extractElicitationSelectOptions(request: AcpCreateElicitationRequest): RuntimeTaskAgentUserDecisionOption[] {
	if (request.mode !== "form") {
		return [];
	}
	const properties = readRecord(readRecord(request as Record<string, unknown>, "requestedSchema"), "properties");
	if (!properties) {
		return [];
	}
	for (const [propertyName, rawProperty] of Object.entries(properties)) {
		const property = asRecord(rawProperty);
		if (!property) {
			continue;
		}
		const enumValues = property.enum;
		if (Array.isArray(enumValues) && enumValues.length > 0) {
			const enumNames = Array.isArray(property.enumNames) ? property.enumNames : null;
			return enumValues.map((value, index) => ({
				optionId: `${propertyName}:${String(value)}`,
				label: String(enumNames?.[index] ?? value),
				kind: "elicitation_choice",
			}));
		}
	}
	return [];
}

// optionId 形如 `<schema 属性名>:<取值>`（见 extractElicitationSelectOptions），据此还原成
// elicitation 期望的 content 对象。
function buildElicitationAcceptResponse(optionId: string): AcpCreateElicitationResponse {
	const separatorIndex = optionId.indexOf(":");
	const propertyName = separatorIndex === -1 ? optionId : optionId.slice(0, separatorIndex);
	const value = separatorIndex === -1 ? optionId : optionId.slice(separatorIndex + 1);
	return { action: "accept", content: { [propertyName]: value } } as AcpCreateElicitationResponse;
}

function readRecord(source: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
	if (!source) {
		return null;
	}
	return asRecord(source[key]);
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}
