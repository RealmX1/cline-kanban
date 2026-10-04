import { describe, expect, it } from "vitest";

import {
	parseWorkUnitReferenceCommandLineArgument,
	resolveWorkUnitSelectorOfInvokingProcessEnvironment,
} from "../../src/core/work-unit-reference-command-line-argument";
import { extractPromptFirstParagraph } from "../../src/inter-work-unit-relation-ledger/work-unit-relation-neighborhood-summary-assembly";

describe("work unit reference command line argument", () => {
	it("parses bare, workspace-qualified and standalone session references", () => {
		expect(parseWorkUnitReferenceCommandLineArgument("ab12c")).toEqual({
			workUnitSelectorKind: "kanban_board_card_by_bare_task_id",
			bareTaskId: "ab12c",
		});
		expect(parseWorkUnitReferenceCommandLineArgument("cline-kanban/ab12c")).toEqual({
			workUnitSelectorKind: "kanban_board_card_by_bare_task_id",
			bareTaskId: "ab12c",
			workspaceId: "cline-kanban",
		});
		expect(parseWorkUnitReferenceCommandLineArgument("standalone:codex:019f23c6-fe74")).toEqual({
			workUnitSelectorKind: "kanban_unmanaged_standalone_agent_conversation_session",
			conversationSessionHostKanbanAgentId: "codex",
			nativeConversationSessionId: "019f23c6-fe74",
		});
		expect(() => parseWorkUnitReferenceCommandLineArgument("standalone:codex")).toThrow(/standalone:<agentId>/);
		expect(() => parseWorkUnitReferenceCommandLineArgument("cline-kanban/")).toThrow(/Invalid work unit reference/);
	});

	it("defaults the subject to the invoking task card, then to the invoking standalone agent session", () => {
		expect(
			resolveWorkUnitSelectorOfInvokingProcessEnvironment({
				KANBAN_TASK_ID: "ac29f",
				KANBAN_HOOK_WORKSPACE_ID: "cline-kanban",
				CLAUDE_CODE_SESSION_ID: "ignored-because-a-card-owns-this-process",
			}),
		).toEqual({
			workUnitSelectorKind: "kanban_board_card_by_bare_task_id",
			bareTaskId: "ac29f",
			workspaceId: "cline-kanban",
		});
		expect(resolveWorkUnitSelectorOfInvokingProcessEnvironment({ CODEX_THREAD_ID: "thread-1" })).toEqual({
			workUnitSelectorKind: "kanban_unmanaged_standalone_agent_conversation_session",
			conversationSessionHostKanbanAgentId: "codex",
			nativeConversationSessionId: "thread-1",
		});
		expect(resolveWorkUnitSelectorOfInvokingProcessEnvironment({})).toBeNull();
	});

	it("keeps only the first paragraph of a prompt for the level-one recap", () => {
		expect(extractPromptFirstParagraph("  Goal line one\nline two\n\nDetails that stay out  ")).toBe(
			"Goal line one\nline two",
		);
		expect(extractPromptFirstParagraph("   ")).toBeNull();
	});
});
