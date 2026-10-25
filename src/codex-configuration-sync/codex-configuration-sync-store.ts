import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";
import {
	type CodexConfigurationPropagationTarget,
	type CodexConfigurationWriterBinding,
	codexConfigurationPropagationTargetSchema,
	codexConfigurationWriterBindingSchema,
} from "../core/codex-configuration-sync-contract";
import { getRuntimeHomePath } from "../state/runtime-home-path";
import type { CodexConfigurationFields, CodexConfigurationFieldValue } from "./codex-configuration-field-projection";

export interface StoredCodexConfigurationWriter {
	binding: CodexConfigurationWriterBinding;
	fileNames: string[];
	launchBaselineFields: CodexConfigurationFields;
	mergeBaselineFields: CodexConfigurationFields;
	lastObservedFields: CodexConfigurationFields;
	overrideKeyPaths: string[];
	nativeBinaryVersion: string | null;
	nativeExecutableRealPath?: string | null;
	nativeExecutableIdentityDigest?: string | null;
	retiredAt?: number;
}
export interface StoredCodexConfigurationSource {
	home: string;
	version: number;
	fields: CodexConfigurationFields;
	observedUserFields: CodexConfigurationFields;
}
export interface StoredCodexConfigurationChange {
	changeId: string;
	version: number;
	sourceWriterId: string;
	sourceIdentity: string;
	fieldKey: string;
	previous?: CodexConfigurationFieldValue;
	value?: CodexConfigurationFieldValue;
	sharedValueAtConflict?: CodexConfigurationFieldValue;
	observedAt: number;
	mergeStatus:
		| "shared_default_updated"
		| "conflict"
		| "kept_shared_value"
		| "target_conflict_source_change_selected"
		| "target_conflict_target_value_kept";
	acknowledgedAt: number | null;
	targets: Array<
		CodexConfigurationPropagationTarget & {
			evidenceFingerprint?: string;
			writeSubmissionStartedAt?: number;
			expectedNativeVersion?: string;
			startupVerificationAttemptCount?: number;
			startupVerificationEvidenceFingerprint?: string;
			conflictHistory?: Array<{ observedAt: number; value?: CodexConfigurationFieldValue; resolution?: string }>;
		}
	>;
}
export interface CodexConfigurationSyncStore {
	schemaVersion: 1;
	revision: number;
	sources: Record<string, StoredCodexConfigurationSource>;
	writers: Record<string, StoredCodexConfigurationWriter>;
	changes: StoredCodexConfigurationChange[];
	mutationReceipts: Record<string, { requestDigest: string; changeId: string }>;
	observationProblem: string | null;
}

const fieldSchema = z.object({ value: z.unknown(), definitionDigest: z.string().optional() });
const fieldsSchema = z.record(z.string(), fieldSchema);
const storeSchema = z.object({
	schemaVersion: z.literal(1),
	revision: z.number().int().nonnegative(),
	sources: z.record(
		z.string(),
		z.object({ home: z.string(), version: z.number(), fields: fieldsSchema, observedUserFields: fieldsSchema }),
	),
	writers: z.record(
		z.string(),
		z.object({
			binding: codexConfigurationWriterBindingSchema,
			fileNames: z.array(z.string()),
			launchBaselineFields: fieldsSchema,
			mergeBaselineFields: fieldsSchema,
			lastObservedFields: fieldsSchema,
			overrideKeyPaths: z.array(z.string()),
			nativeBinaryVersion: z.string().nullable(),
			nativeExecutableRealPath: z.string().nullable().optional(),
			nativeExecutableIdentityDigest: z.string().nullable().optional(),
			retiredAt: z.number().optional(),
		}),
	),
	changes: z.array(
		z.object({
			changeId: z.string(),
			version: z.number(),
			sourceWriterId: z.string(),
			sourceIdentity: z.string(),
			fieldKey: z.string(),
			previous: fieldSchema.optional(),
			value: fieldSchema.optional(),
			sharedValueAtConflict: fieldSchema.optional(),
			observedAt: z.number(),
			mergeStatus: z.enum([
				"shared_default_updated",
				"conflict",
				"kept_shared_value",
				"target_conflict_source_change_selected",
				"target_conflict_target_value_kept",
			]),
			acknowledgedAt: z.number().nullable(),
			targets: z.array(
				codexConfigurationPropagationTargetSchema.extend({
					evidenceFingerprint: z.string().optional(),
					writeSubmissionStartedAt: z.number().optional(),
					expectedNativeVersion: z.string().optional(),
					startupVerificationAttemptCount: z.number().optional(),
					startupVerificationEvidenceFingerprint: z.string().optional(),
					conflictHistory: z
						.array(
							z.object({
								observedAt: z.number(),
								value: fieldSchema.optional(),
								resolution: z.string().optional(),
							}),
						)
						.optional(),
				}),
			),
		}),
	),
	mutationReceipts: z.record(z.string(), z.object({ requestDigest: z.string(), changeId: z.string() })),
	observationProblem: z.string().nullable(),
});
export const getCodexConfigurationSyncDirectory = () =>
	join(getRuntimeHomePath(), "codex-configuration-writer-bindings-and-sync");

export async function readCodexConfigurationSyncStore(): Promise<CodexConfigurationSyncStore> {
	try {
		return storeSchema.parse(
			JSON.parse(
				await readFile(join(getCodexConfigurationSyncDirectory(), "configuration-sync-state.json"), "utf8"),
			),
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return {
			schemaVersion: 1,
			revision: 0,
			sources: {},
			writers: {},
			changes: [],
			mutationReceipts: {},
			observationProblem: null,
		};
	}
}

// 所有共享决定只有这一处写入，活配置文件始终交给原 app-server。
export async function mutateCodexConfigurationSyncStore<T>(
	operation: (store: CodexConfigurationSyncStore) => Promise<T> | T,
) {
	const directory = getCodexConfigurationSyncDirectory();
	await mkdir(directory, { recursive: true, mode: 0o700 });
	if ((await lstat(directory)).isSymbolicLink()) throw new Error("Codex 配置绑定目录被替换，已保留现场。");
	const release = await lockfile.lock(directory, {
		realpath: false,
		retries: { retries: 30, minTimeout: 20, maxTimeout: 150 },
	});
	const pendingPath = join(directory, `${randomUUID()}.pending-configuration-sync-state.json`);
	try {
		const store = await readCodexConfigurationSyncStore();
		const result = await operation(store);
		const pendingFile = await open(pendingPath, "wx", 0o600);
		try {
			await pendingFile.writeFile(JSON.stringify(store));
			await pendingFile.sync();
		} finally {
			await pendingFile.close();
		}
		await rename(pendingPath, join(directory, "configuration-sync-state.json"));
		if (process.platform !== "win32") {
			const directoryHandle = await open(directory, "r");
			try {
				await directoryHandle.sync();
			} finally {
				await directoryHandle.close();
			}
		}
		return result;
	} finally {
		await rm(pendingPath, { force: true });
		await release();
	}
}
