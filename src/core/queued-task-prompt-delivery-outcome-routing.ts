// 排队 prompt 一次投递的回执 → 队列条目该去哪儿。**纯函数、零 IO**。
//
// 路由表是这套特性里最不能凭感觉改的一张表，因为它的两个方向后果不对称：
//   - 把「可能已经送到了」判成可重试 ⇒ 同一段话发两遍，且 agent 会把第二遍当成用户又说了一次；
//   - 把「确定没送到」判成终态失败 ⇒ 只是多让用户点一次「重新排队」。
// 所以凡是语义暧昧的，一律落终态、交给人决定。
//
// 失败原因的语义以 src/core/task-message-injection-ledger.ts 为唯一真相（那是跨仓契约的镜像），
// 这里只做「对排队场景意味着什么」的映射。

import type {
	InjectionLedgerTerminalDeliveryReceipt,
	TerminalDeliveryFailureReason,
	TerminalDeliveryStatus,
} from "./api-contract";

export interface QueuedTaskPromptDeliverySettlement {
	// 同 key 的零写入等待可跨 runtime 接管；旧尝试不得结算新托管者的队列条目。
	expectedHandedToTransportAttemptOwnership?: {
		dispatchIdempotencyKey: string;
		custodianRuntimeProcessInstanceId: string | null | undefined;
		claimedForSessionIncarnationId: string | null;
	};
	// delivered = 落终态；retryable_failure = 回队首等下一次机会；terminal_failure = 落 settled_failed 并保留可见；
	// cancelled = 用户在它已经交给 transport 之后取消、且 transport 确认拦下了（cancelled_before_delivery）。
	// 最后这一档必须与失败分开：那是用户自己要的结果，显示成「发送失败 · 重新排队？」是在反问他。
	//
	// 程序化条目（programmaticInjectionLedgerReceiptLink 非空）的 retryable_failure 由 store 当 terminal_failure 落：
	// 交给终端投递之后一次定终身，绝不回头再等 agent（见 api-contract.ts 该字段的注释）。
	outcome: "delivered" | "retryable_failure" | "terminal_failure" | "cancelled";
	failureNote: string | null;
	// 本次投递真实的终端回执，原样镜像进程序化条目的注入账本记录。人排的条目忽略它。
	// 缺省时（出队引擎之外的落定路径）由落定后的状态推出，见 queued-programmatic-injection-ledger-receipt-mirroring.ts。
	terminalDeliveryReceiptForInjectionLedger?: InjectionLedgerTerminalDeliveryReceipt;
}

// 「确定一个字节都没进 agent」的那几种：回队首、等下一轮再试（重试预算由 store 计）。
//
// 注意「可重试」在队列里的意思是**等下一轮**，不是立刻重投：dispatcher 对每一轮至多交出一次
// （见 queued-task-prompt-delivery-dispatcher.ts 的「一轮至多交出一次」），所以人正在框里打字
// （human_terminal_contention_timeout）这种情况，条目会安静地等人把自己那句发出去、agent 跑完那一轮。
const RETRYABLE_QUEUED_PROMPT_TERMINAL_DELIVERY_FAILURE_NOTES: Partial<Record<TerminalDeliveryFailureReason, string>> =
	{
		no_active_terminal_session: "The agent session was not running when the queued prompt was due.",
		terminal_prompt_readiness_timeout: "The agent's input prompt never became ready to accept the queued prompt.",
		human_terminal_contention_timeout:
			"Someone was typing in the task terminal, so the queued prompt stepped aside instead of interrupting.",
		// 账本注释原话：「可以择机换新 idempotency key 重投」——人不在场、只是机器这侧拿不下框。
		terminal_input_box_contended_but_unstashable:
			"The terminal input box held unsent text that could not be set aside, so the queued prompt was not pasted.",
		agent_awaiting_user_decision_timeout:
			"The agent was waiting for your answer, so the queued prompt stepped aside instead of answering for you.",
		// 与 RVF 投递的单飞槽对撞。门控 6 挡住了大部分，剩下的 TOCTOU 窗口落在这里——绝不静默丢。
		superseded_by_later_delivery: "Another automated delivery took over the input box first.",
		session_ended_before_delivery: "The agent session ended before the queued prompt was delivered.",
	};

// 「可能已经送到了」的那几种：落 settled_failed、保留可见，重排由人决定。
const TERMINAL_QUEUED_PROMPT_TERMINAL_DELIVERY_FAILURE_NOTES: Partial<Record<TerminalDeliveryFailureReason, string>> = {
	codex_native_prompt_delivery_unconfirmed:
		"Codex 原生投递尚未得到用户消息接受证明，可能已经送达；检查会话后再决定是否重新排队。",
	// 契约明说文本可能还躺在输入框里；自动重投 = 把同一段话送两次。
	submit_confirmation_budget_exhausted:
		"The prompt was pasted but its submission was never confirmed. It may still be sitting in the input box — check before requeueing.",
	runtime_restarted_before_confirmation:
		"Kanban restarted before the delivery was confirmed, so the prompt may or may not have been sent.",
	// 独立回合门禁也会在粘贴后的提交前复检失败；保留终态，不能自动重投或退回普通投递。
	native_independent_user_turn_capability_unavailable:
		"无法核实所需原生会话的独立回合控制能力，投递已停止。重新排队前请先检查任务终端。",
	native_independent_user_turn_session_replaced:
		"所需原生会话、代次或回合已改变，投递已停止。重新排队前请先检查任务终端。",
};

const DELIVERED_TERMINAL_DELIVERY_STATUSES: ReadonlySet<TerminalDeliveryStatus> = new Set([
	"delivered_and_submit_confirmed",
	"delivered_queued_behind_active_agent_turn",
]);

// 一份**终态**回执的路由。accepted_pending_submit_confirmation 不是终态，调用方必须等它落定再来问。
export function routeQueuedTaskPromptDeliveryTerminalOutcome(receipt: {
	status: TerminalDeliveryStatus;
	reason: TerminalDeliveryFailureReason | null;
	failureNote?: string;
}): QueuedTaskPromptDeliverySettlement {
	if (DELIVERED_TERMINAL_DELIVERY_STATUSES.has(receipt.status)) {
		return { outcome: "delivered", failureNote: null };
	}
	if (receipt.status === "accepted_pending_submit_confirmation") {
		// 走到这里是调用方的错。按「语义暧昧 ⇒ 交给人」处理，绝不假设它已送达或确定没送达。
		return {
			outcome: "terminal_failure",
			failureNote: "The delivery was accepted but never reported a final outcome.",
		};
	}
	const reason = receipt.reason;
	if (reason === "cancelled_before_delivery") {
		return { outcome: "cancelled", failureNote: null };
	}
	if (reason !== null) {
		const retryableNote = RETRYABLE_QUEUED_PROMPT_TERMINAL_DELIVERY_FAILURE_NOTES[reason];
		if (retryableNote !== undefined) {
			return { outcome: "retryable_failure", failureNote: receipt.failureNote ?? retryableNote };
		}
		const terminalNote = TERMINAL_QUEUED_PROMPT_TERMINAL_DELIVERY_FAILURE_NOTES[reason];
		if (terminalNote !== undefined) {
			return { outcome: "terminal_failure", failureNote: receipt.failureNote ?? terminalNote };
		}
	}
	// delivery_failed 却不带原因、或将来契约新增了一个这里还不认识的原因：不知道有没有送到 ⇒ 交给人。
	return {
		outcome: "terminal_failure",
		failureNote:
			receipt.failureNote ??
			`The delivery failed${reason === null ? "" : ` (${reason})`} and it is unclear whether the prompt reached the agent.`,
	};
}

// 发送出口在**写出任何字节之前**就返回 ok:false、且没有带终端回执（例：Cline SDK 会话没起、校验失败、
// 出口内部抛错被兜住）。这些都发生在 transport 真正受理之前，可以安全地等下一轮再试。
export function routeQueuedTaskPromptDeliveryRejectedBeforeTransportAccepted(
	errorMessage: string | undefined,
): QueuedTaskPromptDeliverySettlement {
	return {
		outcome: "retryable_failure",
		failureNote: `The agent session did not accept the queued prompt${errorMessage ? `: ${errorMessage}` : "."}`,
	};
}
