export interface NativeRequestMeasurement {
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	model: string;
	configurationFingerprint: string;
	sourceLine?: number;
	systemPromptHash?: string;
}
export function prepareIsolatedNativeAgentMeasurementConfiguration(agent: "codex" | "kimi", directory: string): {
	model: string; reasoning: unknown; configurationSha256: string;
};
export function createSyntheticForkCacheMeasurementPrompt(marker: string, contextTokens: number): string;
export function writeNativeAgentMeasurementManifestAtomically(path: string, value: unknown): void;
export function analyzeNativeTurn(
	agent: "codex" | "kimi",
	transcript: string,
	requestMarker: string,
): {
	requests: NativeRequestMeasurement[];
	problems: string[];
	accepted: boolean;
	completed: boolean;
};
export function assessHistoryReuse(input: {
	baseline: NativeRequestMeasurement;
	hotBefore: NativeRequestMeasurement;
	hotAfter: NativeRequestMeasurement;
	fork: NativeRequestMeasurement;
	integrityProblems?: string[];
}): { status: string; historyReuseRatio: number | null; problems: string[] };
export function resolveOperationRecovery(input: {
	status: string;
	completed?: boolean;
	accepted?: boolean;
	spawnErrorCode?: string;
	preSubmissionRejectionCode?: string;
	attemptCount?: number;
}): string;
export function buildIsolatedEnvironment(
	source: Record<string, string | undefined>,
	paths: { home: string; codexHome: string; kimiHome: string },
): Record<string, string>;
export function classifyKimiPreSubmissionRejection(stderr: string, nativeTranscripts: string[]): string | null;
export function readCodexNativePromptConfigurationEvidence(
	transcript: string,
	inheritedParentTranscript?: string,
): {
	baseInstructionsSha256: string | null;
	additionalToolsSha256: string | null;
};
export function readKimiSessionIdentityFromNativeState(
	state: {
		id?: string;
		agents?: { main?: { homedir?: string } };
	},
	expectedAgentHomeDirectory: string,
): string | undefined;
export function isAllowedNativeCodexExecutableLink(
	relativePath: string,
	resolvedTarget: string,
	pinnedBinary: string | null,
): boolean;
export function verifyForkHistoryInheritance(input: {
	agent: "codex" | "kimi";
	childTranscript: string;
	childSessionId?: string;
	childSessionState?: { id?: string; forkedFrom?: string };
	parentTranscript: string;
	parentSessionId: string;
	frozenParentSha256: string;
	parentPrompts: string[];
}): { verified: boolean; mode?: string; reason?: string };
export function nativeLiveMeasurementMatrixIsComplete(manifest: {
	options: { agents: string[]; contextTokens: number[] };
	operations: {
		key: string;
		sessionId?: string;
		status?: string;
		native?: { accepted?: boolean; completed?: boolean; requests?: unknown[]; problems?: string[] };
	}[];
}): boolean;
