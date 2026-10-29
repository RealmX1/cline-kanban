// 输出层只检测故障；退避、投递、取消与重启对账由共用协调器持有。
import { normalizeTerminalText } from "../terminal-output-normalization";
import { classifyConnectionError } from "./connection-error-patterns";
import type { OutputReaction } from "./output-reaction";

export const CONNECTION_DROP_AUTO_CONTINUE_REACTION_ID = "connection-drop-auto-continue";
interface ConnectionFailureDetectionState {
	splitCarryover: string;
}
export function createConnectionDropAutoContinueReaction(): OutputReaction {
	const reset = (_context: unknown, state: unknown) => {
		(state as ConnectionFailureDetectionState).splitCarryover = "";
	};
	return {
		id: CONNECTION_DROP_AUTO_CONTINUE_REACTION_ID,
		appliesTo: (agentId) => agentId === "claude" || agentId === "codex",
		createState: () => ({ splitCarryover: "" }),
		onOutput(context, rawState, actions) {
			const state = rawState as ConnectionFailureDetectionState;
			const boundary = normalizeTerminalText(state.splitCarryover).length;
			const bridged = state.splitCarryover + context.chunkText;
			state.splitCarryover = bridged.slice(-256);
			const { classification } = classifyConnectionError(normalizeTerminalText(bridged), boundary);
			if (classification === "permanent") {
				actions.onAutomaticFailureDetected?.("permanent");
				state.splitCarryover = "";
			} else if (classification === "transient") {
				if (actions.isAgentTurnActive()) actions.onAutomaticFailureDetected?.("connection");
				else state.splitCarryover = "";
			}
		},
		onAttempt() {},
		triggerNow() {},
		dismiss: reset,
		standDown: reset,
	};
}
