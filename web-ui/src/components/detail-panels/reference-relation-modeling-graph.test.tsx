import type { RelationModelingPreviewResponse } from "@runtime-work-unit-relation-modeling-api-contract";
import type * as ReactFlowModule from "@xyflow/react";
import type { Node, ReactFlowProps } from "@xyflow/react";
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReferenceRelationModelingGraph } from "./reference-relation-modeling-graph";

const graphObservation = vi.hoisted(() => ({
	width: 0,
	height: 0,
	measureContainer: vi.fn(),
	initiallyFittedNodes: [] as Node[][],
	unmountCount: 0,
}));

vi.mock("@/utils/react-use", () => ({
	useMeasure: () => [
		graphObservation.measureContainer,
		{ width: graphObservation.width, height: graphObservation.height },
	],
}));

vi.mock("@xyflow/react", async () => {
	const actualModule = await vi.importActual<typeof ReactFlowModule>("@xyflow/react");
	return {
		...actualModule,
		// ReactFlow 首次挂载消费 fitView；以同样的一次性边界检查宿主交付的初始布局。
		ReactFlow: function InitialViewportProbe({ nodes = [] }: ReactFlowProps) {
			const [initialNodes] = useState(nodes);
			const [viewport, setViewport] = useState("initial-fit");
			useEffect(() => {
				graphObservation.initiallyFittedNodes.push(initialNodes);
				return () => {
					graphObservation.unmountCount += 1;
				};
			}, [initialNodes]);
			return (
				<button type="button" data-viewport={viewport} onClick={() => setViewport("manual-pan-and-zoom")}>
					调整测试视口
				</button>
			);
		},
	};
});

function createPreview(rootWorkUnitKey = "root-task"): RelationModelingPreviewResponse {
	return {
		rootWorkUnitKey,
		workUnits: [],
		relations: [
			{
				relationId: "root-to-middle",
				subjectKey: rootWorkUnitKey,
				anchorKey: "middle-task",
				relationKind: "reference_concerns_behavior_or_state_of",
				relationPresentationState: "saved",
				assertedRelation: null,
			},
			{
				relationId: "middle-to-last",
				subjectKey: "middle-task",
				anchorKey: "last-task",
				relationKind: "reference_concerns_behavior_or_state_of",
				relationPresentationState: "saved",
				assertedRelation: null,
			},
		],
		truncated: false,
		projectedThroughGlobalCommittedEventSequence: 1,
	};
}

let container: HTMLDivElement;
let root: Root;

async function renderGraph({
	width,
	height,
	expanded = false,
	rootWorkUnitKey = "root-task",
}: {
	width: number;
	height: number;
	expanded?: boolean;
	rootWorkUnitKey?: string;
}) {
	graphObservation.width = width;
	graphObservation.height = height;
	await act(async () => {
		root.render(
			<ReferenceRelationModelingGraph
				preview={createPreview(rootWorkUnitKey)}
				rootTitle="当前测试任务"
				onSelectWorkUnit={vi.fn()}
				viewportResetKey={rootWorkUnitKey}
				expanded={expanded}
			/>,
		);
	});
}

beforeEach(() => {
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	graphObservation.initiallyFittedNodes = [];
	graphObservation.unmountCount = 0;
	graphObservation.width = 0;
	graphObservation.height = 0;
	container = document.body.appendChild(document.createElement("div"));
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

it("初次有效测量之前保留容器，窄屏的首次取景直接使用纵向节点布局", async () => {
	await renderGraph({ width: 0, height: 0 });
	expect(container.querySelector('[aria-label="任务多跳关系图"]')).not.toBeNull();
	expect(graphObservation.initiallyFittedNodes).toHaveLength(0);
	await renderGraph({ width: 360, height: 0 });
	expect(graphObservation.initiallyFittedNodes).toHaveLength(0);
	await renderGraph({ width: 360, height: 360 });
	expect(graphObservation.initiallyFittedNodes).toHaveLength(1);
	const initialNodes = graphObservation.initiallyFittedNodes[0]!;
	expect(initialNodes).toHaveLength(3);
	expect(initialNodes.map((node) => node.sourcePosition)).toEqual(["bottom", "bottom", "bottom"]);
	expect(new Set(initialNodes.map((node) => node.position.x)).size).toBe(1);
	expect(initialNodes[2]!.position.y).toBeGreaterThan(initialNodes[1]!.position.y);
	expect(initialNodes[1]!.position.y).toBeGreaterThan(initialNodes[0]!.position.y);
});

it("首次取景后展开收回和暂时零尺寸都保留图实例与手工平移缩放", async () => {
	await renderGraph({ width: 360, height: 360 });
	const viewportElement = container.querySelector("button")!;
	await act(async () => viewportElement.click());
	for (const dimensions of [
		{ width: 1100, height: 800, expanded: true },
		{ width: 360, height: 360, expanded: false },
		{ width: 0, height: 0, expanded: false },
		{ width: 700, height: 360, expanded: false },
	]) {
		await renderGraph(dimensions);
		expect(container.querySelector("button")).toBe(viewportElement);
		expect(viewportElement.dataset.viewport).toBe("manual-pan-and-zoom");
	}
	expect(graphObservation.initiallyFittedNodes).toHaveLength(1);
	expect(graphObservation.unmountCount).toBe(0);
});

it("切换根任务允许重新取景，并使用新根首次有效测量的布局方向", async () => {
	await renderGraph({ width: 360, height: 360 });
	await act(async () => container.querySelector("button")!.click());
	await renderGraph({ width: 1100, height: 360, rootWorkUnitKey: "another-root-task" });
	expect(graphObservation.initiallyFittedNodes).toHaveLength(2);
	expect(graphObservation.unmountCount).toBe(1);
	expect(container.querySelector("button")?.dataset.viewport).toBe("initial-fit");
	expect(graphObservation.initiallyFittedNodes[1]!.map((node) => node.sourcePosition)).toEqual([
		"right",
		"right",
		"right",
	]);
});
