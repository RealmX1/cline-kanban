import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	getPersistedAgentTranscriptProbeCacheSizeForTests,
	MAX_TRANSCRIPT_BYTES_PER_PROBE_FILE,
	probePersistedAgentTranscriptLastConversationProgress,
	resetPersistedAgentTranscriptProbeStateForTests,
	supportsPersistedAgentTranscriptConversationProgressProbe,
} from "../../../src/agent-session-history/persisted-agent-transcript-last-conversation-progress-probe";

let temporaryHomeDirectoryPath: string | null = null;
function createTemporaryHome(): string {
	temporaryHomeDirectoryPath = mkdtempSync(join(tmpdir(), "kanban-transcript-probe-"));
	return temporaryHomeDirectoryPath;
}
function writeTranscript(home: string, fileName: string, records: unknown[]): string {
	const path = join(home, ".claude", "projects", "-shared-workspace", fileName);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
	return path;
}
function assistantRecord(timestamp: string, overrides: Record<string, unknown> = {}) {
	return {
		type: "assistant",
		timestamp,
		message: { role: "assistant", content: [{ type: "text", text: "回答" }] },
		...overrides,
	};
}
function probe(path: string, nativeSessionId = "main") {
	return probePersistedAgentTranscriptLastConversationProgress({
		agentId: "claude",
		workspacePath: "/shared/workspace",
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "claude",
			nativeSessionId,
			transcriptPath: path,
			observedAt: 1,
		},
	});
}
afterEach(() => {
	resetPersistedAgentTranscriptProbeStateForTests();
	if (temporaryHomeDirectoryPath) rmSync(temporaryHomeDirectoryPath, { recursive: true, force: true });
	temporaryHomeDirectoryPath = null;
});

describe("按已确认原生会话寻址的持久转录探针", () => {
	it("同一工作目录的主会话与 peer 只读取各自已确认的原生转录", async () => {
		const home = createTemporaryHome();
		const mainPath = writeTranscript(home, "main.jsonl", [assistantRecord("2026-07-20T10:00:00Z")]);
		const peerPath = writeTranscript(home, "peer.jsonl", [assistantRecord("2026-08-02T18:30:00Z")]);
		expect((await probe(mainPath))?.observedAtMs).toBe(Date.parse("2026-07-20T10:00:00Z"));
		expect((await probe(peerPath, "peer"))?.observedAtMs).toBe(Date.parse("2026-08-02T18:30:00Z"));
	});
	it("缺少已确认原生身份时保持未知，不从同 cwd 的其他会话猜最大值", async () => {
		const home = createTemporaryHome();
		writeTranscript(home, "unrelated.jsonl", [assistantRecord("2026-08-02T18:30:00Z")]);
		expect(
			await probePersistedAgentTranscriptLastConversationProgress({
				agentId: "claude",
				workspacePath: "/shared/workspace",
				homeDirectoryPath: home,
			}),
		).toBeNull();
	});
	it("文件 mtime 刷新只影响缓存，不成为对话推进时间", async () => {
		const home = createTemporaryHome();
		const path = writeTranscript(home, "main.jsonl", [
			assistantRecord("2026-07-20T10:00:00Z"),
			{ type: "last-prompt", prompt: "continue" },
		]);
		utimesSync(path, new Date("2026-08-02T18:30:00Z"), new Date("2026-08-02T18:30:00Z"));
		expect(await probe(path)).toEqual({
			observedAtMs: Date.parse("2026-07-20T10:00:00Z"),
			evidenceKind: "persisted_agent_transcript",
		});
	});
	it("缺路径、agent 来源不符、其他原生身份或侧链时不借用内容", async () => {
		const home = createTemporaryHome();
		const path = writeTranscript(home, "main.jsonl", [
			assistantRecord("2026-07-20T10:00:00Z", { sessionId: "other" }),
		]);
		expect(await probe(path)).toBeNull();
		expect(
			await probePersistedAgentTranscriptLastConversationProgress({
				agentId: "claude",
				workspacePath: null,
				agentNativeConversationSessionIdentity: {
					sourceAgentId: "omp",
					nativeSessionId: "main",
					transcriptPath: path,
					observedAt: 1,
				},
			}),
		).toBeNull();
		writeTranscript(home, "main.jsonl", [assistantRecord("2026-07-20T10:00:00Z", { isSidechain: true })]);
		expect(await probe(path)).toBeNull();
	});
	it("只缓存精确目标文件；文件不变复用，追加内容后刷新", async () => {
		const home = createTemporaryHome();
		const path = writeTranscript(home, "main.jsonl", [assistantRecord("2026-07-20T10:00:00Z")]);
		for (let index = 0; index < 20; index += 1)
			writeTranscript(home, `other-${index}.jsonl`, [assistantRecord("2026-08-02T18:30:00Z")]);
		await probe(path);
		await probe(path);
		expect(getPersistedAgentTranscriptProbeCacheSizeForTests()).toBe(1);
		writeTranscript(home, "main.jsonl", [
			assistantRecord("2026-07-20T10:00:00Z"),
			assistantRecord("2026-08-02T18:30:00Z"),
		]);
		expect((await probe(path))?.observedAtMs).toBe(Date.parse("2026-08-02T18:30:00Z"));
	});
	it("超预算的大转录仍从有界尾窗读取最新真实输出", async () => {
		const home = createTemporaryHome();
		const padding = { type: "progress", body: "x".repeat(MAX_TRANSCRIPT_BYTES_PER_PROBE_FILE + 1) };
		const path = writeTranscript(home, "main.jsonl", [padding, assistantRecord("2026-08-02T18:30:00Z")]);
		expect((await probe(path))?.observedAtMs).toBe(Date.parse("2026-08-02T18:30:00Z"));
	});
	it.each(["claude", "codex", "omp"] as const)("%s 支持已知路径的有界探针", (agentId) => {
		expect(supportsPersistedAgentTranscriptConversationProgressProbe(agentId)).toBe(true);
	});
	it.each(["cursor", "gemini", "cline", undefined] as const)("%s 没有通用 JSONL 定向解析器时保守降级", (agentId) => {
		expect(supportsPersistedAgentTranscriptConversationProgressProbe(agentId)).toBe(false);
	});
});
