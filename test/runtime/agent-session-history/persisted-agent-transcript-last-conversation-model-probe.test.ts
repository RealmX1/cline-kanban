// 转录模型探针：回答「`claude --continue` 待会儿恢复的那段对话，最后一条 agent 产出用的是哪个模型」。
// 用真实文件系统夹具驱动（不 mock fs），因为本模块的价值恰恰在于「真的会不会挑对文件、读对记录」——
// 目录名编码错一个字符、候选规则差一条，都会静默给出另一段会话的模型，而那正是要修的 bug 的形状。
// 探针接受 homeDirectoryPath 覆盖，故本套件不改 process.env.HOME、也不碰 git，可留在 precommit-safe。

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
	MAX_TRANSCRIPT_TAIL_BYTES_PER_MODEL_PROBE_FILE,
	probePersistedAgentTranscriptLastConversationModelIdentity,
	supportsPersistedAgentTranscriptLastConversationModelProbe,
} from "../../../src/agent-session-history/persisted-agent-transcript-last-conversation-model-probe";

// 合法 session id 形状的文件名——CLI 只把这种收作候选。
const SESSION_A = "aaaaaaaa-1111-4111-8111-111111111111";
const SESSION_B = "bbbbbbbb-2222-4222-8222-222222222222";

let temporaryRootPath: string | null = null;

interface ProbeFixture {
	homeDirectoryPath: string;
	workspacePath: string;
	// Claude Code 落盘的目录名：realpath 之后把非字母数字全换成短横，**保留前导短横**。
	// 这里刻意在测试里独立重算一遍（而不是 import 生产实现的编码器）——若实现哪天换成会去掉前导短横的
	// 那个编码器、或漏掉 realpath，本套件必须立刻红，而不是跟着一起错。
	projectDirectoryName: string;
}

function createProbeFixture(): ProbeFixture {
	temporaryRootPath = mkdtempSync(join(tmpdir(), "kanban-model-probe-"));
	const homeDirectoryPath = join(temporaryRootPath, "home");
	const workspacePath = join(temporaryRootPath, "workspace", "repo");
	mkdirSync(homeDirectoryPath, { recursive: true });
	mkdirSync(workspacePath, { recursive: true });
	return {
		homeDirectoryPath,
		workspacePath,
		projectDirectoryName: realpathSync(workspacePath).replace(/[^a-zA-Z0-9]/gu, "-"),
	};
}

function writeTranscript(fixture: ProbeFixture, transcriptFileName: string, records: unknown[]): string {
	const filePath = join(
		fixture.homeDirectoryPath,
		".claude",
		"projects",
		fixture.projectDirectoryName,
		transcriptFileName,
	);
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
	return filePath;
}

function assistantRecord(modelId: string, extra: Record<string, unknown> = {}): unknown {
	return {
		type: "assistant",
		timestamp: "2026-08-01T10:00:00.000Z",
		message: { role: "assistant", model: modelId, content: [{ type: "text", text: "hi" }] },
		...extra,
	};
}

function userRecord(): unknown {
	return { type: "user", timestamp: "2026-08-01T09:59:00.000Z", message: { role: "user", content: "go on" } };
}

// 造一条超大 tool_result，用来把真正的 assistant 记录挤出尾窗。
function oversizedToolResultRecord(): unknown {
	return { type: "user", timestamp: "2026-08-01T10:01:00.000Z", message: { role: "user", content: "x".repeat(4096) } };
}

function buildTranscriptLongerThanTailBudget(...trailingRecords: unknown[]): unknown[] {
	const paddingRecordByteLength = JSON.stringify(oversizedToolResultRecord()).length + 1;
	const paddingRecordCount = Math.ceil(MAX_TRANSCRIPT_TAIL_BYTES_PER_MODEL_PROBE_FILE / paddingRecordByteLength) + 2;
	return [
		assistantRecord("claude-opus-4-7"),
		...Array.from({ length: paddingRecordCount }, () => oversizedToolResultRecord()),
		...trailingRecords,
	];
}

async function probe(fixture: ProbeFixture, workspacePathOverride?: string) {
	return probePersistedAgentTranscriptLastConversationModelIdentity({
		agentId: "claude",
		workspacePath: workspacePathOverride ?? fixture.workspacePath,
		homeDirectoryPath: fixture.homeDirectoryPath,
	});
}

afterEach(() => {
	if (temporaryRootPath) {
		rmSync(temporaryRootPath, { recursive: true, force: true });
		temporaryRootPath = null;
	}
});

describe("persisted agent transcript last conversation model probe", () => {
	it("only supports claude, whose transcript directory is addressable from the working directory", () => {
		expect(supportsPersistedAgentTranscriptLastConversationModelProbe("claude")).toBe(true);
		expect(supportsPersistedAgentTranscriptLastConversationModelProbe("codex")).toBe(false);
		expect(supportsPersistedAgentTranscriptLastConversationModelProbe("cursor")).toBe(false);
		expect(supportsPersistedAgentTranscriptLastConversationModelProbe(null)).toBe(false);
	});

	it("reads the model off the last agent output in the transcript", async () => {
		const fixture = createProbeFixture();
		writeTranscript(fixture, `${SESSION_A}.jsonl`, [
			userRecord(),
			assistantRecord("claude-opus-4-8"),
			userRecord(),
			assistantRecord("claude-sonnet-5"),
		]);

		await expect(probe(fixture)).resolves.toBe("claude-sonnet-5");
	});

	it("skips sidechain records so a subagent's model is never pinned onto the main conversation", async () => {
		const fixture = createProbeFixture();
		writeTranscript(fixture, `${SESSION_A}.jsonl`, [
			assistantRecord("claude-opus-5"),
			assistantRecord("claude-haiku-4-5", { isSidechain: true }),
		]);

		await expect(probe(fixture)).resolves.toBe("claude-opus-5");
	});

	it("skips synthetic records, which the CLI cannot resolve as a model name", async () => {
		const fixture = createProbeFixture();
		writeTranscript(fixture, `${SESSION_A}.jsonl`, [
			assistantRecord("claude-opus-5"),
			assistantRecord("<synthetic>"),
		]);

		await expect(probe(fixture)).resolves.toBe("claude-opus-5");
	});

	it("returns null when the transcript has no agent output yet", async () => {
		const fixture = createProbeFixture();
		writeTranscript(fixture, `${SESSION_A}.jsonl`, [userRecord(), userRecord()]);

		await expect(probe(fixture)).resolves.toBeNull();
	});

	it("returns null when the working directory has never run a claude session", async () => {
		const fixture = createProbeFixture();

		await expect(probe(fixture)).resolves.toBeNull();
	});

	it("survives corrupt JSON lines instead of throwing", async () => {
		const fixture = createProbeFixture();
		const filePath = writeTranscript(fixture, `${SESSION_A}.jsonl`, [assistantRecord("claude-opus-5")]);
		writeFileSync(filePath, `{"type":"assistant" NOT JSON\n${JSON.stringify(assistantRecord("claude-opus-5"))}\n`);

		await expect(probe(fixture)).resolves.toBe("claude-opus-5");
	});

	// 以下四条守的是「复刻 `claude --continue` 的候选规则」，实现与 Claude Code 2.1.227 反编译结果对齐。

	it("resolves the working directory through symlinks, the way the CLI encodes its project key", async () => {
		// CLI 是 `try{realpath(cwd)}catch{cwd}`。不 realpath 就会算出一个根本不存在的目录名并静默查不到——
		// macOS 上 /tmp → /private/tmp 就是这个形状。
		const fixture = createProbeFixture();
		writeTranscript(fixture, `${SESSION_A}.jsonl`, [assistantRecord("claude-opus-5")]);
		const symlinkedWorkspacePath = join(temporaryRootPath ?? "", "workspace-symlink");
		symlinkSync(fixture.workspacePath, symlinkedWorkspacePath);

		await expect(probe(fixture, symlinkedWorkspacePath)).resolves.toBe("claude-opus-5");
	});

	it("picks the newest-mtime transcript, replicating which conversation --continue resumes", async () => {
		const fixture = createProbeFixture();
		const older = writeTranscript(fixture, `${SESSION_A}.jsonl`, [assistantRecord("claude-opus-4-8")]);
		const newer = writeTranscript(fixture, `${SESSION_B}.jsonl`, [assistantRecord("claude-sonnet-5")]);
		utimesSync(older, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
		utimesSync(newer, new Date(1_800_000_000_000), new Date(1_800_000_000_000));

		await expect(probe(fixture)).resolves.toBe("claude-sonnet-5");
	});

	it("breaks whole-millisecond mtime ties on descending session id, matching the CLI comparator", async () => {
		const fixture = createProbeFixture();
		// SESSION_B > SESSION_A 字典序，故并列时 CLI 会挑 B。
		const first = writeTranscript(fixture, `${SESSION_A}.jsonl`, [assistantRecord("claude-opus-4-8")]);
		const second = writeTranscript(fixture, `${SESSION_B}.jsonl`, [assistantRecord("claude-sonnet-5")]);
		const sameInstant = new Date(1_800_000_000_000);
		utimesSync(first, sameInstant, sameInstant);
		utimesSync(second, sameInstant, sameInstant);

		await expect(probe(fixture)).resolves.toBe("claude-sonnet-5");
	});

	it("ignores files the CLI would not treat as session transcripts", async () => {
		const fixture = createProbeFixture();
		// 合法候选（较旧）+ 两个 CLI 不会收的文件（较新）。若实现放宽了候选规则，就会挑到后两者之一。
		const valid = writeTranscript(fixture, `${SESSION_A}.jsonl`, [assistantRecord("claude-opus-5")]);
		const nonSessionName = writeTranscript(fixture, "not-a-session-id.jsonl", [assistantRecord("claude-haiku-4-5")]);
		utimesSync(valid, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
		utimesSync(nonSessionName, new Date(1_800_000_000_000), new Date(1_800_000_000_000));

		await expect(probe(fixture)).resolves.toBe("claude-opus-5");
	});

	// 这条守的是「超预算时绝不退回头段」。头段命中的是**对话开头**的模型，那个陈旧值会经 --model 真的
	// 启动、还会被写回卡片永久固化——比原 bug 更难察觉。实测真实转录里确有该形状（69MB，尾窗全是 attachment）。
	it("returns null rather than the conversation's opening model when the tail window holds no agent output", async () => {
		const fixture = createProbeFixture();
		writeTranscript(fixture, `${SESSION_A}.jsonl`, buildTranscriptLongerThanTailBudget());

		await expect(probe(fixture)).resolves.toBeNull();
	});

	it("still reads an agent output that sits inside the tail window of an over-budget transcript", async () => {
		const fixture = createProbeFixture();
		writeTranscript(
			fixture,
			`${SESSION_A}.jsonl`,
			buildTranscriptLongerThanTailBudget(assistantRecord("claude-opus-5")),
		);

		await expect(probe(fixture)).resolves.toBe("claude-opus-5");
	});
});
