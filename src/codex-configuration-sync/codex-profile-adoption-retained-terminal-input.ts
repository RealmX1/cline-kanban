import { randomUUID } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { runtimeAgentConversationPromptSubmissionAcceptanceSchema } from "../core/api-contract";
import { getCodexConfigurationSyncDirectory } from "./codex-configuration-sync-store";

const retainedTerminalInputSchema = z.object({
	schemaVersion: z.literal(1),
	workspaceId: z.string(),
	conversationSessionId: z.string(),
	nativeSessionId: z.string(),
	profileId: z.string(),
	status: z.enum(["capturing", "restore_submission_started", "restored"]),
	automaticProcessReplacementContinuationStatus: z
		.enum(["pending_automatic_start", "started", "cancelled_by_explicit_stop"])
		.optional(),
	automaticProcessReplacementEvidenceFingerprint: z.string().optional(),
	automaticProcessReplacementAttemptCount: z.number().int().nonnegative().optional(),
	bytesBase64: z.string(),
	capturedDraftText: z.string().optional(),
	capturedFromRuntimeSessionIncarnationId: z.string().optional(),
	capturedDraftRestoreStatus: z.enum(["pending", "submission_started", "restored"]).optional(),
	draftRestoreVerificationEvidenceFingerprint: z.string().optional(),
	draftRestoreVerificationAttemptCount: z.number().int().nonnegative().optional(),
	updatedAtMs: z.number(),
	acceptanceCandidate: runtimeAgentConversationPromptSubmissionAcceptanceSchema.optional(),
});
export type CodexProfileAdoptionRetainedTerminalInput = z.infer<typeof retainedTerminalInputSchema>;
const retainedInputDirectory = () =>
	join(getCodexConfigurationSyncDirectory(), "retained-terminal-input-during-profile-adoption");

function assertOwnedRetainedInputPath(path: string) {
	if (
		dirname(path) !== retainedInputDirectory() ||
		lstatSync(retainedInputDirectory()).isSymbolicLink() ||
		!/^[a-f\d-]+\.json$/.test(basename(path)) ||
		!lstatSync(path).isFile()
	)
		throw new Error("profile 续接输入保留记录的归属不符。");
}

export function saveCodexProfileAdoptionRetainedInput(path: string, record: CodexProfileAdoptionRetainedTerminalInput) {
	const pendingPath = `${path}.${randomUUID()}.pending`;
	const descriptor = openSync(pendingPath, "wx", 0o600);
	try {
		writeFileSync(descriptor, JSON.stringify(retainedTerminalInputSchema.parse(record)));
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
	renameSync(pendingPath, path);
	if (process.platform !== "win32") {
		const directoryHandle = openSync(dirname(path), "r");
		try {
			fsyncSync(directoryHandle);
		} finally {
			closeSync(directoryHandle);
		}
	}
}

export function createCodexProfileAdoptionRetainedInput(
	input: Pick<
		CodexProfileAdoptionRetainedTerminalInput,
		| "workspaceId"
		| "conversationSessionId"
		| "nativeSessionId"
		| "profileId"
		| "capturedDraftText"
		| "capturedFromRuntimeSessionIncarnationId"
		| "capturedDraftRestoreStatus"
	>,
) {
	mkdirSync(retainedInputDirectory(), { recursive: true, mode: 0o700 });
	if (lstatSync(retainedInputDirectory()).isSymbolicLink())
		throw new Error("profile 续接输入目录被替换，未停止原会话。");
	const path = join(retainedInputDirectory(), `${randomUUID()}.json`);
	saveCodexProfileAdoptionRetainedInput(path, {
		...input,
		schemaVersion: 1,
		status: "capturing",
		automaticProcessReplacementContinuationStatus: "pending_automatic_start",
		bytesBase64: "",
		updatedAtMs: Date.now(),
	});
	return path;
}

export function readCodexProfileAdoptionRetainedInput(path: string) {
	assertOwnedRetainedInputPath(path);
	return retainedTerminalInputSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function appendCodexProfileAdoptionRetainedInput(path: string, bytes: Buffer) {
	const record = readCodexProfileAdoptionRetainedInput(path);
	if (record.status !== "capturing") throw new Error("此轮输入保留已进入恢复阶段，未重复追加。");
	record.bytesBase64 = Buffer.concat([Buffer.from(record.bytesBase64, "base64"), bytes]).toString("base64");
	record.updatedAtMs = Date.now();
	saveCodexProfileAdoptionRetainedInput(path, record);
}

export function listUnrestoredCodexProfileAdoptionRetainedInput() {
	try {
		return readdirSync(retainedInputDirectory())
			.filter((name) => /^[a-f\d-]+\.json$/.test(name))
			.flatMap((name) => {
				const path = join(retainedInputDirectory(), name);
				const record = readCodexProfileAdoptionRetainedInput(path);
				return record.status === "restored" ? [] : [{ path, record }];
			});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}
