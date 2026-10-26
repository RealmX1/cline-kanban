import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fingerprintTaskMainSessionHandoverRecoveryEvidence } from "../../../src/server/task-main-session-handover-automatic-recovery";
import { prepareTaskMainSessionHandoverTranscriptNativeFork } from "../../../src/server/task-main-session-handover-native-fork";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

describe("同 harness fork 的固定材料与独立子身份", () => {
	it("OMP 原生附件迟到后证据指纹变化，沿已保存子身份自动复验", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		try {
			const directory = fixture.isolatedHomeDirectoryPath;
			const sourcePath = join(directory, "source.jsonl");
			const childPath = join(directory, "child.jsonl");
			const text = `${JSON.stringify({ type: "message", id: "message", message: { role: "assistant", content: "原生正文" } })}\n`;
			await writeFile(sourcePath, text);
			await mkdir(join(directory, "source"));
			await writeFile(join(directory, "source", "1.read.log"), "附件正文");
			const input = {
				handoverId: "handover",
				sourceTaskConversationSessionId: "source",
				sourceAgentId: "omp" as const,
				sourceNativeSessionId: "source-native",
				sourceTranscriptPath: sourcePath,
				workingDirectoryPath: directory,
				receiptFilePath: join(directory, "preparation.json"),
			};
			const createIndependentFork = vi.fn(async () => {
				await writeFile(childPath, text);
				return { nativeSessionId: "independent", transcriptPath: childPath };
			});
			await expect(
				prepareTaskMainSessionHandoverTranscriptNativeFork(input, { createIndependentFork }),
			).rejects.toThrow("附件");
			const record = {
				handoverId: "handover",
				sourceTaskConversationSessionId: "source",
				targetTaskConversationSessionId: "child",
				destination: { kind: "new_agent_session" as const, agentId: "omp" as const },
				status: "failed" as const,
				createdAt: 1,
				updatedAt: 1,
				userContextNotes: "",
				additionalPlanReferencePaths: [],
				materialDirectoryPath: directory,
				errorMessage: "附件待落盘",
				reportDeliveryStartedAt: null,
				reportDeliveryAttempt: 0,
				nativeForkPreparationReceiptPath: input.receiptFilePath,
			};
			const before = await fingerprintTaskMainSessionHandoverRecoveryEvidence({ record });
			await mkdir(join(directory, "child"));
			await writeFile(join(directory, "child", "1.read.log"), "附件正文");
			expect(await fingerprintTaskMainSessionHandoverRecoveryEvidence({ record })).not.toBe(before);
			expect(
				(await prepareTaskMainSessionHandoverTranscriptNativeFork(input, { createIndependentFork }))
					.nativeSessionId,
			).toBe("independent");
			expect(createIndependentFork).toHaveBeenCalledTimes(1);
		} finally {
			fixture.cleanup();
		}
	});
	it.each(["claude", "omp"] as const)(
		"%s 校验失败后按已保存子身份复验，不再 fork；恢复只继承冻结前缀",
		async (agentId) => {
			const fixture = createIsolatedGitTestWorkspaceFixture();
			try {
				const directory = join(fixture.isolatedHomeDirectoryPath, "persistent-native-fork");
				await mkdir(directory, { recursive: true });
				const sourcePath = join(directory, "source.jsonl");
				const childPath = join(directory, "child.jsonl");
				const message = {
					type: "message",
					id: "entry-1",
					uuid: "message-1",
					message: { role: "assistant", content: [{ type: "text", text: "固定原生正文" }] },
				};
				await writeFile(sourcePath, `${JSON.stringify(message)}\n`);
				let createdForkCount = 0;
				const createIndependentFork = vi.fn(async (forkInput: { frozenTranscriptPath: string }) => {
					createdForkCount++;
					if (createdForkCount === 1) {
						await writeFile(childPath, "");
						return { nativeSessionId: "independent-child", transcriptPath: childPath };
					}
					const recoveredPath = join(directory, "independent-recovery.jsonl");
					await writeFile(recoveredPath, await readFile(forkInput.frozenTranscriptPath));
					return { nativeSessionId: "independent-recovery", transcriptPath: recoveredPath };
				});
				const input = {
					handoverId: "handover-1",
					sourceTaskConversationSessionId: "source",
					sourceAgentId: agentId,
					sourceNativeSessionId: "source-native",
					sourceTranscriptPath: sourcePath,
					workingDirectoryPath: directory,
					receiptFilePath: join(directory, "preparation.json"),
				};
				await expect(
					prepareTaskMainSessionHandoverTranscriptNativeFork(input, { createIndependentFork }),
				).rejects.toThrow("固定历史");
				expect(
					JSON.parse(await readFile(input.receiptFilePath, "utf8")).attempts[0].childIdentity.nativeSessionId,
				).toBe("independent-child");
				await writeFile(childPath, `${JSON.stringify({ ...message, id: "new-id", uuid: "new-uuid" })}\n`);
				const prepared = await prepareTaskMainSessionHandoverTranscriptNativeFork(input, { createIndependentFork });
				expect(prepared.nativeSessionId).toBe("independent-child");
				expect(createIndependentFork).toHaveBeenCalledTimes(1);
				await writeFile(
					sourcePath,
					`${JSON.stringify(message)}\n${JSON.stringify({ ...message, id: "later", uuid: "later", message: { role: "assistant", content: "后续偏题" } })}\n`,
				);
				await expect(
					prepareTaskMainSessionHandoverTranscriptNativeFork(input, { createIndependentFork }),
				).rejects.toThrow("来源");
				const recovery = await prepareTaskMainSessionHandoverTranscriptNativeFork(
					{
						...input,
						receiptFilePath: join(directory, "recovery.json"),
						frozenReceiptFilePath: input.receiptFilePath,
					},
					{ createIndependentFork },
				);
				expect(recovery.nativeSessionId).toBe("independent-recovery");
				expect(createIndependentFork.mock.calls[1]?.[0]).toMatchObject({
					frozenTranscriptPath: expect.stringContaining("snapshot"),
				});
			} finally {
				fixture.cleanup();
			}
		},
	);
});
