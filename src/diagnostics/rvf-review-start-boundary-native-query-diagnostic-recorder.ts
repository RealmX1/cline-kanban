import type { CodexNativeControlSocketRequestDiagnostic } from "../rvf-automatic-closeout/codex-app-server-control-socket-request-connection";
import {
	appendDiagnosticEventToRotatingJsonlJournal,
	type DiagnosticEventJournalChannel,
	type DiagnosticEventJournalPayload,
} from "./rotating-jsonl-diagnostic-event-journal";

export function createRvfReviewStartBoundaryNativeQueryDiagnosticRecorder(
	context: {
		workspaceId: string;
		taskId: string;
		requestNonce: string;
	},
	appendJournalEvent: (
		channel: DiagnosticEventJournalChannel,
		payload: DiagnosticEventJournalPayload,
	) => void = appendDiagnosticEventToRotatingJsonlJournal,
) {
	let identity: {
		conversationSessionId: string;
		runtimeSessionIncarnationId: string | null;
		nativeSessionId: string;
	} | null = null;
	const record = (payload: DiagnosticEventJournalPayload) => {
		try {
			appendJournalEvent("codex-native-control-socket-request-diagnostic", {
				...payload,
				...context,
				...identity,
				nodeVersion: process.version,
				runtimeExecutablePath: process.execPath,
				// 磁盘 bundle 可被其它构建替换，不能冒充进程实际加载的代码版本。
				loadedRuntimeBuildIdentity: "unknown",
			});
		} catch {}
	};
	return {
		bindIdentity: (observedIdentity: NonNullable<typeof identity>) => {
			identity = { ...observedIdentity };
		},
		onDiagnostic: (diagnostic: CodexNativeControlSocketRequestDiagnostic) => record({ ...diagnostic }),
		finishObservation: (
			outcome: "observation_verified" | "binding_invalidated" | "capability_unavailable" | "observation_failed",
		) => record({ event: "observation_finished", outcome }),
	};
}
