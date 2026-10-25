import { randomUUID } from "node:crypto";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { encodeClaudeProjectDirectoryName } from "../../src/agent-session-history/bounded-agent-transcript-reader";
import {
	createIndependentTaskMainSessionHandoverTranscriptFork,
	prepareTaskMainSessionHandoverTranscriptNativeFork,
} from "../../src/server/task-main-session-handover-native-fork";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { createSpawnedChildProcessRegistrySigkilledAfterEachTest } from "./runtime-integration-test-spawned-child-process-lifecycle";

const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(async () => {
	await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
	vi.unstubAllEnvs();
});
const nativeOmpBinary = process.env.KANBAN_MAIN_SESSION_HANDOVER_NATIVE_OMP_BINARY;

it.each(nativeOmpBinary ? (["claude", "omp"] as const) : (["claude"] as const))(
	"%s 原生准备只复制固定历史，后续恢复不混入失败报告",
	async (agentId) => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		try {
			vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
			vi.stubEnv("USERPROFILE", fixture.isolatedHomeDirectoryPath);
			const workspacePath = join(fixture.ownedIntegrationProjectsDirectoryPath, "native-preparation");
			await mkdir(workspacePath, { recursive: true });
			const nativeId = randomUUID();
			const firstMessageId = randomUUID();
			const lastMessageId = randomUUID();
			const transcriptDirectory =
				agentId === "claude"
					? join(
							fixture.isolatedHomeDirectoryPath,
							".claude",
							"projects",
							encodeClaudeProjectDirectoryName(workspacePath),
						)
					: join(fixture.isolatedHomeDirectoryPath, "omp-source");
			await mkdir(transcriptDirectory, { recursive: true });
			const sourcePath = join(transcriptDirectory, `${nativeId}.jsonl`);
			const timestamp = new Date().toISOString();
			const records =
				agentId === "claude"
					? [
							{
								type: "user",
								uuid: firstMessageId,
								parentUuid: null,
								sessionId: nativeId,
								cwd: workspacePath,
								timestamp,
								isSidechain: false,
								message: { role: "user", content: "固定来源要求" },
							},
							{
								type: "assistant",
								uuid: lastMessageId,
								parentUuid: firstMessageId,
								sessionId: nativeId,
								cwd: workspacePath,
								timestamp,
								isSidechain: false,
								message: {
									id: "message-fixture",
									type: "message",
									role: "assistant",
									model: "claude-fixture",
									content: [{ type: "text", text: "固定来源答复" }],
									stop_reason: "end_turn",
									stop_sequence: null,
									usage: { input_tokens: 1, output_tokens: 1 },
								},
							},
						]
					: [
							{ type: "session", version: 3, id: nativeId, timestamp, cwd: workspacePath },
							{
								type: "message",
								id: firstMessageId,
								parentId: null,
								timestamp,
								message: {
									role: "user",
									content: [{ type: "text", text: "固定来源要求" }],
									timestamp: Date.now(),
								},
							},
							{
								type: "message",
								id: lastMessageId,
								parentId: firstMessageId,
								timestamp,
								message: {
									role: "assistant",
									api: "openai-completions",
									provider: "handover-fixture",
									model: "handover-model",
									content: [{ type: "text", text: "固定来源答复" }],
									stopReason: "stop",
									usage: {
										input: 1,
										output: 1,
										cacheRead: 0,
										cacheWrite: 0,
										totalTokens: 2,
										cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
									},
									timestamp: Date.now(),
								},
							},
						];
			await writeFile(sourcePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
			if (agentId === "omp") {
				await mkdir(sourcePath.slice(0, -6));
				await writeFile(join(sourcePath.slice(0, -6), "1.read.log"), "原生工具附件正文");
				const agentDirectory = join(fixture.isolatedHomeDirectoryPath, "isolated-omp-agent-configuration");
				await mkdir(agentDirectory);
				vi.stubEnv("PI_CODING_AGENT_DIR", agentDirectory);
				await writeFile(
					join(agentDirectory, "models.yml"),
					JSON.stringify({
						providers: {
							"handover-fixture": {
								baseUrl: "http://127.0.0.1:1",
								api: "openai-completions",
								apiKey: "fixture-no-network",
								models: [
									{
										id: "handover-model",
										name: "交接准备测试模型",
										reasoning: false,
										input: ["text"],
										contextWindow: 4096,
										maxTokens: 256,
									},
								],
							},
						},
					}),
				);
			}
			if (nativeOmpBinary) {
				const binaryDirectory = join(fixture.isolatedHomeDirectoryPath, "native-omp-binary");
				await mkdir(binaryDirectory);
				await symlink(nativeOmpBinary, join(binaryDirectory, "omp"));
				vi.stubEnv("PATH", `${binaryDirectory}${delimiter}${process.env.PATH ?? ""}`);
			}
			const input = {
				handoverId: randomUUID(),
				sourceTaskConversationSessionId: "source",
				sourceAgentId: agentId,
				sourceNativeSessionId: nativeId,
				sourceTranscriptPath: sourcePath,
				workingDirectoryPath: workspacePath,
				receiptFilePath: join(transcriptDirectory, "native-fork-preparation.json"),
			};
			const port = {
				createIndependentFork: async (
					request: Parameters<typeof createIndependentTaskMainSessionHandoverTranscriptFork>[0],
				) => {
					const child = await createIndependentTaskMainSessionHandoverTranscriptFork(request, (process) =>
						children.register(process),
					);
					const evidenceDirectory = process.env.KANBAN_MAIN_SESSION_HANDOVER_NATIVE_EVIDENCE_DIRECTORY;
					if (evidenceDirectory) {
						await mkdir(evidenceDirectory, { recursive: true });
						await writeFile(
							join(evidenceDirectory, `${agentId}-fork-comparison.json`),
							JSON.stringify(
								{
									frozen: await readFile(request.frozenTranscriptPath, "utf8"),
									child: await readFile(child.transcriptPath, "utf8"),
								},
								null,
								2,
							),
						);
					}
					return child;
				},
			};
			const child = await prepareTaskMainSessionHandoverTranscriptNativeFork(input, port);
			expect(child.nativeSessionId).not.toBe(nativeId);
			expect(await readFile(child.transcriptPath, "utf8")).toContain("固定来源答复");
			const recovered = await prepareTaskMainSessionHandoverTranscriptNativeFork(
				{
					...input,
					receiptFilePath: join(transcriptDirectory, "recovery-native-preparation.json"),
					frozenReceiptFilePath: input.receiptFilePath,
				},
				port,
			);
			expect(recovered.nativeSessionId).not.toBe(child.nativeSessionId);
			if (agentId === "omp") {
				expect(await readFile(child.transcriptPath, "utf8")).toContain('"mode":"plan"');
				expect(await readFile(join(child.transcriptPath.slice(0, -6), "1.read.log"), "utf8")).toBe(
					"原生工具附件正文",
				);
				expect(await readFile(join(recovered.transcriptPath.slice(0, -6), "1.read.log"), "utf8")).toBe(
					"原生工具附件正文",
				);
			}
		} finally {
			await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
			fixture.cleanup();
		}
	},
	90_000,
);
