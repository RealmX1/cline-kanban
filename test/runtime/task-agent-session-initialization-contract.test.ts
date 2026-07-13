import { describe, expect, it } from "vitest";

import {
	runtimeBoardCardSchema,
	runtimeTaskAgentSessionInitializationSchema,
	runtimeTaskSessionStartRequestSchema,
} from "../../src/core/api-contract";

describe("task agent session initialization contract", () => {
	it("normalizes the legacy Codex parent session field to generalized fork initialization", () => {
		const card = runtimeBoardCardSchema.parse({
			id: "task-1",
			prompt: "Continue work",
			startInPlanMode: false,
			baseRef: "main",
			parentSessionId: "11111111-2222-3333-8444-555555555555",
			createdAt: 1,
			updatedAt: 1,
		});

		expect(card.taskAgentSessionInitialization).toEqual({
			sourceAgentId: "codex",
			sourceSessionId: "11111111-2222-3333-8444-555555555555",
			sourceSessionReuseMode: "fork_existing_session",
		});
	});

	it("rejects Cursor forks and malformed session ids", () => {
		expect(
			runtimeTaskAgentSessionInitializationSchema.safeParse({
				sourceAgentId: "cursor",
				sourceSessionId: "11111111-2222-3333-8444-555555555555",
				sourceSessionReuseMode: "fork_existing_session",
			}).success,
		).toBe(false);
		expect(
			runtimeTaskAgentSessionInitializationSchema.safeParse({
				sourceAgentId: "claude",
				sourceSessionId: "not-a-uuid",
				sourceSessionReuseMode: "resume_existing_session",
			}).success,
		).toBe(false);
	});

	it("preserves the verified source working directory for cwd-scoped agents", () => {
		expect(
			runtimeTaskAgentSessionInitializationSchema.parse({
				sourceAgentId: "claude",
				sourceSessionId: "11111111-2222-3333-8444-555555555555",
				sourceSessionReuseMode: "resume_existing_session",
				sourceSessionWorkingDirectoryPath: "/workspace/repository",
			}),
		).toMatchObject({ sourceSessionWorkingDirectoryPath: "/workspace/repository" });
	});

	it("rejects a start request whose selected agent differs from its source agent", () => {
		const result = runtimeTaskSessionStartRequestSchema.safeParse({
			taskId: "task-1",
			prompt: "Continue work",
			baseRef: "main",
			agentId: "codex",
			taskAgentSessionInitialization: {
				sourceAgentId: "claude",
				sourceSessionId: "11111111-2222-3333-8444-555555555555",
				sourceSessionReuseMode: "resume_existing_session",
			},
		});
		expect(result.success).toBe(false);
	});
});
