import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";

import type {
	RuntimeAvailableAgentSessionPreviewTurn,
	RuntimeAvailableAgentSessionsRequest,
	RuntimeAvailableAgentSessionsResponse,
	RuntimeResumableAgentSessionSourceAgentId,
} from "../core/api-contract";
import { runGit } from "../workspace/git-utils";
import {
	encodedAgentProjectPath,
	parseTranscriptJsonRecord,
	readBoundedJsonLines,
	readTranscriptRecord,
} from "./bounded-agent-transcript-reader";

interface SessionFileCandidate {
	agentId: RuntimeResumableAgentSessionSourceAgentId;
	filePath: string;
	modifiedAt: string;
	mtimeMs: number;
	size: number;
}

interface IndexedAvailableAgentSession {
	sourceAgentId: RuntimeResumableAgentSessionSourceAgentId;
	sourceSessionId: string;
	sessionTitle: string;
	sessionWorkingDirectoryPath: string | null;
	gitBranchName: string | null;
	modelId: string | null;
	lastUpdatedAt: string;
	previewConversationTurns: RuntimeAvailableAgentSessionPreviewTurn[];
	sourceFilePath: string;
}

interface CachedParsedSession {
	signature: string;
	session: IndexedAvailableAgentSession | null;
}

interface ParsedSessionResult {
	session: IndexedAvailableAgentSession | null;
	transcriptWasTruncated: boolean;
}

const SESSION_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_PREVIEW_TEXT_LENGTH = 800;
const SESSION_PARSE_CONCURRENCY = 8;
const MAX_TRANSCRIPT_BYTES_PER_FILE = 1024 * 1024;
const MAX_TRANSCRIPT_BYTES_PER_SCAN = 64 * 1024 * 1024;
const SESSION_SCAN_DEADLINE_MILLISECONDS = 3_000;
const PARSED_SESSION_CACHE_MAXIMUM_ENTRIES = 2_000;
const parsedSessionCache = new Map<string, CachedParsedSession>();
const gitCommonDirectoryCache = new Map<string, Promise<string | null>>();

interface AvailableAgentSessionIndexLimits {
	maximumTranscriptBytesPerFile: number;
	maximumTranscriptBytesPerScan: number;
	sessionScanDeadlineMilliseconds: number;
	parsedSessionCacheMaximumEntries: number;
}

const defaultAvailableAgentSessionIndexLimits: AvailableAgentSessionIndexLimits = {
	maximumTranscriptBytesPerFile: MAX_TRANSCRIPT_BYTES_PER_FILE,
	maximumTranscriptBytesPerScan: MAX_TRANSCRIPT_BYTES_PER_SCAN,
	sessionScanDeadlineMilliseconds: SESSION_SCAN_DEADLINE_MILLISECONDS,
	parsedSessionCacheMaximumEntries: PARSED_SESSION_CACHE_MAXIMUM_ENTRIES,
};

let availableAgentSessionIndexLimits = defaultAvailableAgentSessionIndexLimits;

export function configureAvailableAgentSessionIndexLimitsForTests(
	overrides: Partial<AvailableAgentSessionIndexLimits> | null,
): void {
	availableAgentSessionIndexLimits = overrides
		? { ...defaultAvailableAgentSessionIndexLimits, ...overrides }
		: defaultAvailableAgentSessionIndexLimits;
}

export function resetAvailableAgentSessionIndexStateForTests(): void {
	parsedSessionCache.clear();
	gitCommonDirectoryCache.clear();
	availableAgentSessionIndexLimits = defaultAvailableAgentSessionIndexLimits;
}

export function getAvailableAgentSessionIndexCacheSizeForTests(): number {
	return parsedSessionCache.size;
}

function readString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function collectText(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(collectText).filter(Boolean).join("\n");
	}
	const record = readTranscriptRecord(value);
	if (!record) {
		return "";
	}
	return collectText(record.text ?? record.content ?? record.message);
}

function normalizePreviewText(value: unknown): string {
	return collectText(value).replace(/\s+/gu, " ").trim().slice(0, MAX_PREVIEW_TEXT_LENGTH);
}

function addPreviewTurn(
	turns: RuntimeAvailableAgentSessionPreviewTurn[],
	role: RuntimeAvailableAgentSessionPreviewTurn["role"],
	value: unknown,
	timestamp: unknown,
): void {
	const text = normalizePreviewText(value);
	if (!text) {
		return;
	}
	turns.push({ role, text, timestamp: readString(timestamp) });
	if (turns.length > 3) {
		turns.splice(0, turns.length - 3);
	}
}

function getCachedParsedSession(cacheKey: string, signature: string): IndexedAvailableAgentSession | null | undefined {
	const cached = parsedSessionCache.get(cacheKey);
	if (cached?.signature !== signature) return undefined;
	parsedSessionCache.delete(cacheKey);
	parsedSessionCache.set(cacheKey, cached);
	return cached.session;
}

function cacheParsedSession(cacheKey: string, value: CachedParsedSession): void {
	parsedSessionCache.delete(cacheKey);
	parsedSessionCache.set(cacheKey, value);
	while (parsedSessionCache.size > availableAgentSessionIndexLimits.parsedSessionCacheMaximumEntries) {
		const leastRecentlyUsedCacheKey = parsedSessionCache.keys().next().value;
		if (typeof leastRecentlyUsedCacheKey !== "string") break;
		parsedSessionCache.delete(leastRecentlyUsedCacheKey);
	}
}

async function collectSessionFiles(
	rootDirectoryPath: string,
	agentId: RuntimeResumableAgentSessionSourceAgentId,
	includeFile: (filePath: string) => boolean,
): Promise<SessionFileCandidate[]> {
	const candidates: SessionFileCandidate[] = [];
	const pendingDirectories = [rootDirectoryPath];
	while (pendingDirectories.length > 0) {
		const directoryPath = pendingDirectories.pop();
		if (!directoryPath) {
			continue;
		}
		let entries: Dirent[];
		try {
			entries = await readdir(directoryPath, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const entryPath = join(directoryPath, entry.name);
			if (entry.isDirectory()) {
				if (agentId !== "claude" || entry.name !== "subagents") {
					pendingDirectories.push(entryPath);
				}
				continue;
			}
			if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".jsonl" || !includeFile(entryPath)) {
				continue;
			}
			try {
				const metadata = await stat(entryPath);
				candidates.push({
					agentId,
					filePath: entryPath,
					modifiedAt: metadata.mtime.toISOString(),
					mtimeMs: metadata.mtimeMs,
					size: metadata.size,
				});
			} catch {
				// A transcript can disappear while the agent rotates history. Ignore that race.
			}
		}
	}
	return candidates;
}

async function discoverSessionFiles(
	agentId: RuntimeResumableAgentSessionSourceAgentId,
): Promise<SessionFileCandidate[]> {
	if (agentId === "claude") {
		return collectSessionFiles(join(homedir(), ".claude", "projects"), agentId, () => true);
	}
	if (agentId === "codex") {
		const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
		return collectSessionFiles(join(codexHome, "sessions"), agentId, () => true);
	}
	return collectSessionFiles(join(homedir(), ".cursor", "projects"), agentId, (filePath) =>
		filePath.split(/[\\/]/u).includes("agent-transcripts"),
	);
}

async function parseAvailableAgentSession(
	candidate: SessionFileCandidate,
	maximumBytesToRead: number,
): Promise<ParsedSessionResult> {
	const cacheKey = `${candidate.agentId}:${candidate.filePath}`;
	const signature = `${candidate.mtimeMs}:${candidate.size}:${maximumBytesToRead}`;
	const cachedSession = getCachedParsedSession(cacheKey, signature);
	if (cachedSession !== undefined) {
		return {
			session: cachedSession,
			transcriptWasTruncated: candidate.size > maximumBytesToRead,
		};
	}

	let sourceSessionId = basename(candidate.filePath, ".jsonl");
	if (candidate.agentId === "codex") {
		const idMatch = /([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl$/iu.exec(
			candidate.filePath,
		);
		sourceSessionId = idMatch?.[1] ?? sourceSessionId;
	}
	let sessionTitle = "Untitled session";
	let firstUserTitle: string | null = null;
	let generatedTitle: string | null = null;
	let sessionWorkingDirectoryPath: string | null = null;
	let gitBranchName: string | null = null;
	let modelId: string | null = null;
	let lastUpdatedAt = candidate.modifiedAt;
	let rejectedWorkerSession = false;
	const previewConversationTurns: RuntimeAvailableAgentSessionPreviewTurn[] = [];

	const { lines, transcriptWasTruncated } = await readBoundedJsonLines(
		candidate.filePath,
		candidate.size,
		maximumBytesToRead,
	);
	for (const line of lines) {
		const record = parseTranscriptJsonRecord(line);
		if (!record) {
			continue;
		}
		const timestamp = readString(record.timestamp);
		if (timestamp) {
			lastUpdatedAt = timestamp;
		}
		if (candidate.agentId === "claude") {
			sourceSessionId = readString(record.sessionId) ?? sourceSessionId;
			sessionWorkingDirectoryPath = readString(record.cwd) ?? sessionWorkingDirectoryPath;
			if (record.type === "custom-title") {
				sessionTitle = readString(record.customTitle) ?? sessionTitle;
			} else if (record.type === "ai-title") {
				generatedTitle = readString(record.aiTitle) ?? generatedTitle;
			} else if (record.type === "user") {
				const message = readTranscriptRecord(record.message);
				const text = normalizePreviewText(message?.content ?? record.message);
				firstUserTitle ??= text || null;
				addPreviewTurn(previewConversationTurns, "user", message?.content ?? record.message, record.timestamp);
			} else if (record.type === "assistant") {
				const message = readTranscriptRecord(record.message);
				modelId = readString(message?.model) ?? modelId;
				addPreviewTurn(previewConversationTurns, "assistant", message?.content ?? record.message, record.timestamp);
			}
			continue;
		}

		if (candidate.agentId === "codex") {
			const payload = readTranscriptRecord(record.payload);
			if (!payload) {
				continue;
			}
			if (record.type === "session_meta") {
				const source = readTranscriptRecord(payload.source);
				if (
					(readString(payload.thread_source) ?? "user").toLowerCase() !== "user" ||
					readTranscriptRecord(source?.subagent)
				) {
					rejectedWorkerSession = true;
					break;
				}
				sourceSessionId = readString(payload.id) ?? sourceSessionId;
				sessionTitle = readString(payload.title) ?? readString(payload.thread_name) ?? sessionTitle;
				sessionWorkingDirectoryPath = readString(payload.cwd) ?? sessionWorkingDirectoryPath;
				gitBranchName = readString(readTranscriptRecord(payload.git)?.branch) ?? gitBranchName;
			} else if (record.type === "turn_context") {
				sessionWorkingDirectoryPath = readString(payload.cwd) ?? sessionWorkingDirectoryPath;
				modelId = readString(payload.model) ?? modelId;
			} else if (record.type === "response_item" && payload.type === "message") {
				const role = payload.role === "assistant" ? "assistant" : payload.role === "user" ? "user" : null;
				if (role) {
					const text = normalizePreviewText(payload.content);
					if (role === "user") firstUserTitle ??= text || null;
					addPreviewTurn(previewConversationTurns, role, payload.content, record.timestamp);
				}
			} else if (
				record.type === "event_msg" &&
				(payload.type === "user_message" || payload.type === "agent_message")
			) {
				const role = payload.type === "user_message" ? "user" : "assistant";
				const text = normalizePreviewText(payload.message);
				if (role === "user") firstUserTitle ??= text || null;
				addPreviewTurn(previewConversationTurns, role, payload.message, record.timestamp);
			}
			continue;
		}

		const role = record.role === "assistant" ? "assistant" : record.role === "user" ? "user" : null;
		if (role) {
			const text = normalizePreviewText(record.message ?? record.content);
			if (role === "user") firstUserTitle ??= text || null;
			addPreviewTurn(previewConversationTurns, role, record.message ?? record.content, record.timestamp);
		}
	}

	if (rejectedWorkerSession || !SESSION_UUID_PATTERN.test(sourceSessionId) || previewConversationTurns.length === 0) {
		cacheParsedSession(cacheKey, { signature, session: null });
		return { session: null, transcriptWasTruncated };
	}
	if (sessionTitle === "Untitled session") {
		sessionTitle = generatedTitle ?? firstUserTitle ?? sessionTitle;
	}
	const session: IndexedAvailableAgentSession = {
		sourceAgentId: candidate.agentId,
		sourceSessionId,
		sessionTitle: sessionTitle.slice(0, 240),
		sessionWorkingDirectoryPath,
		gitBranchName,
		modelId,
		lastUpdatedAt,
		previewConversationTurns,
		sourceFilePath: candidate.filePath,
	};
	cacheParsedSession(cacheKey, { signature, session });
	return { session, transcriptWasTruncated };
}

async function resolveGitCommonDirectory(pathValue: string): Promise<string | null> {
	const normalizedPath = resolve(pathValue);
	let cached = gitCommonDirectoryCache.get(normalizedPath);
	if (!cached) {
		cached = runGit(normalizedPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).then((result) =>
			result.ok && result.stdout ? resolve(result.stdout) : null,
		);
		gitCommonDirectoryCache.set(normalizedPath, cached);
	}
	return cached;
}

function addCurrentWorkspacePathToMatchingCursorSession(
	session: IndexedAvailableAgentSession,
	workspacePath: string,
): IndexedAvailableAgentSession {
	if (session.sourceAgentId !== "cursor" || session.sessionWorkingDirectoryPath) {
		return session;
	}
	const cursorProjectDirectory = basename(dirname(dirname(dirname(session.sourceFilePath))));
	return cursorProjectDirectory === encodedAgentProjectPath(workspacePath)
		? { ...session, sessionWorkingDirectoryPath: workspacePath }
		: session;
}

async function belongsToCurrentRepository(
	session: IndexedAvailableAgentSession,
	workspacePath: string,
	workspaceGitCommonDirectory: string | null,
): Promise<boolean> {
	if (session.sessionWorkingDirectoryPath && workspaceGitCommonDirectory) {
		return (await resolveGitCommonDirectory(session.sessionWorkingDirectoryPath)) === workspaceGitCommonDirectory;
	}
	if (session.sourceAgentId === "cursor") {
		const cursorProjectDirectory = basename(dirname(dirname(dirname(session.sourceFilePath))));
		return (
			cursorProjectDirectory === encodedAgentProjectPath(workspacePath) ||
			cursorProjectDirectory.endsWith(`-${basename(workspacePath)}`)
		);
	}
	return false;
}

function matchesSearchQuery(session: IndexedAvailableAgentSession, query: string): boolean {
	if (!query) return true;
	const searchableText = [
		session.sourceSessionId,
		session.sessionTitle,
		session.sessionWorkingDirectoryPath,
		session.gitBranchName,
		session.modelId,
		...session.previewConversationTurns.map((turn) => turn.text),
	]
		.filter(Boolean)
		.join(" ")
		.toLowerCase();
	return query
		.toLowerCase()
		.split(/\s+/u)
		.filter(Boolean)
		.every((term) => searchableText.includes(term));
}

export async function listAvailableAgentSessions(
	workspacePath: string,
	request: RuntimeAvailableAgentSessionsRequest,
): Promise<RuntimeAvailableAgentSessionsResponse> {
	const scanStartedAt = Date.now();
	const scanDeadlineAt = scanStartedAt + availableAgentSessionIndexLimits.sessionScanDeadlineMilliseconds;
	if (request.forceRefresh) {
		for (const key of [...parsedSessionCache.keys()]) {
			if (key.startsWith(`${request.agentId}:`)) parsedSessionCache.delete(key);
		}
	}
	const warnings: string[] = [];
	let candidates: SessionFileCandidate[] = [];
	try {
		candidates = await discoverSessionFiles(request.agentId);
	} catch (error) {
		warnings.push(error instanceof Error ? error.message : String(error));
	}
	candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
	const currentAgentCacheKeys = new Set(candidates.map((candidate) => `${candidate.agentId}:${candidate.filePath}`));
	for (const key of [...parsedSessionCache.keys()]) {
		if (key.startsWith(`${request.agentId}:`) && !currentAgentCacheKeys.has(key)) {
			parsedSessionCache.delete(key);
		}
	}
	const parsed: IndexedAvailableAgentSession[] = [];
	let candidateIndex = 0;
	let remainingTranscriptReadBytes = availableAgentSessionIndexLimits.maximumTranscriptBytesPerScan;
	let boundedTranscriptCount = 0;
	let scanStoppedByReadBudget = false;
	let scanStoppedByDeadline = false;
	while (candidateIndex < candidates.length) {
		if (Date.now() >= scanDeadlineAt) {
			scanStoppedByDeadline = true;
			break;
		}
		const batch: Array<{ candidate: SessionFileCandidate; maximumBytesToRead: number }> = [];
		while (batch.length < SESSION_PARSE_CONCURRENCY && candidateIndex < candidates.length) {
			const candidate = candidates[candidateIndex];
			candidateIndex += 1;
			const desiredMaximumBytesToRead = Math.min(
				candidate.size,
				availableAgentSessionIndexLimits.maximumTranscriptBytesPerFile,
			);
			const cacheKey = `${candidate.agentId}:${candidate.filePath}`;
			const desiredSignature = `${candidate.mtimeMs}:${candidate.size}:${desiredMaximumBytesToRead}`;
			const hasDesiredCachedResult = parsedSessionCache.get(cacheKey)?.signature === desiredSignature;
			if (hasDesiredCachedResult) {
				batch.push({ candidate, maximumBytesToRead: desiredMaximumBytesToRead });
				continue;
			}
			if (remainingTranscriptReadBytes <= 0) {
				scanStoppedByReadBudget = true;
				candidateIndex -= 1;
				break;
			}
			const maximumBytesToRead = Math.min(desiredMaximumBytesToRead, remainingTranscriptReadBytes);
			remainingTranscriptReadBytes -= maximumBytesToRead;
			batch.push({ candidate, maximumBytesToRead });
			if (maximumBytesToRead < desiredMaximumBytesToRead) {
				scanStoppedByReadBudget = true;
				break;
			}
		}
		if (batch.length === 0) break;
		const batchResults = await Promise.all(
			batch.map(async ({ candidate, maximumBytesToRead }) => {
				try {
					return await parseAvailableAgentSession(candidate, maximumBytesToRead);
				} catch (error) {
					warnings.push(
						`${basename(candidate.filePath)}: ${error instanceof Error ? error.message : String(error)}`,
					);
					return { session: null, transcriptWasTruncated: false };
				}
			}),
		);
		for (const result of batchResults) {
			if (result.transcriptWasTruncated) boundedTranscriptCount += 1;
			if (result.session) parsed.push(result.session);
		}
		if (scanStoppedByReadBudget) break;
	}
	if (boundedTranscriptCount > 0) {
		warnings.unshift(
			`${boundedTranscriptCount} session transcript${boundedTranscriptCount === 1 ? " was" : "s were"} previewed from bounded head/tail data.`,
		);
	}
	if (scanStoppedByReadBudget) {
		warnings.unshift(
			`Session history scan stopped after reaching the ${availableAgentSessionIndexLimits.maximumTranscriptBytesPerScan}-byte read budget; showing the newest indexed sessions.`,
		);
	} else if (scanStoppedByDeadline) {
		warnings.unshift(
			`Session history scan stopped after ${availableAgentSessionIndexLimits.sessionScanDeadlineMilliseconds}ms; showing the newest indexed sessions.`,
		);
	}

	const parsedWithKnownCursorWorkspacePaths = parsed.map((session) =>
		addCurrentWorkspacePathToMatchingCursorSession(session, workspacePath),
	);
	const uniqueParsedSessions = [
		...new Map(
			parsedWithKnownCursorWorkspacePaths.map((session) => [
				`${session.sourceAgentId}:${session.sourceSessionId}`,
				session,
			]),
		).values(),
	];
	const workspaceGitCommonDirectory = await resolveGitCommonDirectory(workspacePath);
	const scoped =
		request.searchScope === "all_local_sessions"
			? uniqueParsedSessions
			: (
					await Promise.all(
						uniqueParsedSessions.map(async (session) => ({
							session,
							matches: await belongsToCurrentRepository(session, workspacePath, workspaceGitCommonDirectory),
						})),
					)
				)
					.filter((entry) => entry.matches)
					.map((entry) => entry.session);
	const matching = scoped
		.filter((session) => matchesSearchQuery(session, request.query))
		.sort((left, right) => Date.parse(right.lastUpdatedAt) - Date.parse(left.lastUpdatedAt));
	const pageStart = request.pageCursor;
	const pageEnd = pageStart + request.pageSize;
	return {
		sessions: matching.slice(pageStart, pageEnd).map(({ sourceFilePath: _sourceFilePath, ...session }) => session),
		nextPageCursor: pageEnd < matching.length ? pageEnd : null,
		totalMatchingSessions: matching.length,
		scanWarnings: warnings.slice(0, 20),
	};
}
