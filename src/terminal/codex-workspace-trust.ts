import type { RuntimeAgentId } from "../core/api-contract";
import { normalizeTerminalText, stripAnsiAndControl } from "./terminal-output-normalization";

const CODEX_WORKSPACE_TRUST_TOKENS = ["do", "you", "trust", "the", "contents", "of", "this", "directory"];

export function hasCodexWorkspaceTrustPrompt(text: string): boolean {
	const rawNormalized = normalizeTerminalText(text);
	if (hasOrderedTokens(rawNormalized, CODEX_WORKSPACE_TRUST_TOKENS)) {
		return true;
	}
	const strippedNormalized = normalizeTerminalText(stripAnsiAndControl(text));
	return hasOrderedTokens(strippedNormalized, CODEX_WORKSPACE_TRUST_TOKENS);
}

function hasOrderedTokens(input: string, tokens: readonly string[]): boolean {
	let index = 0;
	for (const token of tokens) {
		const found = input.indexOf(token, index);
		if (found === -1) {
			return false;
		}
		index = found + token.length;
	}
	return true;
}

export function shouldAutoConfirmCodexWorkspaceTrust(agentId: RuntimeAgentId, cwd: string): boolean {
	void cwd;
	return agentId === "codex";
}
