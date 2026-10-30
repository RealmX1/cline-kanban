import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCodexProfileAdoptionNativeTurnCompletionEvidence } from "../../../src/codex-configuration-sync/codex-profile-adoption-native-turn-completion-evidence";
import { runtimeTaskSessionSummarySchema } from "../../../src/core/api-contract";
import { createTempDir } from "../../utilities/temp-dir";

let workspace: ReturnType<typeof createTempDir>;
beforeEach(() => {
	workspace = createTempDir("codex-profile-completion-evidence-");
});
afterEach(() => {
	workspace.cleanup();
});

function summary() {
	return runtimeTaskSessionSummarySchema.parse({
		taskId: "owned-conversation",
		agentId: "codex",
		state: "awaiting_review",
		turnOwner: "user",
		liveness: "live",
		userTurnKind: "review",
		workspacePath: workspace.path,
		pid: 42,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: null,
		reviewReason: "hook",
		exitCode: null,
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "codex",
			nativeSessionId: "owned-native-session",
			transcriptPath: join(workspace.path, "native.jsonl"),
			observedAt: 1,
		},
	});
}
function line(type: string, payload: Record<string, unknown>) {
	return `${JSON.stringify({ type, timestamp: "2026-10-29T10:00:00.000Z", payload })}\n`;
}
async function writeCompletedTranscript(nativeSessionId = "owned-native-session") {
	await writeFile(
		join(workspace.path, "native.jsonl"),
		line("session_meta", { id: nativeSessionId, cwd: workspace.path, source: "cli" }) +
			line("event_msg", { type: "task_started", turn_id: "turn" }) +
			line("event_msg", { type: "task_complete", turn_id: "turn" }),
	);
}

describe("旧 Codex 会话的有界原生完成证据", () => {
	it("无需所有者端点，核验绑定身份、工作目录和最新完成事件", async () => {
		await writeCompletedTranscript();
		const evidence = await readCodexProfileAdoptionNativeTurnCompletionEvidence(summary());
		expect(evidence?.nativeTurnId).toBe("turn");
		expect(evidence?.evidenceFingerprint).toBeTruthy();
	});
	it("其他会话的历史完成不能作为续接证据", async () => {
		await writeCompletedTranscript("another-native-session");
		expect(await readCodexProfileAdoptionNativeTurnCompletionEvidence(summary())).toBeNull();
	});
	it.each([
		line("event_msg", { type: "task_started", turn_id: "new-turn" }),
		line("response_item", { type: "message", role: "user", content: [] }),
		line("response_item", { type: "function_call", call_id: "new-tool" }),
		'{"type":"event_msg","payload":',
	])("完成后的新执行或未写完记录使证据失效", async (appended) => {
		await writeCompletedTranscript();
		await appendFile(join(workspace.path, "native.jsonl"), appended);
		expect(await readCodexProfileAdoptionNativeTurnCompletionEvidence(summary())).toBeNull();
	});
});
