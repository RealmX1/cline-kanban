// 转录探针：读 agent 自己落盘的 JSONL，回答「这个工作目录的对话，最后一条 agent 产出在什么时刻」。
// 用真实文件系统夹具驱动（不 mock fs），因为本模块的价值恰恰在于「真的会不会读对文件、读对记录」——
// 目录名编码错一个字符就静默查不到，mock 掉 fs 就把要守的东西一起 mock 掉了。
// 探针接受 homeDirectoryPath 覆盖，故本套件不改 process.env.HOME、也不碰 git，可留在 precommit-safe。

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
	getPersistedAgentTranscriptProbeCacheSizeForTests,
	MAX_TRANSCRIPT_BYTES_PER_PROBE_FILE,
	MAX_UNCACHED_TRANSCRIPT_READ_BYTES_PER_PROBE,
	probePersistedAgentTranscriptLastConversationProgress,
	resetPersistedAgentTranscriptProbeStateForTests,
	supportsPersistedAgentTranscriptConversationProgressProbe,
} from "../../../src/agent-session-history/persisted-agent-transcript-last-conversation-progress-probe";

const WORKSPACE_PATH = "/tmp/kanban-probe-workspace/repo";
// Claude Code 落盘的目录名：把非字母数字全换成短横，**保留前导短横**。写死在这里是刻意的——
// 若实现哪天改用会去掉前导短横的那个编码器，本用例必须立刻红，而不是静默查不到文件。
const CLAUDE_PROJECT_DIRECTORY_NAME = "-tmp-kanban-probe-workspace-repo";

let temporaryHomeDirectoryPath: string | null = null;

function createTemporaryHome(): string {
	temporaryHomeDirectoryPath = mkdtempSync(join(tmpdir(), "kanban-transcript-probe-"));
	return temporaryHomeDirectoryPath;
}

function writeTranscript(homeDirectoryPath: string, transcriptFileName: string, records: unknown[]): string {
	const filePath = join(homeDirectoryPath, ".claude", "projects", CLAUDE_PROJECT_DIRECTORY_NAME, transcriptFileName);
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
	return filePath;
}

// 造一个超过单文件读取预算的转录，assistant 记录压在最末尾（探针超预算时读的是「头 1/4 + 尾 3/4」，
// 记录必须落在尾段才读得到）。用于驱动冷读字节预算这条路径——小文件撑不爆预算。
function writeLargeTranscriptEndingWithAssistantRecord(
	homeDirectoryPath: string,
	transcriptFileName: string,
	assistantTimestamp: string,
): string {
	const paddingRecord = userRecord("2026-07-19T10:00:00.000Z");
	const paddingRecordByteLength = JSON.stringify(paddingRecord).length + 1;
	const paddingRecordCount = Math.ceil(MAX_TRANSCRIPT_BYTES_PER_PROBE_FILE / paddingRecordByteLength) + 1;
	return writeTranscript(homeDirectoryPath, transcriptFileName, [
		...Array.from({ length: paddingRecordCount }, () => paddingRecord),
		assistantRecord(assistantTimestamp),
	]);
}

function assistantRecord(timestamp: string): unknown {
	return { type: "assistant", timestamp, message: { role: "assistant", content: [{ type: "text", text: "hi" }] } };
}

function userRecord(timestamp: string): unknown {
	return { type: "user", timestamp, message: { role: "user", content: "go on" } };
}

async function probe(homeDirectoryPath: string) {
	return probePersistedAgentTranscriptLastConversationProgress({
		agentId: "claude",
		workspacePath: WORKSPACE_PATH,
		homeDirectoryPath,
	});
}

afterEach(() => {
	resetPersistedAgentTranscriptProbeStateForTests();
	if (temporaryHomeDirectoryPath) {
		rmSync(temporaryHomeDirectoryPath, { recursive: true, force: true });
	}
	temporaryHomeDirectoryPath = null;
});

describe("持久转录探针", () => {
	it("取最后一条 assistant 记录的时刻，并标成最高置信证据", async () => {
		const home = createTemporaryHome();
		writeTranscript(home, "session-a.jsonl", [
			userRecord("2026-07-31T06:00:00.000Z"),
			assistantRecord("2026-07-31T07:09:00.000Z"),
		]);

		expect(await probe(home)).toEqual({
			observedAtMs: Date.parse("2026-07-31T07:09:00.000Z"),
			evidenceKind: "persisted_agent_transcript",
		});
	});

	// 根因回归（病灶样本 ce120）：会话今天被重开 ⇒ 文件 mtime 是今天，但内容停在 7 天前，
	// 尾部那条 `last-prompt` 记录**不带任何时间戳**。探针必须读内容、绝不能退回 mtime——
	// 退回 mtime 就等于把「今天重开过这个会话」错读成「今天对话推进过」，正是要修的 bug 换个地方重犯。
	it("文件 mtime 是今天、内容却停在七天前 ⇒ 取内容里的时刻，绝不退回 mtime", async () => {
		const home = createTemporaryHome();
		const staleConversationAt = "2026-07-31T07:09:00.000Z";
		const filePath = writeTranscript(home, "session-reopened.jsonl", [
			assistantRecord(staleConversationAt),
			// 重开会话时补写的尾记录：无 timestamp，正是实测样本里的形状。
			{ type: "last-prompt", prompt: "continue" },
		]);
		const reopenedTodayMs = Date.parse("2026-08-07T13:15:00.000Z");
		utimesSync(filePath, new Date(reopenedTodayMs), new Date(reopenedTodayMs));

		const observation = await probe(home);
		expect(observation?.observedAtMs).toBe(Date.parse(staleConversationAt));
		expect(observation?.observedAtMs).toBeLessThan(reopenedTodayMs);
	});

	it("同一工作目录多次续跑（多个转录文件）⇒ 取跨文件的最大时刻", async () => {
		const home = createTemporaryHome();
		writeTranscript(home, "session-older.jsonl", [assistantRecord("2026-07-20T10:00:00.000Z")]);
		writeTranscript(home, "session-newer.jsonl", [assistantRecord("2026-08-02T18:30:00.000Z")]);

		expect((await probe(home))?.observedAtMs).toBe(Date.parse("2026-08-02T18:30:00.000Z"));
	});

	// 根因回归（文件**选择**这一步同样不许信 mtime）：一个工作目录下攒了 6 个转录文件，其中 5 个旧会话
	// 刚被重开过（mtime 刷到当下、内容仍停在 7 月），真正含最新 assistant 记录的那个反而 mtime 最旧。
	// 旧实现按 mtime 降序取前 4 个，真相文件被挤出候选集，探针于是交出一个偏旧却带最高置信度的值——
	// 而合并 reducer 授权 persisted_agent_transcript 无条件回拉低置信已存值，这个偏旧值会把一个其实
	// 更准确的 TUI 观测拉回去。故断言：文件再多、真相文件 mtime 再旧，探针也必须给出内容里的最新时刻。
	it("六个转录文件、真相文件 mtime 最旧（其余五个刚被重开）⇒ 仍取内容里的最新时刻", async () => {
		const home = createTemporaryHome();
		const stalledConversationAt = "2026-07-20T10:00:00.000Z";
		const latestConversationAt = "2026-08-01T09:30:00.000Z";
		const reopenedTodayMs = Date.parse("2026-08-05T21:00:00.000Z");

		// 真相文件：内容最新，但 mtime 最旧（写完那一刻就没再被碰过）。
		const latestFilePath = writeTranscript(home, "session-latest.jsonl", [assistantRecord(latestConversationAt)]);
		utimesSync(
			latestFilePath,
			new Date(Date.parse(latestConversationAt)),
			new Date(Date.parse(latestConversationAt)),
		);

		// 五个被重开的旧会话：内容停在 7 月，mtime 却全被刷到 8 月 5 日，稳稳压在真相文件前面。
		for (let index = 0; index < 5; index += 1) {
			const reopenedFilePath = writeTranscript(home, `session-reopened-${index}.jsonl`, [
				assistantRecord(stalledConversationAt),
				{ type: "last-prompt", prompt: "continue" },
			]);
			utimesSync(reopenedFilePath, new Date(reopenedTodayMs), new Date(reopenedTodayMs));
		}

		expect((await probe(home))?.observedAtMs).toBe(Date.parse(latestConversationAt));
	});

	// 成本回归：去掉固定 top-N 截断后，不许退化成「每次探测都把整个目录重解析一遍」。
	// mtime 只作读取顺序提示，但它是内容时刻的**上界**——一旦手上的最大值已经比某个候选的 mtime 还新，
	// 那个候选（及其后所有更旧的）不可能藏着更新的记录，可证明安全地整段剪掉。
	// 缓存条目只在文件真被读过时才产生，故用缓存规模反证「六个文件只读了一个」。
	it("mtime 最新的文件内容也最新 ⇒ 其余候选被上界剪枝，六个文件只读一个", async () => {
		const home = createTemporaryHome();
		const newestFilePath = writeTranscript(home, "session-newest.jsonl", [
			assistantRecord("2026-08-05T20:00:00.000Z"),
		]);
		utimesSync(
			newestFilePath,
			new Date(Date.parse("2026-08-05T20:00:00.000Z")),
			new Date(Date.parse("2026-08-05T20:00:00.000Z")),
		);
		for (let index = 0; index < 5; index += 1) {
			const olderFilePath = writeTranscript(home, `session-older-${index}.jsonl`, [
				assistantRecord("2026-07-20T10:00:00.000Z"),
			]);
			const olderMs = Date.parse("2026-07-20T10:00:00.000Z");
			utimesSync(olderFilePath, new Date(olderMs), new Date(olderMs));
		}

		expect((await probe(home))?.observedAtMs).toBe(Date.parse("2026-08-05T20:00:00.000Z"));
		expect(getPersistedAgentTranscriptProbeCacheSizeForTests()).toBe(1);
	});

	// 冷读字节预算这道成本闸门的两条契约：
	//   ① 撑爆预算 ⇒ 返回 null（「这次问不出结论」）。此时还有候选没被证伪，手上的最大值没被证明是全局
	//      最大，而合并 reducer 授权 persisted_agent_transcript 无条件回拉低置信已存值——交出一个未经
	//      证明的偏旧值就是把 top-N 截断那个 bug 换个罕见形状重犯。
	//   ② 闸门是**分摊**不是永久截断：这一趟读过的文件已进缓存，下一趟免费越过它们继续往前推进，
	//      于是同一份夹具第二次探测就能给出结论。第二次拿到值同时也反证了 ① 的 null 来自预算而非解析失败。
	it("冷读预算被撑爆 ⇒ 先返回 null，再探一次靠缓存越过已读文件并给出结论", async () => {
		const home = createTemporaryHome();
		const stalledConversationAt = "2026-07-20T10:00:00.000Z";
		const reopenedTodayMs = Date.parse("2026-08-05T21:00:00.000Z");
		// 每个文件的冷读成本封顶在单文件预算，故「预算 / 单文件预算 + 1」个文件必然撑爆。
		const fileCountExceedingBudget =
			Math.floor(MAX_UNCACHED_TRANSCRIPT_READ_BYTES_PER_PROBE / MAX_TRANSCRIPT_BYTES_PER_PROBE_FILE) + 1;
		for (let index = 0; index < fileCountExceedingBudget; index += 1) {
			// 全部刷成「今天重开过」：mtime 一律比内容新 ⇒ 上界剪枝一个都剪不掉，只能靠预算兜底。
			const filePath = writeLargeTranscriptEndingWithAssistantRecord(
				home,
				`session-reopened-${index}.jsonl`,
				stalledConversationAt,
			);
			utimesSync(filePath, new Date(reopenedTodayMs), new Date(reopenedTodayMs));
		}

		expect(await probe(home)).toBeNull();
		expect(getPersistedAgentTranscriptProbeCacheSizeForTests()).toBe(fileCountExceedingBudget - 1);
		expect((await probe(home))?.observedAtMs).toBe(Date.parse(stalledConversationAt));
	});

	// 「问不出结论」与「对话没推进过」是两回事：探针一律返回 null 交由调用方保持原值，
	// 绝不能被当成「清空 / 回退已有观测」的依据。
	it.each([
		["转录目录不存在（这个工作目录还没跑过 claude）", [] as unknown[], false],
		["整个转录里一条 assistant 都没有", [userRecord("2026-08-02T18:30:00.000Z")], true],
		["assistant 记录缺 timestamp", [{ type: "assistant", message: { role: "assistant" } }], true],
		["timestamp 不可解析", [{ type: "assistant", timestamp: "不是时间" }], true],
	])("%s ⇒ 返回 null", async (_label, records, shouldWriteFile) => {
		const home = createTemporaryHome();
		if (shouldWriteFile) {
			writeTranscript(home, "session-a.jsonl", records);
		}
		expect(await probe(home)).toBeNull();
	});

	it("坏 JSON 行被跳过而非整条转录作废", async () => {
		const home = createTemporaryHome();
		const filePath = writeTranscript(home, "session-a.jsonl", [assistantRecord("2026-08-02T18:30:00.000Z")]);
		writeFileSync(
			filePath,
			`{ 这不是 JSON\n${JSON.stringify(assistantRecord("2026-08-02T18:30:00.000Z"))}\n`,
			"utf8",
		);

		expect((await probe(home))?.observedAtMs).toBe(Date.parse("2026-08-02T18:30:00.000Z"));
	});

	it("mtime + size 未变则复用缓存，周期性探测不重复读盘", async () => {
		const home = createTemporaryHome();
		writeTranscript(home, "session-a.jsonl", [assistantRecord("2026-08-02T18:30:00.000Z")]);

		const first = await probe(home);
		expect(getPersistedAgentTranscriptProbeCacheSizeForTests()).toBe(1);
		const second = await probe(home);
		expect(second).toEqual(first);
		expect(getPersistedAgentTranscriptProbeCacheSizeForTests()).toBe(1);
	});

	it("转录追加了新的 agent 产出后，缓存按 mtime+size 失效并给出新值", async () => {
		const home = createTemporaryHome();
		writeTranscript(home, "session-a.jsonl", [assistantRecord("2026-08-02T18:30:00.000Z")]);
		expect((await probe(home))?.observedAtMs).toBe(Date.parse("2026-08-02T18:30:00.000Z"));

		writeTranscript(home, "session-a.jsonl", [
			assistantRecord("2026-08-02T18:30:00.000Z"),
			assistantRecord("2026-08-03T09:00:00.000Z"),
		]);
		expect((await probe(home))?.observedAtMs).toBe(Date.parse("2026-08-03T09:00:00.000Z"));
	});

	// 覆盖范围是有意划的线（见模块注释）：只有能按工作目录直接寻址的 agent 才配得上周期性探测。
	// 这条把「支持哪几家」钉死，避免将来有人顺手放开谓词却没实现对应的路径解析。
	it.each([
		["claude", true],
		["codex", false],
		["cursor", false],
		["cline", false],
		["omp", false],
		[null, false],
	] as const)("supports…(%s) === %s", (agentId, expected) => {
		expect(supportsPersistedAgentTranscriptConversationProgressProbe(agentId)).toBe(expected);
	});

	it("不支持的 agent 一律不读盘、直接返回 null", async () => {
		const home = createTemporaryHome();
		writeTranscript(home, "session-a.jsonl", [assistantRecord("2026-08-02T18:30:00.000Z")]);

		const observation = await probePersistedAgentTranscriptLastConversationProgress({
			agentId: "codex",
			workspacePath: WORKSPACE_PATH,
			homeDirectoryPath: home,
		});
		expect(observation).toBeNull();
		expect(getPersistedAgentTranscriptProbeCacheSizeForTests()).toBe(0);
	});
});
