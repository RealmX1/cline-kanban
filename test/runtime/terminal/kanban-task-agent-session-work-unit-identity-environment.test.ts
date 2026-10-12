import { describe, expect, it } from "vitest";

import {
	collectKanbanCliInvocationEnvironmentActorClaims,
	KANBAN_CLI_INVOCATION_ENVIRONMENT_VARIABLE_NAMES_CLAIMED_FOR_ACTOR_RESOLUTION,
} from "../../../src/core/kanban-cli-invocation-environment-actor-claims";
import {
	buildKanbanTaskAgentSessionWorkUnitIdentityEnvironment,
	KANBAN_RUNTIME_INHERITED_WORK_UNIT_IDENTITY_ENVIRONMENT_VARIABLE_NAMES_TO_SCRUB_AT_START,
	scrubInheritedWorkUnitIdentityEnvironmentVariablesFromKanbanRuntimeProcess,
} from "../../../src/terminal/kanban-task-agent-session-work-unit-identity-environment";

describe("kanban task agent session work-unit identity environment", () => {
	it("injects every variable the CLI claims for card actor resolution", () => {
		const environment = buildKanbanTaskAgentSessionWorkUnitIdentityEnvironment({
			workspaceTaskId: "ab12c",
			kanbanTaskConversationSessionId: "ab12c",
			workspaceId: "workspace-1",
			workspaceRepositoryPath: "/repo",
		});
		const claims = collectKanbanCliInvocationEnvironmentActorClaims({
			environment,
			invokingKanbanCliCodeVersion: "0.0.0",
			invokingProcessWorkingDirectory: null,
		});
		expect(claims.claimedEnvironmentVariableValuesByName).toEqual({
			KANBAN_TASK_ID: "ab12c",
			KANBAN_HOOK_WORKSPACE_ID: "workspace-1",
			KANBAN_TASK_CONVERSATION_SESSION_ID: "ab12c",
			KANBAN_PROJECT_PATH: "/repo",
		});
	});

	it("scrubs inherited identity variables from the runtime process but keeps runtime configuration", () => {
		const environment: Record<string, string | undefined> = {
			KANBAN_TASK_ID: "stale-card",
			KANBAN_HOOK_WORKSPACE_ID: "stale-workspace",
			CLAUDE_CODE_SESSION_ID: "stale-standalone-session",
			KANBAN_RUNTIME_PORT: "3484",
			KANBAN_INTER_WORK_UNIT_RELATION_LEDGER_STORAGE_ROOT: "/tmp/ledger",
		};
		const scrubbed = scrubInheritedWorkUnitIdentityEnvironmentVariablesFromKanbanRuntimeProcess(environment);
		expect(scrubbed.sort()).toEqual(["CLAUDE_CODE_SESSION_ID", "KANBAN_HOOK_WORKSPACE_ID", "KANBAN_TASK_ID"]);
		expect(environment).toEqual({
			KANBAN_RUNTIME_PORT: "3484",
			KANBAN_INTER_WORK_UNIT_RELATION_LEDGER_STORAGE_ROOT: "/tmp/ledger",
		});
	});

	it("scrubs at least every variable the CLI would claim, so no stale identity leaks into in-process tool calls", () => {
		const scrubbedNames = new Set<string>(
			KANBAN_RUNTIME_INHERITED_WORK_UNIT_IDENTITY_ENVIRONMENT_VARIABLE_NAMES_TO_SCRUB_AT_START,
		);
		for (const claimedName of KANBAN_CLI_INVOCATION_ENVIRONMENT_VARIABLE_NAMES_CLAIMED_FOR_ACTOR_RESOLUTION) {
			expect(scrubbedNames.has(claimedName)).toBe(true);
		}
	});
});
