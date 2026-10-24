import { z } from "zod";
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import { withRunningCodexAppServerControlSocketConnection } from "../rvf-automatic-closeout/codex-app-server-request-connection";
import { buildTerminalNativeConversationIdentityForAsynchronousWriteValidation } from "./terminal-native-conversation-write-target-identity";

type CodexNativeConnectionRetryContinuationReadiness =
	| { outcome: "ready_for_terminal_write"; nativeTurnId: string }
	| { outcome: "deferred_before_terminal_write" | "target_invalidated" };

const loadedPageSchema = z.object({ data: z.array(z.string()), nextCursor: z.string().nullable().optional() });
const latestTurnPageSchema = z.object({
	data: z.array(z.object({ id: z.string(), status: z.string() })),
});

export async function inspectCodexNativeConnectionRetryContinuationReadiness(input: {
	summary: RuntimeTaskSessionSummary;
	getCurrentSummary: () => RuntimeTaskSessionSummary | null;
	requiredNativeTurnId?: string;
}): Promise<CodexNativeConnectionRetryContinuationReadiness> {
	const { summary } = input;
	const identity = summary.agentNativeConversationSessionIdentity;
	const endpoint = summary.codexNativeSessionControlEndpoint ? { ...summary.codexNativeSessionControlEndpoint } : null;
	const nativeSessionId = identity?.nativeSessionId;
	const targetIdentity = buildTerminalNativeConversationIdentityForAsynchronousWriteValidation(summary);
	const targetIsCurrent = () => {
		const current = input.getCurrentSummary();
		return (
			current !== null &&
			buildTerminalNativeConversationIdentityForAsynchronousWriteValidation(current) === targetIdentity
		);
	};
	if (!endpoint || !nativeSessionId || identity?.sourceAgentId !== "codex" || summary.agentId !== "codex")
		return { outcome: "deferred_before_terminal_write" };
	if (
		endpoint.conversationSessionId !== summary.taskId ||
		endpoint.runtimeSessionIncarnationId !== summary.runtimeSessionIncarnationId
	)
		return { outcome: "target_invalidated" };
	try {
		const result = await withRunningCodexAppServerControlSocketConnection(
			async (port) => {
				let cursor: string | null = null;
				const seen = new Set<string>();
				let loaded = false;
				do {
					const page = loadedPageSchema.parse(await port.request("thread/loaded/list", { cursor, limit: 100 }));
					if (!targetIsCurrent()) return { outcome: "target_invalidated" } as const;
					loaded = page.data.includes(nativeSessionId);
					cursor = page.nextCursor ?? null;
					if (cursor && seen.has(cursor)) return { outcome: "deferred_before_terminal_write" } as const;
					if (cursor) seen.add(cursor);
				} while (!loaded && cursor);
				if (!loaded) return { outcome: "deferred_before_terminal_write" } as const;
				const page = latestTurnPageSchema.parse(
					await port.request("thread/turns/list", {
						threadId: nativeSessionId,
						cursor: null,
						limit: 1,
						sortDirection: "desc",
						itemsView: "summary",
					}),
				);
				const turn = page.data[0];
				if (!turn) return { outcome: "deferred_before_terminal_write" } as const;
				if (input.requiredNativeTurnId && turn.id !== input.requiredNativeTurnId)
					return { outcome: "target_invalidated" } as const;
				if (turn.status === "failed")
					return { outcome: "ready_for_terminal_write", nativeTurnId: turn.id } as const;
				if (turn.status === "completed" || turn.status === "interrupted")
					return { outcome: "target_invalidated" } as const;
				return { outcome: "deferred_before_terminal_write" } as const;
			},
			{ socketPath: endpoint.socketPath },
		);
		return targetIsCurrent() ? result : { outcome: "target_invalidated" };
	} catch {
		return { outcome: targetIsCurrent() ? "deferred_before_terminal_write" : "target_invalidated" };
	}
}
