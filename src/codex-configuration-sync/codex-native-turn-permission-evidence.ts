import { open, stat } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import {
	parseTranscriptJsonRecord,
	readTranscriptRecord,
	splitCompleteJsonLines,
} from "../agent-session-history/bounded-agent-transcript-reader";
import { transcriptMetadataMatchesNativeConversationIdentity } from "../agent-session-history/persisted-agent-transcript-last-conversation-progress-probe";
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import { type CodexConfigurationFields, configurationFieldAddress } from "./codex-configuration-field-projection";

export interface CodexNativeTurnPermissionTranscriptFingerprint {
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
}

const transcriptFingerprintByEvidence = new WeakMap<
	CodexConfigurationFields,
	CodexNativeTurnPermissionTranscriptFingerprint
>();

export function codexNativeTurnPermissionTranscriptFingerprintOf(
	evidence: CodexConfigurationFields,
): CodexNativeTurnPermissionTranscriptFingerprint | null {
	return transcriptFingerprintByEvidence.get(evidence) ?? null;
}

export async function codexNativeTurnPermissionTranscriptFingerprintStillCurrent(
	transcriptPath: string,
	fingerprint: CodexNativeTurnPermissionTranscriptFingerprint,
): Promise<boolean> {
	try {
		const current = await stat(transcriptPath);
		return (
			current.isFile() &&
			current.dev === fingerprint.dev &&
			current.ino === fingerprint.ino &&
			current.size === fingerprint.size &&
			current.mtimeMs === fingerprint.mtimeMs
		);
	} catch {
		return false;
	}
}

// 文件中的选择不证明当前线程采用；只读取变更之后、身份绑定的实际原生回合上下文。
export async function readCodexNativeTurnPermissionEvidence(input: {
	summary: RuntimeTaskSessionSummary;
	configurationChangedAtMs: number;
	selectedFields: CodexConfigurationFields;
}): Promise<CodexConfigurationFields | null> {
	const identity = input.summary.agentNativeConversationSessionIdentity;
	const path = identity?.transcriptPath;
	if (input.summary.agentId !== "codex" || identity?.sourceAgentId !== "codex" || !path) return null;
	try {
		const before = await stat(path);
		if (!before.isFile() || !before.size) return null;
		const handle = await open(path, "r");
		let headLines: string[], contextLines: string[];
		try {
			const maximumReadBytes = 2 * 1024 * 1024;
			const headBytes = Math.min(
				before.size,
				before.size <= maximumReadBytes ? maximumReadBytes : maximumReadBytes / 2,
			);
			const head = Buffer.alloc(headBytes);
			await handle.read(head, 0, head.length, 0);
			headLines = splitCompleteJsonLines(head, "file_start");
			contextLines = headLines;
			if (before.size > maximumReadBytes) {
				const tail = Buffer.alloc(maximumReadBytes / 2);
				await handle.read(tail, 0, tail.length, before.size - tail.length);
				contextLines = splitCompleteJsonLines(tail, "file_end");
			}
		} finally {
			await handle.close();
		}
		const metadata = headLines.map(parseTranscriptJsonRecord).find((record) => record?.type === "session_meta");
		const origin = readTranscriptRecord(metadata?.payload);
		if (
			!metadata ||
			!transcriptMetadataMatchesNativeConversationIdentity(identity, metadata) ||
			origin?.cwd !== input.summary.workspacePath ||
			!["cli", "vscode", "appServer"].includes(String(origin?.source))
		)
			return null;
		let context: Record<string, unknown> | null = null;
		let contextAtMs = 0;
		for (const line of contextLines) {
			const record = parseTranscriptJsonRecord(line);
			const payload = readTranscriptRecord(record?.payload);
			if (
				record?.type === "turn_context" &&
				payload &&
				!record.isSidechain &&
				!record.synthetic &&
				!record.isMeta &&
				!payload.isSidechain &&
				!payload.synthetic &&
				!payload.isMeta
			) {
				context = payload;
				contextAtMs = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : 0;
			}
		}
		const after = await stat(path);
		if (
			!context ||
			!Number.isFinite(contextAtMs) ||
			contextAtMs < input.configurationChangedAtMs ||
			contextAtMs > Date.now() + 2_000 ||
			before.dev !== after.dev ||
			before.ino !== after.ino ||
			before.size !== after.size ||
			before.mtimeMs !== after.mtimeMs
		)
			return null;
		const sandboxType = readTranscriptRecord(context.sandbox_policy)?.type;
		const sandboxMode =
			sandboxType === "danger-full-access" || sandboxType === "dangerFullAccess"
				? "danger-full-access"
				: sandboxType === "workspace-write" || sandboxType === "workspaceWrite"
					? "workspace-write"
					: sandboxType === "read-only" || sandboxType === "readOnly"
						? "read-only"
						: null;
		if (!sandboxMode || !context.approval_policy) return null;
		const approvalKey = JSON.stringify(["config.toml", "approval_policy"]);
		const sandboxKey = JSON.stringify(["config.toml", "sandbox_mode"]);
		const usesNamedPermissions = Object.keys(input.selectedFields).some(
			(key) => configurationFieldAddress(key).keyPath[0] === "permissions",
		);
		if (
			!usesNamedPermissions &&
			((input.selectedFields[approvalKey] &&
				!isDeepStrictEqual(input.selectedFields[approvalKey].value, context.approval_policy)) ||
				(input.selectedFields[sandboxKey] && input.selectedFields[sandboxKey].value !== sandboxMode))
		)
			return null;
		const evidence = {
			[approvalKey]: { value: context.approval_policy },
			[sandboxKey]: { value: sandboxMode },
		};
		// 发布时用这次读取结束的文件身份判断转录是否又追加了更新的回合，避免旧证据覆盖新权限。
		transcriptFingerprintByEvidence.set(evidence, {
			dev: after.dev,
			ino: after.ino,
			size: after.size,
			mtimeMs: after.mtimeMs,
		});
		return evidence;
	} catch {
		return null;
	}
}
