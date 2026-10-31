import type { ChildProcess } from "node:child_process";

export function selectCurrentCursorGrokHighModelFromNativeCatalog(catalog: string): string;
export function cursorContextHasCompleteSecondControl(context: {
	operations?: { key: string; status?: string; measurement?: { request?: unknown; problems: string[] } }[];
} | null | undefined): boolean;
export function cursorContextShouldSkipOnResume(context: {
	status?: string;
	operations?: { key: string; status?: string; measurement?: { request?: unknown; problems: string[] } }[];
} | null | undefined): boolean;
export function armDetachedProcessGroupTimeout(
	child: ChildProcess,
	options: {
		timeoutMs: number;
		termGraceMs: number;
		killGraceMs: number;
		onTimeout?: () => void;
		onSignal?: (signal: "SIGTERM" | "SIGKILL") => void;
	},
): Promise<void>;
export function decodeCursorNativeSqliteMetadata(encoded: unknown): {
	agentId: string;
	latestRootBlobId: string;
	lastUsedModel?: string;
	mode?: string;
};
export function analyzeCursorNativeTurn(
	stdout: string,
	sessionId: string,
	marker: string,
): {
	accepted: boolean;
	problems: string[];
	request?: {
		inputTokens: number;
		cachedInputTokens: number;
		outputTokens: number;
		cacheCreationTokens: number;
		model?: string;
		configurationFingerprint?: string;
	};
	nativeRequestId?: string;
	nativeModelDisplay?: string;
};
export interface CursorNativeStoreSummary {
	sessionId: string;
	latestRootBlobId: unknown;
	model: unknown;
	mode: unknown;
	blobs: { id: string; sha256: string; bytes: number }[];
}
export function verifyCursorNativeForkStorageInheritance(
	parent: CursorNativeStoreSummary,
	child: CursorNativeStoreSummary,
): boolean;
