import type { RvfIndependentUserTurnBoundaryReceipt } from "../core/rvf-automatic-closeout-contract";
import { type CodexAppServerRequestPort, readCodexConversationTurns } from "./codex-native-conversation-prefix";

// 此函数的 port 必须连到持有 TUI 活跃会话的宿主；独立 app-server 只能读取磁盘历史，不能调用这里。
export async function observeRvfReviewStartActiveBranch(input: {
	port: CodexAppServerRequestPort;
	receipt: RvfIndependentUserTurnBoundaryReceipt;
	requestNonce: string;
}) {
	const turns = await readCodexConversationTurns(input.port, input.receipt.session_id);
	const userTurns = turns.filter((turn) => turn.items.some((item) => item.type === "userMessage"));
	return {
		request_nonce: input.requestNonce,
		kanban_task_id: input.receipt.kanban_task_id,
		idempotency_key: input.receipt.idempotency_key,
		session_id: input.receipt.session_id,
		native_active_branch_user_message_ids: userTurns.flatMap((turn) =>
			turn.items.filter((item) => item.type === "userMessage").map((item) => item.id),
		),
		native_active_branch_user_turn_id: userTurns.at(-1)?.id ?? "",
	};
}
