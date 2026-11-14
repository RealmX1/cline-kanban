import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "../state/runtime-home-path";
import { RUNTIME_LOADED_ENTRYPOINT_SHA256 } from "../state/runtime-loaded-entrypoint-identity";
import { getThisRuntimeProcessInstanceId } from "../state/runtime-process-instance-heartbeat-registry";

export const hostedSessionRuntimeAdoptionAcceptanceReceiptSchema = z.strictObject({
	schemaVersion: z.literal(1),
	workspaceId: z.string().min(1),
	conversationSessionId: z.string().min(1),
	runtimeSessionIncarnationId: z.string().nullable(),
	nativeConversationSessionId: z.string().nullable(),
	hostSocketPath: z.string().min(1),
	hostedSessionKey: z.string().min(1),
	sessionProcessId: z.number().int().positive(),
	sessionProcessStartedAtEpochMs: z.number(),
	acceptingRuntimeProcessInstanceId: z.string().min(1),
	acceptingRuntimeProcessId: z.number().int().positive(),
	acceptingRuntimeEntrypointSha256: z.string().nullable(),
	acceptedAtEpochMs: z.number(),
	summarySource: z.string().min(1),
});
export type HostedSessionRuntimeAdoptionAcceptanceReceipt = z.infer<
	typeof hostedSessionRuntimeAdoptionAcceptanceReceiptSchema
>;

export function hostedSessionRuntimeAdoptionAcceptanceReceiptDirectory(runtimeHome = getRuntimeHomePath()): string {
	return join(runtimeHome, "hosted-session-runtime-adoption-acceptance-receipts");
}

export async function persistHostedSessionRuntimeAdoptionAcceptanceReceipt(
	input: Omit<
		HostedSessionRuntimeAdoptionAcceptanceReceipt,
		| "schemaVersion"
		| "acceptingRuntimeProcessInstanceId"
		| "acceptingRuntimeProcessId"
		| "acceptedAtEpochMs"
		| "acceptingRuntimeEntrypointSha256"
	>,
): Promise<string> {
	const receipt = hostedSessionRuntimeAdoptionAcceptanceReceiptSchema.parse({
		...input,
		schemaVersion: 1,
		acceptingRuntimeEntrypointSha256: RUNTIME_LOADED_ENTRYPOINT_SHA256,
		acceptingRuntimeProcessInstanceId: getThisRuntimeProcessInstanceId(),
		acceptingRuntimeProcessId: process.pid,
		acceptedAtEpochMs: Date.now(),
	});
	const key = createHash("sha256")
		.update(
			JSON.stringify([
				receipt.acceptingRuntimeProcessInstanceId,
				receipt.workspaceId,
				receipt.conversationSessionId,
				receipt.hostedSessionKey,
				receipt.sessionProcessStartedAtEpochMs,
			]),
		)
		.digest("hex");
	const directory = hostedSessionRuntimeAdoptionAcceptanceReceiptDirectory();
	await mkdir(directory, { recursive: true });
	const path = join(directory, `${key}.json`);
	return lockedFileSystem.withLock({ path }, async () => {
		try {
			const original = hostedSessionRuntimeAdoptionAcceptanceReceiptSchema.parse(
				JSON.parse(await readFile(path, "utf8")),
			);
			if (
				JSON.stringify({ ...original, acceptedAtEpochMs: 0 }) !==
				JSON.stringify({ ...receipt, acceptedAtEpochMs: 0 })
			)
				throw new Error("历史接管接受回执身份冲突");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			await lockedFileSystem.writeJsonFileAtomic(path, receipt, { durable: true, fileMode: 0o600, lock: null });
		}
		return path;
	});
}

export function hostedSessionAdoptionReceiptMatchesDeploymentRestart(input: {
	receipt: HostedSessionRuntimeAdoptionAcceptanceReceipt;
	originalSession: Record<string, unknown>;
	candidateEntrypointSha256: string;
	restartIntentAtEpochMs: number;
	previousRuntimeProcessId: number | null;
}): boolean {
	const { receipt, originalSession: original } = input;
	return (
		receipt.workspaceId === original.workspaceId &&
		receipt.conversationSessionId === original.conversationSessionId &&
		receipt.hostSocketPath === original.hostSocketPath &&
		receipt.hostedSessionKey === original.hostedSessionKey &&
		receipt.sessionProcessId === original.processId &&
		receipt.sessionProcessStartedAtEpochMs === original.processStartedAtEpochMs &&
		receipt.runtimeSessionIncarnationId === original.runtimeSessionIncarnationId &&
		receipt.nativeConversationSessionId === original.nativeConversationSessionId &&
		receipt.acceptingRuntimeProcessId !== input.previousRuntimeProcessId &&
		receipt.acceptingRuntimeEntrypointSha256 === input.candidateEntrypointSha256 &&
		receipt.acceptedAtEpochMs >= input.restartIntentAtEpochMs
	);
}
