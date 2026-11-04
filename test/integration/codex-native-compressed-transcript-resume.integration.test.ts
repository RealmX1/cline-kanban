import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { inspectCodexNativeConversationTranscriptBeforeResume } from "../../src/agent-session-history/codex-native-conversation-transcript-location-for-resume";
import { withCodexAppServerRequestConnection } from "../../src/codex-native-session-protocol/codex-app-server-request-connection";
import { readCodexConversationTurns } from "../../src/codex-native-session-protocol/codex-native-conversation-history";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { compressedCodexSyntheticHistoryBase64 } from "../utilities/codex-native-resume-compressed-history-fixture";
import { compressedCodexTranscriptFixtureNativeSessionId } from "../utilities/codex-native-resume-compressed-transcript-fixtures";

it.skipIf(!process.env.KANBAN_CODEX_NATIVE_COMPRESSED_RESUME_TEST_BINARY)(
	"真实 Codex 从压缩转录恢复原 UUID 和两个完整合成回合，不请求模型或重投 Prompt",
	async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const codexHome = join(fixture.isolatedHomeDirectoryPath, ".codex");
		const workingDirectory = join(fixture.fixtureRootDirectoryPath, "restored-conversation-workspace");
		const sessions = join(codexHome, "sessions", "2026", "10", "23");
		await mkdir(sessions, { recursive: true });
		await mkdir(workingDirectory);
		const nativeSessionId = compressedCodexTranscriptFixtureNativeSessionId;
		const savedPath = join(sessions, `rollout-2026-10-23T08-51-50-${nativeSessionId}.jsonl`);
		await writeFile(`${savedPath}.zst`, Buffer.from(compressedCodexSyntheticHistoryBase64, "base64"));
		await writeFile(
			join(codexHome, "config.toml"),
			[
				"check_for_update_on_startup=false",
				'model_provider="isolated_compressed_resume"',
				"[features]",
				"hooks=false",
				"memories=false",
				"background_paginated_rollout_migration=false",
				"[model_providers.isolated_compressed_resume]",
				'name="隔离压缩转录验证"',
				'base_url="http://127.0.0.1:1/v1"',
				'wire_api="responses"',
				"requires_openai_auth=false",
			].join("\n"),
		);
		const environment = fixture.createIsolatedChildProcessEnvironment({
			CODEX_HOME: codexHome,
			CODEX_SQLITE_HOME: codexHome,
		});
		for (const name of Object.keys(environment)) {
			if (/^(OPENAI_|KANBAN_MODEL_PROVIDER_|KANBAN_HOOK_|AGENT_CONVERSATION_EXPLORATION_)/u.test(name))
				delete environment[name];
		}
		expect(
			await inspectCodexNativeConversationTranscriptBeforeResume({
				nativeSessionId,
				transcriptPath: savedPath,
				environmentOverrides: { CODEX_HOME: codexHome, HOME: fixture.isolatedHomeDirectoryPath },
			}),
		).toMatchObject({ persistedTranscriptPath: `${savedPath}.zst` });
		await withCodexAppServerRequestConnection(
			{
				binary: process.env.KANBAN_CODEX_NATIVE_COMPRESSED_RESUME_TEST_BINARY,
				workingDirectory,
				environment,
			},
			async (port) => {
				const restored = z
					.object({ thread: z.object({ id: z.string(), cwd: z.string() }) })
					.parse(await port.request("thread/resume", { threadId: nativeSessionId, cwd: workingDirectory }));
				expect(restored.thread).toMatchObject({ id: nativeSessionId, cwd: workingDirectory });
				const turns = await readCodexConversationTurns(port, nativeSessionId);
				expect(turns).toHaveLength(2);
				expect(turns.map((turn) => turn.status)).toEqual(["completed", "completed"]);
				expect(turns.flatMap((turn) => turn.items.map((item) => item.type))).toEqual([
					"userMessage",
					"agentMessage",
					"userMessage",
					"agentMessage",
				]);
				expect(JSON.stringify(turns)).toContain("合成历史问题 1");
				expect(JSON.stringify(turns)).toContain("合成历史回复 2");
			},
		);
	},
	60_000,
);
