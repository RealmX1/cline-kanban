import { describe, expect, it } from "vitest";

import { buildCliTaskSessionStartRequest, buildTaskAgentSessionInitialization } from "../../../src/commands/task";
import type { RuntimeTaskAgentSessionInitialization } from "../../../src/core/api-contract";

const CLAUDE_SESSION_INITIALIZATION: RuntimeTaskAgentSessionInitialization = {
	sourceAgentId: "claude",
	sourceSessionId: "11111111-2222-4333-8444-555555555555",
	sourceSessionReuseMode: "resume_existing_session",
};

describe("buildTaskAgentSessionInitialization for task update", () => {
	it("keeps the existing initialization when neither the agent nor initialization arguments change", () => {
		expect(
			buildTaskAgentSessionInitialization({
				agentId: undefined,
				sourceSessionId: undefined,
				sourceSessionReuseMode: undefined,
				existingTaskAgentId: "claude",
				existing: CLAUDE_SESSION_INITIALIZATION,
			}),
		).toBeUndefined();
	});

	it("keeps the existing initialization when the explicit agent still matches its source", () => {
		expect(
			buildTaskAgentSessionInitialization({
				agentId: "claude",
				sourceSessionId: undefined,
				sourceSessionReuseMode: undefined,
				existingTaskAgentId: "claude",
				existing: CLAUDE_SESSION_INITIALIZATION,
			}),
		).toBeUndefined();
	});

	it("clears the existing initialization when an explicit agent no longer matches its source", () => {
		expect(
			buildTaskAgentSessionInitialization({
				agentId: "codex",
				sourceSessionId: undefined,
				sourceSessionReuseMode: undefined,
				existingTaskAgentId: "claude",
				existing: CLAUDE_SESSION_INITIALIZATION,
			}),
		).toBeNull();
	});

	it("clears the existing initialization when the explicit agent is reset to the workspace default", () => {
		expect(
			buildTaskAgentSessionInitialization({
				agentId: null,
				sourceSessionId: undefined,
				sourceSessionReuseMode: undefined,
				existingTaskAgentId: "claude",
				existing: CLAUDE_SESSION_INITIALIZATION,
			}),
		).toBeNull();
	});

	it("uses an explicitly supplied session ID when switching to another supported agent", () => {
		expect(
			buildTaskAgentSessionInitialization({
				agentId: "codex",
				sourceSessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
				sourceSessionReuseMode: "fork_existing_session",
				existingTaskAgentId: "claude",
				existing: CLAUDE_SESSION_INITIALIZATION,
			}),
		).toEqual({
			sourceAgentId: "codex",
			sourceSessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
			sourceSessionReuseMode: "fork_existing_session",
		});
	});

	it("uses the task agent for an explicit session ID when --agent-id is omitted", () => {
		expect(
			buildTaskAgentSessionInitialization({
				agentId: undefined,
				sourceSessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
				sourceSessionReuseMode: "fork_existing_session",
				existingTaskAgentId: "codex",
				existing: CLAUDE_SESSION_INITIALIZATION,
			}),
		).toEqual({
			sourceAgentId: "codex",
			sourceSessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
			sourceSessionReuseMode: "fork_existing_session",
		});
	});

	it("updates the reuse mode while retaining a matching existing session ID", () => {
		expect(
			buildTaskAgentSessionInitialization({
				agentId: undefined,
				sourceSessionId: undefined,
				sourceSessionReuseMode: "fork_existing_session",
				existingTaskAgentId: "claude",
				existing: CLAUDE_SESSION_INITIALIZATION,
			}),
		).toEqual({
			sourceAgentId: "claude",
			sourceSessionId: CLAUDE_SESSION_INITIALIZATION.sourceSessionId,
			sourceSessionReuseMode: "fork_existing_session",
		});
	});

	it("honors an explicit inherit request by clearing the initialization", () => {
		expect(
			buildTaskAgentSessionInitialization({
				agentId: "claude",
				sourceSessionId: null,
				sourceSessionReuseMode: undefined,
				existingTaskAgentId: "claude",
				existing: CLAUDE_SESSION_INITIALIZATION,
			}),
		).toBeNull();
	});

	it("rejects switching agents while only changing the old session reuse mode", () => {
		expect(() =>
			buildTaskAgentSessionInitialization({
				agentId: "codex",
				sourceSessionId: undefined,
				sourceSessionReuseMode: "fork_existing_session",
				existingTaskAgentId: "claude",
				existing: CLAUDE_SESSION_INITIALIZATION,
			}),
		).toThrow(
			"Changing the session reuse mode while switching agents also requires --agent-session-initialization-id.",
		);
	});
});

describe("buildCliTaskSessionStartRequest", () => {
	it("forwards the persisted agent session initialization into the runtime launch request", () => {
		const request = buildCliTaskSessionStartRequest({
			id: "task-1",
			title: "Continue existing Claude session",
			prompt: "Continue the implementation",
			startInPlanMode: false,
			autoReviewEnabled: false,
			autoReviewMode: "commit",
			baseRef: "main",
			agentId: "claude",
			taskAgentSessionInitialization: CLAUDE_SESSION_INITIALIZATION,
			createdAt: 1,
			updatedAt: 1,
		});

		expect(request.taskAgentSessionInitialization).toEqual(CLAUDE_SESSION_INITIALIZATION);
	});
});
