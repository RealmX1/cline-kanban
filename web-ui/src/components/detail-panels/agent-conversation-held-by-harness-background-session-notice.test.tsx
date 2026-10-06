import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentConversationHeldByHarnessBackgroundSessionNotice } from "@/components/detail-panels/agent-conversation-held-by-harness-background-session-notice";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";

function createSummaryHeldByClaudeCodeBackgroundSession(
	overrides: Partial<
		NonNullable<RuntimeTaskSessionSummary["agentNativeConversationHeldByHarnessBackgroundSessionObservation"]>
	> = {},
): RuntimeTaskSessionSummary {
	return {
		taskId: "99b7e",
		state: "awaiting_review",
		agentId: "claude",
		workspacePath: "/tmp/worktrees/99b7e",
		pid: null,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		reviewReason: "error",
		exitCode: 1,
		lastHookAt: null,
		latestHookActivity: null,
		agentNativeConversationHeldByHarnessBackgroundSessionObservation: {
			harnessBackgroundSessionShortId: "bdd73afb",
			nativeSessionId: "bdd73afb-38f0-4ec6-8c4e-9c488e8667f1",
			reclaimBlockedReason: "background_session_input_box_has_unsent_text_or_is_hidden",
			automaticReclaimWatchActive: true,
			observedAt: 1,
			...overrides,
		},
	};
}

// AlertDialog 走 Radix Portal，挂在 document.body 上而不是测试容器里。
function findButtonInDocumentByLabel(label: string): HTMLButtonElement | null {
	return [...document.body.querySelectorAll("button")].find((button) => button.textContent?.trim() === label) ?? null;
}

describe("AgentConversationHeldByHarnessBackgroundSessionNotice", () => {
	let container: HTMLDivElement;
	let root: Root;
	const forceStopHarnessBackgroundSessionAndResumeHere = vi.fn(async () => {});

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		forceStopHarnessBackgroundSessionAndResumeHere.mockClear();
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
	});

	function renderNotice(summary: RuntimeTaskSessionSummary | null): void {
		act(() => {
			root.render(
				<AgentConversationHeldByHarnessBackgroundSessionNotice
					summary={summary}
					isRestartingAgentSession={false}
					onForceStopHarnessBackgroundSessionAndResumeHere={forceStopHarnessBackgroundSessionAndResumeHere}
				/>,
			);
		});
	}

	it("renders nothing when the conversation is not held by a background session", () => {
		renderNotice({
			...createSummaryHeldByClaudeCodeBackgroundSession(),
			agentNativeConversationHeldByHarnessBackgroundSessionObservation: null,
		});
		expect(container.textContent).toBe("");
	});

	it("explains why it was not reclaimed and whether Kanban is still watching", () => {
		renderNotice(createSummaryHeldByClaudeCodeBackgroundSession());
		expect(container.textContent).toContain("bdd73afb");
		expect(container.textContent).toContain("外部编辑器");
		expect(container.textContent).toContain("Kanban 正在盯着它");
		expect(container.textContent).toContain("claude attach bdd73afb");

		renderNotice(createSummaryHeldByClaudeCodeBackgroundSession({ automaticReclaimWatchActive: false }));
		expect(container.textContent).toContain("Kanban 已停止自动等待");
	});

	it("takes over only after the user confirms what will be lost", () => {
		renderNotice(createSummaryHeldByClaudeCodeBackgroundSession());
		act(() => {
			findButtonInDocumentByLabel("停止后台会话并在这里续跑")?.click();
		});
		expect(forceStopHarnessBackgroundSessionAndResumeHere).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain("没提交的输入（包括外部编辑器里的草稿）会丢失");

		act(() => {
			findButtonInDocumentByLabel("停止并在这里续跑")?.click();
		});
		expect(forceStopHarnessBackgroundSessionAndResumeHere).toHaveBeenCalledTimes(1);
	});
});
