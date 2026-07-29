import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskConversationSessionsPanel } from "@/components/detail-panels/task-conversation-sessions-panel";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { LocalStorageKey } from "@/storage/local-storage-store";

const ORIGINAL_PROMPT_CARD = {
	title: "Build sessions",
	prompt: "Build sessions end to end.",
	images: undefined,
	createdAt: 1,
};

function createSessionSummary(
	taskId: string,
	overrides: Partial<RuntimeTaskSessionSummary> = {},
): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "running",
		agentId: "codex",
		workspacePath: "/tmp/worktree",
		pid: 123,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		turnOwner: "agent",
		liveness: "live",
		userTurnKind: null,
		...overrides,
	};
}

describe("TaskConversationSessionsPanel", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		window.localStorage.clear();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("shows relationships and persists an answer as read when selected", async () => {
		const mainSessionSummary = createSessionSummary("task-1", {
			latestTurnCheckpoint: { commit: "abc", ref: "HEAD", turn: 5, createdAt: 5 },
		});
		const sideSessionSummary = createSessionSummary("side-1", {
			updatedAt: 20,
			turnOwner: "user",
			liveness: "live",
			userTurnKind: "review",
			taskConversationSessionMetadata: {
				workspaceTaskId: "task-1",
				taskConversationSessionRole: "by_the_way",
				taskConversationSessionContextSource: "forked_from_main_current_turn",
				parentTaskConversationSessionId: "task-1",
				mainSessionOriginTurnNumber: 3,
				mainSessionOriginUserMessagePreview: "Build sessions",
				latestUserMessagePreview: "Why is this read-only?",
			},
		});
		const onSelectTaskConversationSession = vi.fn();

		await act(async () => {
			root.render(
				<TaskConversationSessionsPanel
					workspaceTaskId="task-1"
					mainSessionSummary={mainSessionSummary}
					mainSessionUserMessagePreview="Build sessions"
					mainSessionOriginalPromptCard={ORIGINAL_PROMPT_CARD}
					effectiveAgentId="codex"
					taskSessions={{ "task-1": mainSessionSummary, "side-1": sideSessionSummary }}
					selectedTaskConversationSessionId="task-1"
					onSelectTaskConversationSession={onSelectTaskConversationSession}
					onCreateByTheWaySession={async () => ({ ok: true })}
				/>,
			);
		});

		expect(container.textContent).toContain("Why is this read-only?");
		expect(container.textContent).toContain("Forked from main · 2 turns ago");
		expect(container.querySelector('[aria-label="Unread answer"]')).not.toBeNull();

		const sideSessionButton = Array.from(container.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Why is this read-only?"),
		);
		await act(async () => sideSessionButton?.click());

		expect(onSelectTaskConversationSession).toHaveBeenCalledWith("side-1");
		expect(
			JSON.parse(window.localStorage.getItem(LocalStorageKey.TaskConversationSessionReadReceipts) ?? "{}"),
		).toMatchObject({ "side-1": 20 });
	});

	it("creates a fork of the current main session from the Add New form", async () => {
		const mainSessionSummary = createSessionSummary("task-1");
		const onCreateByTheWaySession = vi.fn(async () => ({ ok: true }));
		await act(async () => {
			root.render(
				<TaskConversationSessionsPanel
					workspaceTaskId="task-1"
					mainSessionSummary={mainSessionSummary}
					mainSessionUserMessagePreview="Build sessions"
					mainSessionOriginalPromptCard={ORIGINAL_PROMPT_CARD}
					effectiveAgentId="codex"
					taskSessions={{ "task-1": mainSessionSummary }}
					selectedTaskConversationSessionId="task-1"
					onSelectTaskConversationSession={() => {}}
					onCreateByTheWaySession={onCreateByTheWaySession}
				/>,
			);
		});

		await act(async () => {
			Array.from(container.querySelectorAll("button"))
				.find((button) => button.textContent?.includes("Add New"))
				?.click();
		});
		const questionInput = container.querySelector("textarea");
		expect(questionInput).toBeInstanceOf(HTMLTextAreaElement);
		await act(async () => {
			if (!questionInput) return;
			const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
			valueSetter?.call(questionInput, "Explain the relation");
			questionInput.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const createSessionButtons = Array.from(container.querySelectorAll("button")).filter(
			(button) => button.textContent === "Create session",
		);
		await act(async () => createSessionButtons.at(-1)?.click());

		expect(onCreateByTheWaySession).toHaveBeenCalledWith({
			initialUserQuestion: "Explain the relation",
			contextSource: "forked_from_main_current_turn",
		});
	});

	it("disables By the way session creation for unsupported agents", async () => {
		const mainSessionSummary = createSessionSummary("task-1");
		await act(async () => {
			root.render(
				<TaskConversationSessionsPanel
					workspaceTaskId="task-1"
					mainSessionSummary={mainSessionSummary}
					mainSessionUserMessagePreview="Build sessions"
					mainSessionOriginalPromptCard={ORIGINAL_PROMPT_CARD}
					effectiveAgentId="gemini"
					taskSessions={{ "task-1": mainSessionSummary }}
					selectedTaskConversationSessionId="task-1"
					onSelectTaskConversationSession={() => {}}
					onCreateByTheWaySession={async () => ({ ok: true })}
				/>,
			);
		});

		expect(
			Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Add New"))
				?.disabled,
		).toBe(true);
	});

	it("forces later By the way sessions to start from scratch", async () => {
		const mainSessionSummary = createSessionSummary("task-1");
		const existingByTheWaySummary = createSessionSummary("side-existing", {
			taskConversationSessionMetadata: {
				workspaceTaskId: "task-1",
				taskConversationSessionRole: "by_the_way",
				taskConversationSessionContextSource: "forked_from_main_current_turn",
				parentTaskConversationSessionId: "task-1",
				mainSessionOriginTurnNumber: 1,
				mainSessionOriginUserMessagePreview: null,
				latestUserMessagePreview: "Earlier question",
			},
		});
		const onCreateByTheWaySession = vi.fn(async () => ({ ok: true }));
		await act(async () => {
			root.render(
				<TaskConversationSessionsPanel
					workspaceTaskId="task-1"
					mainSessionSummary={mainSessionSummary}
					mainSessionUserMessagePreview="Build sessions"
					mainSessionOriginalPromptCard={ORIGINAL_PROMPT_CARD}
					effectiveAgentId="codex"
					taskSessions={{ "task-1": mainSessionSummary, "side-existing": existingByTheWaySummary }}
					selectedTaskConversationSessionId="task-1"
					onSelectTaskConversationSession={() => {}}
					onCreateByTheWaySession={onCreateByTheWaySession}
				/>,
			);
		});

		await act(async () => {
			Array.from(container.querySelectorAll("button"))
				.find((button) => button.textContent?.includes("Add New"))
				?.click();
		});
		const forkOption = container.querySelector<HTMLOptionElement>('option[value="forked_from_main_current_turn"]');
		expect(forkOption?.disabled).toBe(true);

		const questionInput = container.querySelector("textarea");
		await act(async () => {
			if (!questionInput) return;
			const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
			valueSetter?.call(questionInput, "Later question");
			questionInput.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			Array.from(container.querySelectorAll("button"))
				.filter((button) => button.textContent === "Create session")
				.at(-1)
				?.click();
		});

		expect(onCreateByTheWaySession).toHaveBeenCalledWith({
			initialUserQuestion: "Later question",
			contextSource: "started_from_scratch",
		});
	});
});
