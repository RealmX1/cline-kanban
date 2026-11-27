import type { Dir } from "node:fs";
import { type FileHandle, open, opendir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import {
	parseTranscriptJsonRecord,
	readTranscriptRecord,
	splitCompleteJsonLines,
} from "./bounded-agent-transcript-reader";
import {
	codexTranscriptMetadataMatchesPersistentMainConversation,
	readCodexDecodedTranscriptChunks,
} from "./codex-transcript-read-source";
import { extractSubmittedUserPromptFromTranscriptRecord } from "./submitted-user-prompt-transcript-record-parser";

export type LegacyNativeHistoryAgentId = "claude" | "codex";
export const legacyNativeSessionIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const nativeHistoryScanCacheMilliseconds = 30_000;
const maximumNativeHistoryScanEntries = 40_000;
const maximumNativeHistoryScanMilliseconds = 90_000;
const maximumNativeHistoryEvidencePrefixBytes = 1024 * 1024;
const maximumConcurrentNativeHistorySourceScans = 4;

export interface LegacyNativeHistoryTranscriptHeader {
	nativeSessionId: string;
	workingDirectoryPath: string | null;
	createdAt: number;
	inheritedHistory: boolean;
}

function nativeHistoryTimestamp(value: unknown): number {
	return typeof value === "string" ? Date.parse(value) : typeof value === "number" ? value : Number.NaN;
}

function readNativeHistoryHeader(
	record: Record<string, unknown>,
	agentId: LegacyNativeHistoryAgentId,
): LegacyNativeHistoryTranscriptHeader | null {
	const payload = agentId === "codex" ? readTranscriptRecord(record.payload) : record;
	const nativeSessionId = agentId === "codex" ? payload?.id : record.sessionId;
	if (!payload || typeof nativeSessionId !== "string" || !legacyNativeSessionIdPattern.test(nativeSessionId))
		return null;
	if (
		agentId === "codex"
			? !codexTranscriptMetadataMatchesPersistentMainConversation(nativeSessionId, record)
			: record.isSidechain === true || !["user", "assistant", "system", "progress"].includes(String(record.type))
	)
		return null;
	return {
		nativeSessionId,
		workingDirectoryPath: typeof payload.cwd === "string" ? payload.cwd : null,
		createdAt: nativeHistoryTimestamp(payload.timestamp ?? record.timestamp),
		inheritedHistory:
			payload.forked_from_id != null ||
			payload.history_base != null ||
			record.isCompactSummary === true ||
			record.logicalParentUuid != null ||
			record.parentUuid != null,
	};
}

function codexRecordText(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function codexUserTurnBlocksLaterInitialPrompt(record: Record<string, unknown>): boolean {
	const payload = readTranscriptRecord(record.payload);
	if (!payload) return false;
	if (record.type === "event_msg" && payload.type === "user_message") {
		const text = codexRecordText(payload.message);
		if (text && !text.startsWith("<task-notification>")) return false;
		// 空正文或只有附件的首轮不能让后一条文字冒充精确首提示词。
		return true;
	}
	if (record.type !== "response_item" || payload.type !== "message" || payload.role !== "user") return false;
	const content = Array.isArray(payload.content) ? payload.content : [];
	const hasAttachment = content.some((block) => {
		const item = readTranscriptRecord(block);
		return item?.type === "input_image" || item?.type === "image" || item?.type === "input_file";
	});
	const hasUserText = content.some((block) => {
		const item = readTranscriptRecord(block);
		if ((item?.type !== "input_text" && item?.type !== "text") || typeof item.text !== "string") return false;
		const text = item.text.trim();
		return (
			Boolean(text) &&
			!text.startsWith("<environment_context>") &&
			!text.startsWith("<task-notification>") &&
			!/^# AGENTS\.md instructions for [^\r\n]+\r?\n\s*<INSTRUCTIONS>/u.test(text)
		);
	});
	return hasAttachment && !hasUserText;
}

function readInitialClaudePrompt(record: Record<string, unknown>): string | null {
	const message = readTranscriptRecord(record.message);
	if (
		record.type !== "user" ||
		message?.role !== "user" ||
		record.parentUuid !== null ||
		record.promptSource !== undefined ||
		record.origin != null ||
		record.isMeta === true ||
		record.isCompactSummary === true ||
		record.isSidechain === true ||
		record.synthetic === true ||
		record.toolUseResult != null
	)
		return null;
	if (typeof message.content === "string") return message.content;
	if (
		!Array.isArray(message.content) ||
		!message.content.every((block) => readTranscriptRecord(block)?.type === "text")
	)
		return null;
	return message.content.map((block) => readTranscriptRecord(block)?.text ?? "").join("\n");
}

async function readNativeHistoryPrefix(
	handle: FileHandle,
	path: string,
	length: number,
	inspect: (record: Record<string, unknown>) => boolean,
) {
	let prefix = Buffer.alloc(0);
	let decodedBytes = 0;
	let malformed = false;
	const assertReadBudget = () => {
		if (decodedBytes >= maximumNativeHistoryEvidencePrefixBytes) throw new Error("原生转录前缀超出核验预算。");
	};
	for await (const chunk of readCodexDecodedTranscriptChunks(handle, path, length, assertReadBudget)) {
		const count = Math.min(chunk.length, maximumNativeHistoryEvidencePrefixBytes - decodedBytes);
		decodedBytes += count;
		prefix = Buffer.concat([prefix, Buffer.from(chunk.subarray(0, count))]);
		for (const line of splitCompleteJsonLines(prefix, "file_start")) {
			const record = parseTranscriptJsonRecord(line);
			if (!record) malformed = true;
			else if (inspect(record)) return { decodedBytes, incomplete: malformed };
		}
		prefix = prefix.subarray(prefix.lastIndexOf(10) + 1);
		if (decodedBytes >= maximumNativeHistoryEvidencePrefixBytes) break;
	}
	return {
		decodedBytes,
		incomplete: malformed || prefix.length > 0 || decodedBytes >= maximumNativeHistoryEvidencePrefixBytes,
	};
}

export async function inspectLegacyNativeHistoryTranscript(
	path: string,
	agentId: LegacyNativeHistoryAgentId,
	readInitialPrompt = false,
) {
	const handle = await open(path, "r");
	try {
		const before = await handle.stat();
		if (!before.isFile()) throw new Error("原生记录不是普通文件。");
		const evidence: { header: LegacyNativeHistoryTranscriptHeader | null } = { header: null };
		let initialPrompt: string | null = null;
		let codexHeaderWasChecked = false;
		const { decodedBytes, incomplete } = await readNativeHistoryPrefix(handle, path, before.size, (record) => {
			if (!evidence.header) {
				if (codexHeaderWasChecked) return true;
				codexHeaderWasChecked = agentId === "codex";
				evidence.header = readNativeHistoryHeader(record, agentId);
				if (!evidence.header) return codexHeaderWasChecked;
				if (!readInitialPrompt) return true;
			}
			if (agentId === "claude" && record.sessionId !== evidence.header.nativeSessionId) return false;
			initialPrompt =
				extractSubmittedUserPromptFromTranscriptRecord(agentId, record)?.text ??
				(agentId === "claude" ? readInitialClaudePrompt(record) : null);
			// 发现第一条无法据为首提示词的人工消息后，不能用后继消息替代它。
			return (
				Boolean(initialPrompt) ||
				(agentId === "claude" &&
					record.type === "user" &&
					record.parentUuid === null &&
					record.isMeta !== true &&
					record.isSidechain !== true) ||
				(agentId === "codex" && codexUserTurnBlocksLaterInitialPrompt(record))
			);
		});
		const after = await stat(path);
		if (nativeHistoryFileRevision(before) !== nativeHistoryFileRevision(after))
			throw new Error("核验期间原生转录发生变化。");
		return {
			header: evidence.header,
			initialPrompt,
			decodedBytes,
			incomplete,
			revision: nativeHistoryFileRevision(after),
		};
	} finally {
		await handle.close();
	}
}

export function nativeHistoryFileRevision(metadata: {
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
}) {
	return JSON.stringify([metadata.dev, metadata.ino, metadata.size, metadata.mtimeMs, metadata.ctimeMs]);
}

export interface LegacyCodexHistoryScanWindow {
	startAt: number;
	endAt: number;
}

export function legacyCodexHistoryScanWindow(createdAt: number, observedAt: number): LegacyCodexHistoryScanWindow {
	const dayMillis = 86_400_000;
	const start = new Date(createdAt - 2 * dayMillis);
	const end = new Date(observedAt + 2 * dayMillis);
	return {
		startAt: Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1),
		endAt: Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 1),
	};
}

interface NativeHistorySourceScan {
	root: string;
	status: "scanning" | "complete" | "limited";
	expiresAt: number;
	entriesVisited: number;
	filesRead: number;
	decodedBytes: number;
	cacheHits: number;
	files: Map<string, { header: LegacyNativeHistoryTranscriptHeader | null; revision: string }>;
	uncheckedPaths: Set<string>;
	directoryRevisions: Map<string, string | null>;
	completion: Promise<void>;
}

const scansBySourceDirectory = new Map<string, NativeHistorySourceScan>();
const pendingScanRequestsBySourceDirectory = new Map<
	string,
	{ arrivals: { count: number }; result: Promise<NativeHistorySourceScan | null> }
>();
let activeSourceScans = 0;
const pendingSourceScans: (() => void)[] = [];

async function scanNativeHistoryDirectory(
	scan: NativeHistorySourceScan,
	agentId: LegacyNativeHistoryAgentId,
	previous?: NativeHistorySourceScan,
	window?: LegacyCodexHistoryScanWindow,
) {
	const deadline = performance.now() + maximumNativeHistoryScanMilliseconds;
	const directories = [scan.root];
	while (directories.length) {
		const directory = directories.pop();
		if (!directory) break;
		let revisionBefore: string | undefined;
		let opened: Dir;
		try {
			revisionBefore = nativeHistoryFileRevision(await stat(directory));
			opened = await opendir(directory);
		} catch (error) {
			if (
				(error as NodeJS.ErrnoException).code === "ENOENT" &&
				directory === scan.root &&
				revisionBefore === undefined
			)
				scan.directoryRevisions.set(directory, null);
			else scan.uncheckedPaths.add(directory);
			continue;
		}
		try {
			for await (const entry of opened) {
				if (++scan.entriesVisited > maximumNativeHistoryScanEntries || performance.now() >= deadline) {
					scan.status = "limited";
					return;
				}
				const path = join(directory, entry.name);
				if (entry.isDirectory() && agentId === "codex") directories.push(path);
				if (!entry.isFile() || !/\.jsonl(?:\.zst)?$/u.test(entry.name)) continue;
				if (window && !codexNativeHistoryRolloutFallsInsideWindow(path, window)) continue;
				// Claude 的项目目录只枚举主转录；subagents 位于子目录。
				try {
					const cached = previous?.files.get(path);
					if (cached && cached.revision === nativeHistoryFileRevision(await stat(path))) {
						scan.files.set(path, cached);
						scan.cacheHits++;
						continue;
					}
					scan.filesRead++;
					const evidence = await inspectLegacyNativeHistoryTranscript(path, agentId);
					scan.decodedBytes += evidence.decodedBytes;
					if (evidence.incomplete) scan.uncheckedPaths.add(path);
					else scan.files.set(path, { header: evidence.header, revision: evidence.revision });
				} catch {
					scan.uncheckedPaths.add(path);
				}
			}
			const revisionAfter = nativeHistoryFileRevision(await stat(directory));
			if (revisionBefore !== revisionAfter) scan.uncheckedPaths.add(directory);
			else scan.directoryRevisions.set(directory, revisionAfter);
		} catch {
			scan.uncheckedPaths.add(directory);
		}
	}
	scan.status = "complete";
}

async function legacyNativeHistoryScanRevisionsUnchanged(scan: NativeHistorySourceScan) {
	if (scan.directoryRevisions.size === 0) return false;
	for (const [directory, revision] of scan.directoryRevisions) {
		try {
			const metadata = await stat(directory);
			if (!metadata.isDirectory() || nativeHistoryFileRevision(metadata) !== revision) return false;
		} catch (error) {
			if (revision !== null || (error as NodeJS.ErrnoException).code !== "ENOENT") return false;
		}
	}
	// 原地改写只影响文件修订，也必须核验。
	for (const [path, file] of scan.files) {
		try {
			const metadata = await stat(path);
			if (!metadata.isFile() || nativeHistoryFileRevision(metadata) !== file.revision) return false;
		} catch {
			return false;
		}
	}
	return true;
}

export function requestLegacyNativeHistorySourceScan(
	root: string,
	agentId: LegacyNativeHistoryAgentId,
	window?: LegacyCodexHistoryScanWindow,
) {
	const key = JSON.stringify([agentId, root, window]);
	const pendingRequest = pendingScanRequestsBySourceDirectory.get(key);
	if (pendingRequest) {
		pendingRequest.arrivals.count++;
		return pendingRequest.result;
	}
	const arrivals = { count: 1 };
	const result = Promise.resolve().then(async () => {
		try {
			const previous = scansBySourceDirectory.get(key);
			if (previous?.status === "scanning") return previous;
			// 晚加入的请求需要到达后的复核证据。最多复核两轮，之后共享一轮重扫。
			for (let check = 0; check < 2 && previous && previous.expiresAt > Date.now(); check++) {
				const arrivalsBeforeCheck = arrivals.count;
				if (!(await legacyNativeHistoryScanRevisionsUnchanged(previous))) break;
				if (arrivals.count === arrivalsBeforeCheck) return previous;
			}
			return startLegacyNativeHistorySourceScan(key, root, agentId, previous, window);
		} finally {
			pendingScanRequestsBySourceDirectory.delete(key);
		}
	});
	pendingScanRequestsBySourceDirectory.set(key, { arrivals, result });
	return result;
}

function startLegacyNativeHistorySourceScan(
	key: string,
	root: string,
	agentId: LegacyNativeHistoryAgentId,
	previous?: NativeHistorySourceScan,
	window?: LegacyCodexHistoryScanWindow,
) {
	// 过期来源可再次扫描，并复用其未变化的文件核验。限制不同项目或账户产生的活动目录数。
	if (scansBySourceDirectory.size >= 128) {
		for (const [cachedKey, scan] of scansBySourceDirectory) {
			if (scan.status !== "scanning" && cachedKey !== key) scansBySourceDirectory.delete(cachedKey);
			if (scansBySourceDirectory.size < 128) break;
		}
		if (scansBySourceDirectory.size >= 128 && !previous) return null;
	}
	const scan: NativeHistorySourceScan = {
		root,
		status: "scanning",
		expiresAt: 0,
		entriesVisited: 0,
		filesRead: 0,
		cacheHits: 0,
		decodedBytes: 0,
		files: new Map(),
		uncheckedPaths: new Set(),
		directoryRevisions: new Map(),
		completion: Promise.resolve(),
	};
	scan.completion = new Promise<void>((complete) => {
		const start = () => {
			activeSourceScans++;
			void scanNativeHistoryDirectory(scan, agentId, previous, window)
				.catch(() => {
					scan.status = "limited";
				})
				.finally(() => {
					scan.expiresAt = Date.now() + nativeHistoryScanCacheMilliseconds;
					activeSourceScans--;
					complete();
					pendingSourceScans.shift()?.();
				});
		};
		if (activeSourceScans < maximumConcurrentNativeHistorySourceScans) start();
		else pendingSourceScans.push(start);
	});
	scansBySourceDirectory.set(key, scan);
	return scan;
}

export function codexNativeHistoryRolloutFallsInsideWindow(path: string, window: LegacyCodexHistoryScanWindow) {
	const day = /^rollout-(\d{4}-\d{2}-\d{2})T/u.exec(basename(path))?.[1];
	if (!day) return true;
	const date = Date.parse(day);
	return !Number.isFinite(date) || (date >= window.startAt && date < window.endAt);
}
