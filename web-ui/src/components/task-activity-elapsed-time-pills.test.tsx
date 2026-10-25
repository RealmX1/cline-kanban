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
	it("未确认接受显示持久的来源、时间、原因，接受后消失", () => {
		const acceptance = {
			status: "unconfirmed" as const,
			attemptedAtMs: NOW_MS - 60_000,
			runtimeSessionIncarnationId: "process",
			submissionSource: "programmatic_submission" as const,
			verification: {
				checkedAtMs: NOW_MS,
				nextCheckAtMs: null,
				consecutiveUnchangedCheckCount: 4,
				reason: "no_matching_native_message" as const,
			},
		};
		renderElapsedTimePills({ agentConversationPromptSubmissionAcceptance: acceptance });
		const status = container.querySelector('[role="status"]');
		expect(status?.textContent).toContain("尚未确认接受");
		expect(status?.getAttribute("title")).toContain("程序化提交");
		expect(status?.getAttribute("title")).toContain("尚无可关联的原生接受记录");
		renderElapsedTimePills({ agentConversationPromptSubmissionAcceptance: { ...acceptance, status: "accepted" } });
		expect(container.querySelector('[role="status"]')).toBeNull();
	});

	it("后台等待保持 Agent 回合，历史 fallback 交棒隐藏，活动时长继续走而不归零", () => {
		const task = {
			turnOwner: "agent" as const,
			lastEffectiveAgentConversationActivityObservation: {
				observedAtMs: NOW_MS - 10 * 60_000,
				activityKind: "tool_activity" as const,
				evidenceKind: "persisted_agent_transcript" as const,
			},
			lastAgentConversationUserHandoffObservation: {
				observedAtMs: NOW_MS - 5 * 60_000,
				signalConfidence: "prompt_ready_fallback" as const,
				turnSequence: 7,
			},
		};
		renderElapsedTimePills(task);
		expect(container.querySelector("[data-agent-response-generation-stopped-pill]")).toBeNull();
		expect(container.querySelector("[data-last-conversation-progress-pill]")?.textContent).toBe("10m");
		renderElapsedTimePills(task, NOW_MS + 10 * 60_000);
		expect(container.querySelector("[data-last-conversation-progress-pill]")?.textContent).toBe("20m");
	});
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
