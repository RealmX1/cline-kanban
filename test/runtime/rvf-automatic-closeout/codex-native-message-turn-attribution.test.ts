import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCodexNativeReviewStartMessageEvidence } from "../../../src/rvf-automatic-closeout/codex-native-review-start-message-evidence";
import { readCodexNativeCloseoutPromptAcceptanceEvidence } from "../../../src/rvf-automatic-closeout/read-codex-native-closeout-prompt-acceptance-evidence";

const temporaryTranscriptDirectories: string[] = [];
const promptText = [
	"RVF_AUTOMATIC_CLOSEOUT_TOKEN=0123456789abcdef",
	"run_id=isolated-run",
	`handoff_sha256=${"a".repeat(64)}`,
	"/isolated-run/artifacts/handoff.md",
].join("\n");

afterEach(async () => {
	await Promise.all(
		temporaryTranscriptDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function createNativeTranscriptFixture(targetTurnTrigger: "user" | null) {
	const workingDirectory = await mkdtemp(join(tmpdir(), "rvf-native-turn-attribution-"));
	temporaryTranscriptDirectories.push(workingDirectory);
	const transcriptPath = join(workingDirectory, "native-transcript.jsonl");
	const receivedAt = "2026-01-01T00:00:02.000Z";
	const records = [
		{
			type: "session_meta",
			payload: { id: "native", originator: "codex-tui", source: "cli", cwd: workingDirectory },
		},
		{
			type: "event_msg",
			payload: { type: "task_started", turn_id: "unknown-prior-turn", turn_attribution: { turn_trigger: null } },
		},
		{
			type: "event_msg",
			timestamp: "2026-01-01T00:00:01.000Z",
			payload: { type: "task_started", turn_id: "target", turn_attribution: { turn_trigger: targetTurnTrigger } },
		},
		{
			type: "event_msg",
			timestamp: receivedAt,
			payload: {
				type: "item_completed",
				turn_id: "target",
				item: { id: "target-message", type: "UserMessage", content: [{ type: "text", text: promptText }] },
			},
		},
	];
	await writeFile(transcriptPath, records.map((record) => JSON.stringify(record)).join("\n"));
	return { transcriptPath, workingDirectory, receivedAt };
}

function readMessageEvidence(
	reader: "review_start" | "closeout_acceptance",
	fixture: Awaited<ReturnType<typeof createNativeTranscriptFixture>>,
) {
	return reader === "review_start"
		? readCodexNativeReviewStartMessageEvidence({
				transcriptPath: fixture.transcriptPath,
				nativeSessionId: "native",
				nativeTurnId: "target",
				nativeMessageId: "target-message",
				text: promptText,
			})
		: readCodexNativeCloseoutPromptAcceptanceEvidence({
				transcriptPath: fixture.transcriptPath,
				nativeSessionId: "native",
				worktree: fixture.workingDirectory,
				promptSha256: createHash("sha256").update(promptText).digest("hex"),
				deliveryCreatedAt: "2026-01-01T00:00:00.000Z",
				decisionToken: "0123456789abcdef",
				runId: "isolated-run",
				handoffSha256: "a".repeat(64),
				handoffPath: "/isolated-run/artifacts/handoff.md",
			});
}

describe("原生消息 turn attribution 的空值边界", () => {
	it.each(["review_start", "closeout_acceptance"] as const)(
		"%s 可读取历史未知触发记录，仍要求目标回合明确归属 user",
		async (reader) => {
			const fixture = await createNativeTranscriptFixture("user");
			await expect(readMessageEvidence(reader, fixture)).resolves.toMatchObject(
				reader === "review_start" ? { receivedAt: fixture.receivedAt } : { nativeTurnId: "target" },
			);
		},
	);
	it.each(["review_start", "closeout_acceptance"] as const)(
		"%s 不把目标回合的未知触发归属提升为 user 证据",
		async (reader) => {
			const fixture = await createNativeTranscriptFixture(null);
			await expect(readMessageEvidence(reader, fixture)).rejects.toThrow(
				reader === "review_start" ? "原生消息正文、独立 user turn" : "精确正文缺少原生用户回合时间证据",
			);
		},
	);
});
