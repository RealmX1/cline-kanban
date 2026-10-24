import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskActivityElapsedTimePills } from "@/components/task-activity-elapsed-time-pills";
import { TooltipProvider } from "@/components/ui/tooltip";

const NOW_MS = Date.now();
const DAY_MS = 24 * 60 * 60_000;
const CREATED_AT_MS = NOW_MS - 3 * DAY_MS;

let container: HTMLDivElement;
let root: Root;
let previousActEnvironment: boolean | undefined;

function renderElapsedTimePills(
	taskOverrides: Partial<ComponentProps<typeof TaskActivityElapsedTimePills>["task"]> = {},
	nowMs = NOW_MS,
) {
	act(() =>
		root.render(
			<TaskActivityElapsedTimePills
				task={{
					createdAt: CREATED_AT_MS,
					agentResponseGenerationStopped: null,
					lastConversationProgressObservation: null,
					...taskOverrides,
				}}
				nowMs={nowMs}
			/>,
		),
	);
	return container.querySelector<HTMLElement>("[data-task-created-at-pill]");
}

beforeEach(() => {
	previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
		.IS_REACT_ACT_ENVIRONMENT;
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	container = document.createElement("div");
	document.body.appendChild(container);
	const baseRoot = createRoot(container);
	root = {
		render: (children: ReactNode) => baseRoot.render(<TooltipProvider>{children}</TooltipProvider>),
		unmount: () => baseRoot.unmount(),
	};
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
		previousActEnvironment;
});

describe("跨项目精简行的创建时间", () => {
	it("活动未知时仍显示创建时长，并提供准确创建时间", () => {
		const creationTimePill = renderElapsedTimePills();
		expect(creationTimePill?.textContent).toBe("3d");
		expect(creationTimePill?.title).toBe(`创建于 · ${new Date(CREATED_AT_MS).toLocaleString()}`);
		expect(creationTimePill?.querySelector(".lucide-clock")).not.toBeNull();
		expect(container.querySelector("[data-task-conversation-session-activity-details]")?.textContent).toBe(
			"活动未知",
		);
	});

	it("创建时长随时钟更新，独立于活动时间、交棒和提交待确认状态", () => {
		expect(renderElapsedTimePills()?.textContent).toBe("3d");
		const creationTimePill = renderElapsedTimePills(
			{
				turnOwner: "agent",
				lastEffectiveAgentConversationActivityObservation: {
					observedAtMs: NOW_MS + DAY_MS - 60_000,
					evidenceKind: "persisted_agent_transcript",
					activityKind: "tool_activity",
				},
				agentConversationPromptSubmissionAcceptance: {
					status: "pending",
					attemptedAtMs: NOW_MS + DAY_MS,
					runtimeSessionIncarnationId: "creation-time-test-runtime-session-incarnation",
				},
			},
			NOW_MS + DAY_MS,
		);
		expect(creationTimePill?.textContent).toBe("4d");
		expect(creationTimePill?.title).toBe(`创建于 · ${new Date(CREATED_AT_MS).toLocaleString()}`);
		expect(container.querySelector("[data-last-conversation-progress-pill]")?.textContent).toBe("1m");
		expect(container.querySelector("[role=status]")?.textContent).toBe("提交待确认");
	});
});
