import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BoardCard } from "@/components/board-card";
import { buildTaskResourceUsagePillTooltipContent } from "@/components/task-card-resource-usage-pill";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RuntimeLiveTaskResourceUsageSnapshot } from "@/runtime/types";
import {
	replaceTaskResourceUsageSnapshots,
	resetTaskResourceUsageSnapshotStore,
} from "@/stores/task-resource-usage-snapshot-store";

// 推流 → store → 卡片头部资源药丸的端到端契约：药丸是卡体内的叶子，自己按卡片 id 订阅 store。

vi.mock("@hello-pangea/dnd", () => ({
	Draggable: ({
		children,
	}: {
		children: (
			provided: {
				innerRef: (element: HTMLDivElement | null) => void;
				draggableProps: object;
				dragHandleProps: object;
			},
			snapshot: { isDragging: boolean },
		) => ReactNode;
	}): React.ReactElement => (
		<>{children({ innerRef: () => {}, draggableProps: {}, dragHandleProps: {} }, { isDragging: false })}</>
	),
}));

vi.mock("@/stores/workspace-metadata-store", () => ({
	useTaskWorkspaceSnapshotValue: () => undefined,
}));

const NOW = Date.now();

function createCard() {
	return {
		id: "task-1",
		title: "Review API changes",
		prompt: "Review API changes",
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit" as const,
		baseRef: "main",
		createdAt: NOW - 60_000,
		updatedAt: NOW,
	};
}

function snapshot(overrides: Partial<RuntimeLiveTaskResourceUsageSnapshot> = {}): RuntimeLiveTaskResourceUsageSnapshot {
	return {
		workspaceId: "repo",
		attributedTaskCardId: "task-1",
		sampledAtEpochMs: NOW,
		attributedProcessCount: 12,
		residentSetSizeKibibytesSumUpperBound: 1_258_291,
		cpuPercentOfOneCoreOverLastSampleInterval: 35.4,
		survivedSessionRootExitProcessCount: 0,
		survivedSessionRootExitResidentSetSizeKibibytesSum: 0,
		agentHarnessRootPhysicalFootprintBytes: 400 * 1024 * 1024,
		processCountByProcessClassification: { agent_harness_root_process: 1 },
		residentSetSizeKibibytesSumUpperBoundByProcessClassification: { agent_harness_root_process: 300_000 },
		mcpServerInstances: [],
		...overrides,
	};
}

let container: HTMLDivElement;
let root: Root;
let previousActEnvironment: boolean | undefined;

function renderCard(): HTMLDivElement {
	act(() => root.render(<BoardCard card={createCard()} index={0} columnId="in_progress" />));
	return container;
}

function resourceUsagePill(host: HTMLElement): HTMLElement | null {
	return host.querySelector<HTMLElement>("[data-task-resource-usage-pill]");
}

beforeEach(() => {
	previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
		.IS_REACT_ACT_ENVIRONMENT;
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	resetTaskResourceUsageSnapshotStore();
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
	vi.restoreAllMocks();
	container.remove();
	resetTaskResourceUsageSnapshotStore();
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
		previousActEnvironment;
});

describe("卡片头部资源占用药丸", () => {
	it("没有归因到进程时不显示", () => {
		expect(resourceUsagePill(renderCard())).toBeNull();
	});

	it("显示该卡此刻的内存与 CPU，并随推流更新", () => {
		const host = renderCard();

		act(() => replaceTaskResourceUsageSnapshots([snapshot()]));
		expect(resourceUsagePill(host)?.textContent).toBe("1.2G 35%");

		act(() =>
			replaceTaskResourceUsageSnapshots([
				snapshot({ residentSetSizeKibibytesSumUpperBound: 512_000, cpuPercentOfOneCoreOverLastSampleInterval: 0 }),
			]),
		);
		expect(resourceUsagePill(host)?.textContent).toBe("500M");
	});

	it("有会话结束后仍在跑的残留进程时转为警示色", () => {
		const host = renderCard();

		act(() => replaceTaskResourceUsageSnapshots([snapshot({ survivedSessionRootExitProcessCount: 2 })]));

		expect(resourceUsagePill(host)?.className).toContain("text-status-orange");
	});

	it("会话全部结束、推来空列表后消失", () => {
		const host = renderCard();
		act(() => replaceTaskResourceUsageSnapshots([snapshot()]));

		act(() => replaceTaskResourceUsageSnapshots([]));

		expect(resourceUsagePill(host)).toBeNull();
	});

	it("tooltip 标明 RSS 是上界并列出残留进程", () => {
		const tooltip = buildTaskResourceUsagePillTooltipContent(
			snapshot({
				survivedSessionRootExitProcessCount: 2,
				survivedSessionRootExitResidentSetSizeKibibytesSum: 204_800,
			}),
		);

		expect(tooltip).toContain("RSS 上界 1.2G");
		expect(tooltip).toContain("harness 根进程 footprint 400M");
		expect(tooltip).toContain("残留进程 2 个（200M）");
		expect(tooltip).toContain("是上界");
	});
});
