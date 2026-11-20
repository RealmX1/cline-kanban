import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { lockedFileSystem } from "../fs/locked-file-system";
import { mutateWorkspacePromptLibrary } from "../state/prompt-library-store";
import { getLegacyCodexConfigurationDirectory } from "./legacy-codex-configuration-writer-binding";

const retainedTerminalInputSchema = z.object({
	schemaVersion: z.literal(1),
	workspaceId: z.string(),
	conversationSessionId: z.string(),
	nativeSessionId: z.string(),
	profileId: z.string(),
	status: z.enum(["capturing", "restore_submission_started", "restored"]),
	bytesBase64: z.string(),
	capturedDraftText: z.string().optional(),
	capturedFromRuntimeSessionIncarnationId: z.string().optional(),
	capturedDraftRestoreStatus: z.enum(["pending", "submission_started", "restored"]).optional(),
});
const retainedInputDirectory = () =>
	join(getLegacyCodexConfigurationDirectory(), "retained-terminal-input-during-profile-adoption");

function assertOwnedRetainedInputPath(path: string) {
	if (
		dirname(path) !== retainedInputDirectory() ||
		lstatSync(retainedInputDirectory()).isSymbolicLink() ||
		!/^[a-f\d-]+\.json$/.test(basename(path)) ||
		!lstatSync(path).isFile() ||
		lstatSync(getLegacyCodexConfigurationDirectory()).isSymbolicLink()
	)
		throw new Error("profile 续接输入保留记录的归属不符。");
}

function readLegacyRetainedCodexTerminalInput(path: string) {
	assertOwnedRetainedInputPath(path);
	return retainedTerminalInputSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

function listUnrestoredLegacyCodexTerminalInputs() {
	try {
		return readdirSync(retainedInputDirectory())
			.filter((name) => /^[a-f\d-]+\.json$/.test(name))
			.flatMap((name) => {
				const path = join(retainedInputDirectory(), name);
				try {
					const record = readLegacyRetainedCodexTerminalInput(path);
					return record.status === "restored" ? [] : [{ path, record }];
				} catch {
					// 单份未知归属的记录保留原件，继续核验其他记录。
					return [];
				}
			});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

export async function preserveRetiredCodexWriterInputForSession(input: {
	workspaceId: string;
	taskId: string;
	conversationSessionId: string;
	nativeSessionId: string;
}) {
	let pendingRecovery: { retainedInputRecordPath: string; retainedByteCount: number; reason: string } | null = null;
	for (const { path, record } of listUnrestoredLegacyCodexTerminalInputs()) {
		if (
			record.workspaceId !== input.workspaceId ||
			record.conversationSessionId !== input.conversationSessionId ||
			record.nativeSessionId !== input.nativeSessionId
		)
			continue;
		const retainedBytes = Buffer.from(record.bytesBase64, "base64");
		const capturedDraftText = record.capturedDraftText;
		const recoveryReceiptPath = `${path}.retired-draft-prompt.json`;
		let documentedPromptId: string | undefined;
		try {
			if (!lstatSync(recoveryReceiptPath).isFile()) throw new Error("旧 Codex 草稿回执归属不明。");
			documentedPromptId = z
				.object({ promptId: z.string() })
				.parse(JSON.parse(readFileSync(recoveryReceiptPath, "utf8"))).promptId;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (
			capturedDraftText &&
			!documentedPromptId &&
			record.status === "capturing" &&
			record.capturedDraftRestoreStatus !== "submission_started" &&
			record.capturedDraftRestoreStatus !== "restored"
		) {
			const promptId = `retired-codex-draft-${createHash("sha256")
				.update(JSON.stringify([input.workspaceId, input.taskId, input.nativeSessionId, basename(path)]))
				.digest("hex")}`;
			const snapshot = await mutateWorkspacePromptLibrary(input.workspaceId, {
				kind: "upsert_prompt",
				promptId,
				scope: "task",
				taskId: input.taskId,
				text: capturedDraftText,
				origin: "terminal_stash_from_retired_codex_configuration",
				leaveExistingPromptUnchanged: true,
			});
			if (snapshot.taskScopedPromptsByTaskId[input.taskId]?.some((prompt) => prompt.id === promptId)) {
				assertOwnedRetainedInputPath(path);
				await lockedFileSystem.writeJsonFileAtomic(
					recoveryReceiptPath,
					{ promptId },
					{ durable: true, fileMode: 0o600 },
				);
				documentedPromptId = promptId;
			}
		}
		pendingRecovery = {
			retainedInputRecordPath: path,
			retainedByteCount: retainedBytes.length,
			reason: documentedPromptId
				? "旧配置续接稿已保存在本任务 Prompts，原始输入与提交状态继续保留。"
				: "旧配置续接输入已保留。提交状态未确认的输入不自动重放。",
		};
	}
	return pendingRecovery;
}
