import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerRequestPort } from "../../../src/codex-native-session-protocol/codex-native-conversation-history";
import { runtimeTaskSessionSummarySchema } from "../../../src/core/api-contract";
import { readTaskSessionNativeConversationIdentityFromOwnedCodexControl } from "../../../src/terminal/task-session-native-conversation-identity-recovery";

const controlConnection = vi.hoisted(() =>
	vi.fn<(operation: (port: CodexAppServerRequestPort) => Promise<unknown>) => Promise<unknown>>(),
);
vi.mock("../../../src/codex-native-session-protocol/codex-app-server-control-socket-request-connection", () => ({
	withRunningCodexAppServerControlSocketConnection: controlConnection,
}));

afterEach(() => controlConnection.mockReset());

describe("任务会话的独享原生控制面补证", () => {
	it.each([
		{ loaded: ["child"], cwd: "/isolated/worktree", expected: "child" },
		{ loaded: ["parent", "child"], cwd: "/isolated/worktree", expected: "child" },
		{ loaded: ["parent"], cwd: "/isolated/worktree", expected: null },
		{ loaded: ["child", "unknown-other"], cwd: "/isolated/worktree", expected: null },
		{ loaded: ["child"], cwd: "/other-worktree", expected: null },
		{ loaded: ["child"], cwd: "/isolated/worktree", expected: null, additionalLoadedPage: ["unknown-other"] },
	])("候选 $loaded，目录 $cwd：只接受唯一且归属正确的独立子身份", async (scenario) => {
		const { loaded, cwd, expected } = scenario;
		const additionalLoadedPage = "additionalLoadedPage" in scenario ? scenario.additionalLoadedPage : null;
		let loadedPageNumber = 0;
		const request = vi.fn(async (method: string) =>
			method === "thread/loaded/list"
				? {
						data: loadedPageNumber++ === 0 ? loaded : additionalLoadedPage,
						nextCursor: loadedPageNumber === 1 && additionalLoadedPage ? "remaining-native-threads" : null,
					}
				: { thread: { id: "child", cwd, path: "/isolated/rollout-child.jsonl" } },
		);
		controlConnection.mockImplementation((operation) => operation({ request }));
		const summary = runtimeTaskSessionSummarySchema.parse({
			taskId: "side-session",
			agentId: "codex",
			state: "awaiting_review",
			reviewReason: "hook",
			pid: 42,
			workspacePath: "/isolated/worktree",
			startedAt: 1,
			updatedAt: 1,
			lastOutputAt: null,
			exitCode: null,
			runtimeSessionIncarnationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
			codexNativeSessionControlEndpoint: {
				socketPath: "/isolated/owned.sock",
				workspaceId: "isolated-workspace",
				conversationSessionId: "side-session",
				runtimeSessionIncarnationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
			},
			taskConversationSessionNativeIdentityRecovery: {
				runtimeSessionIncarnationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
				forkSourceNativeSessionId: "parent",
				resumeRequestedAtMs: null,
				consecutiveUnchangedProbeCount: 0,
				lastEvidenceFingerprint: null,
				nextProbeAtMs: null,
			},
		});
		const result = await readTaskSessionNativeConversationIdentityFromOwnedCodexControl(summary);
		expect(result?.nativeSessionId ?? null).toBe(expected);
		expect(
			request.mock.calls
				.map(([method]) => method)
				.every((method) => ["thread/loaded/list", "thread/read"].includes(method)),
		).toBe(true);
		await readTaskSessionNativeConversationIdentityFromOwnedCodexControl({
			...summary,
			runtimeSessionIncarnationId: "different-incarnation",
		});
		expect(controlConnection).toHaveBeenCalledOnce();
	});
});
