export function buildCodexForkModeParameters(mode: string, parentThreadId: string): Record<string, unknown>;
export function recoverAppServerAcceptedTurnId(frames: unknown[], threadId: string, marker: string): string | null;
export function summarizeAppServerTurnMeasurement(
	frames: unknown[],
	threadId: string,
	turnId: string,
	marker: string,
): {
	completed: boolean;
	accepted: boolean;
	problems: string[];
	requests: { inputTokens: number; cachedInputTokens: number; outputTokens: number }[];
};
export function verifyAppServerForkInheritance(
	thread: { id?: string; forkedFromId?: string },
	parentThreadId: string,
	items: unknown[],
	parentPrompts: string[],
): boolean;
export function verifyAppServerHistoryNonceRecall(
	frames: unknown[],
	threadId: string,
	turnId: string,
	parentPrompts: string[],
): boolean;
export function persistedCodexThreadLoadMatchesFrozenConfiguration(
	reply: {
		thread?: { id?: string; forkedFromId?: string };
		model?: string;
		reasoningEffort?: string;
		approvalPolicy?: string;
		sandbox?: string | { type?: string };
	},
	expected: {
		threadId: string;
		forkedFromId?: string;
		model: string;
		reasoningEffort?: string;
		approvalPolicy: string;
		sandbox: string;
	},
): string[];
export function selectBoundRepairOperation<Operation extends { key: string; threadId?: string }>(
	operations: Operation[],
	fork: { key: string; thread?: { id?: string } },
): Operation | undefined;
export function codexRepairContextIsComplete(
	context: {
		operations: { key: string; status?: string; measurement?: { requests: unknown[]; problems: string[] } }[];
	},
	forkCount: number,
	modes: string[],
): boolean;
export function codexRepairLiveRunIsComplete(
	state: {
		options: { contexts: number[]; modes: string[]; forkCount: number };
		contexts: {
			targetTokens: number;
			operations: { key: string; status?: string; measurement?: { requests: unknown[]; problems: string[] } }[];
		}[];
	},
	rows: { status: string }[],
): boolean;
