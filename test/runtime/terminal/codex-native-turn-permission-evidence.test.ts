import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCodexNativeTurnPermissionEvidence } from "../../../src/codex-configuration-sync/codex-native-turn-permission-evidence";
import { runtimeTaskSessionSummarySchema } from "../../../src/core/api-contract";
import { createTempDir } from "../../utilities/temp-dir";

let fixture: ReturnType<typeof createTempDir>;
beforeEach(() => {
	fixture = createTempDir("codex-native-permission-evidence-");
});
afterEach(() => fixture.cleanup());
const line = (type: string, payload: Record<string, unknown>, timestamp = 2000) =>
	`${JSON.stringify({ type, timestamp: new Date(timestamp).toISOString(), payload })}\n`;

describe("Codex 权限采用的原生回合证据", () => {
	it.each(["匹配", "其他会话", "旧回合", "文件值与实际权限不同"])(
		"%s 的原生证据不能由文件写入冒充",
		async (condition) => {
			const summary = runtimeTaskSessionSummarySchema.parse({
				taskId: "session",
				state: "running",
				turnOwner: "agent",
				liveness: "live",
				userTurnKind: null,
				agentId: "codex",
				workspacePath: fixture.path,
				pid: 30,
				startedAt: 1,
				updatedAt: 1,
				lastOutputAt: null,
				reviewReason: null,
				exitCode: null,
				agentNativeConversationSessionIdentity: {
					sourceAgentId: "codex",
					nativeSessionId: "owned-native",
					transcriptPath: join(fixture.path, "native.jsonl"),
					observedAt: 1,
				},
			});
			await writeFile(
				join(fixture.path, "native.jsonl"),
				line("session_meta", {
					id: condition === "其他会话" ? "other-native" : "owned-native",
					cwd: fixture.path,
					source: "cli",
				}) +
					line(
						"turn_context",
						{ approval_policy: "on-request", sandbox_policy: { type: "workspace-write" } },
						condition === "旧回合" ? 500 : 2000,
					),
			);
			const evidence = await readCodexNativeTurnPermissionEvidence({
				summary,
				configurationChangedAtMs: 1000,
				selectedFields: {
					[JSON.stringify(["config.toml", "approval_policy"])]: {
						value: condition === "文件值与实际权限不同" ? "never" : "on-request",
					},
					[JSON.stringify(["config.toml", "sandbox_mode"])]: { value: "workspace-write" },
				},
			});
			if (condition === "匹配")
				expect(evidence).toMatchObject({
					[JSON.stringify(["config.toml", "approval_policy"])]: { value: "on-request" },
					[JSON.stringify(["config.toml", "sandbox_mode"])]: { value: "workspace-write" },
				});
			else expect(evidence).toBeNull();
		},
	);
});
