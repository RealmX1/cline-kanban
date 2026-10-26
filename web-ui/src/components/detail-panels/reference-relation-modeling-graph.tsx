import dagre from "@dagrejs/dagre";
import type { RelationModelingPreviewResponse } from "@runtime-work-unit-relation-modeling-api-contract";
import { Background, Controls, type Edge, MarkerType, type Node, Position, ReactFlow } from "@xyflow/react";
import { type MouseEvent, useMemo, useRef } from "react";
import { cn } from "@/components/ui/cn";
import { useMeasure } from "@/utils/react-use";
import "@xyflow/react/dist/style.css";

import { RELATION_GRAPH_LABELS } from "@/hooks/work-unit-relation-kind-display-labels";

export { REFERENCE_RELATION_LABELS, RELATION_GRAPH_LABELS } from "@/hooks/work-unit-relation-kind-display-labels";

export const RELATION_PREVIEW_STATE_LABELS = {
	saved: "已保存",
	pending_addition: "待新增",
	pending_revision: "待修改",
	pending_revocation: "待撤销",
};

export function ReferenceRelationModelingGraph({
	preview,
	rootTitle,
	onSelectWorkUnit,
	onHoverWorkUnit,
	onLeaveWorkUnit,
	onFocusWorkUnit,
	viewportResetKey,
	expanded = false,
}: {
	preview: RelationModelingPreviewResponse;
	rootTitle: string;
	onSelectWorkUnit: (key: string, trigger: HTMLElement | null) => void;
	onHoverWorkUnit?: (key: string, trigger: HTMLElement | null) => void;
	onLeaveWorkUnit?: () => void;
	onFocusWorkUnit?: (key: string, trigger: HTMLElement | null) => void;
	viewportResetKey: string;
	expanded?: boolean;
}) {
	const nodeReceivingPointerFocus = useRef<string | null>(null);
	const nodeTrigger = (event: MouseEvent): HTMLElement | null =>
		event.target instanceof Element ? event.target.closest<HTMLElement>(".react-flow__node") : null;
	const [measureGraphContainer, { width: graphContainerWidth, height: graphContainerHeight }] =
		useMeasure<HTMLDivElement>();
	const layoutOrientation = useRef<{ rootKey: string; vertical: boolean } | null>(null);
	if (
		graphContainerWidth > 0 &&
		graphContainerHeight > 0 &&
		layoutOrientation.current?.rootKey !== preview.rootWorkUnitKey
	)
		layoutOrientation.current = { rootKey: preview.rootWorkUnitKey, vertical: graphContainerWidth < 560 };
	// 首次 fitView 等待有效尺寸和最终布局；后续零尺寸不卸载图，保留手工视口。
	const hasInitializedCurrentRootLayout = layoutOrientation.current?.rootKey === preview.rootWorkUnitKey;
	const useVerticalLayout = layoutOrientation.current?.vertical ?? false;
	const graph = useMemo(() => {
		const layout = new dagre.graphlib.Graph({ multigraph: true })
			.setGraph({ rankdir: useVerticalLayout ? "TB" : "LR", nodesep: 32, ranksep: useVerticalLayout ? 52 : 105 })
			.setDefaultEdgeLabel(() => ({}));
		const entries = new Map(preview.workUnits.map((entry) => [entry.workUnitKey, entry]));
		const keys = new Set([
			preview.rootWorkUnitKey,
			...preview.relations.flatMap((relation) => [relation.subjectKey, relation.anchorKey]),
		]);
		for (const key of keys) layout.setNode(key, { width: 190, height: 64 });
		for (const edge of preview.relations) layout.setEdge(edge.subjectKey, edge.anchorKey, {}, edge.relationId);
		dagre.layout(layout);
		const nodes: Node[] = [...keys].map((key) => {
			const entry = entries.get(key);
			const currentWorkUnitReference = entry?.kanbanBoardCardIdentity?.kanbanBoardCard ?? entry?.workUnit;
			const isRoot = key === preview.rootWorkUnitKey;
			const title = isRoot
				? rootTitle
				: (entry?.kanbanBoardCardIdentity?.currentTitle ?? entry?.workUnitDisplayLabel ?? key);
			const position = layout.node(key);
			return {
				id: key,
				sourcePosition: useVerticalLayout ? Position.Bottom : Position.Right,
				targetPosition: useVerticalLayout ? Position.Top : Position.Left,
				position: { x: position.x - 95, y: position.y - 32 },
				data: {
					label: (
						<div className="min-w-0 text-left">
							<div className="truncate text-xs font-medium" title={title}>
								{title}
							</div>
							<div className="mt-1 truncate text-[11px]">
								{isRoot
									? "当前任务"
									: currentWorkUnitReference?.workUnitType === "kanban_board_card"
										? `${currentWorkUnitReference.workspaceId} · ${currentWorkUnitReference.taskId}`
										: "独立会话"}
							</div>
						</div>
					),
				},
				style: {
					width: 190,
					height: 64,
					background: "var(--color-surface-2)",
					color: "var(--color-text-primary)",
					border: `1px solid var(${isRoot ? "--color-accent" : "--color-border-bright"})`,
					borderRadius: 6,
				},
				ariaLabel: title,
				draggable: false,
				connectable: false,
			};
		});
		const edges: Edge[] = preview.relations.map((relation) => ({
			id: relation.relationId,
			source: relation.subjectKey,
			target: relation.anchorKey,
			label: `${RELATION_GRAPH_LABELS[relation.relationKind] ?? relation.relationKind} · ${RELATION_PREVIEW_STATE_LABELS[relation.relationPresentationState]}`,
			markerEnd: ["reference_is_generally_related_with", "reference_is_cross_repository_counterpart_with"].includes(
				relation.relationKind,
			)
				? undefined
				: { type: MarkerType.ArrowClosed },
			style: {
				stroke: `var(${relation.relationPresentationState === "pending_revocation" ? "--color-status-red" : relation.relationPresentationState === "saved" ? "--color-text-secondary" : "--color-accent"})`,
				strokeDasharray: relation.relationPresentationState === "saved" ? undefined : "5 4",
			},
			labelStyle: { fill: "var(--color-text-primary)", fontSize: 11 },
			labelBgStyle: { fill: "var(--color-surface-1)" },
			reconnectable: false,
		}));
		return { nodes, edges };
	}, [preview, rootTitle, useVerticalLayout]);
	return (
		<div
			ref={measureGraphContainer}
			className={cn(
				"min-w-0 overflow-hidden rounded-md border border-border-bright bg-surface-0",
				expanded ? "h-[max(360px,calc(100dvh-16rem))]" : "h-[360px]",
			)}
			role="group"
			aria-label="任务多跳关系图"
			onPointerDownCapture={(event) => {
				const node = (event.target as HTMLElement).closest<HTMLElement>(".react-flow__node");
				nodeReceivingPointerFocus.current = node?.dataset.id ?? null;
				// 点击产生的 focus 不能先改变布局，否则 Dialog 滚动后 pointerup 会错过原节点。
				onLeaveWorkUnit?.();
			}}
			onPointerUpCapture={() => {
				nodeReceivingPointerFocus.current = null;
			}}
			onPointerCancel={() => {
				nodeReceivingPointerFocus.current = null;
			}}
			onPointerLeave={() => {
				nodeReceivingPointerFocus.current = null;
			}}
			onFocusCapture={(event) => {
				const node = event.target.closest<HTMLElement>(".react-flow__node");
				if (node?.dataset.id && nodeReceivingPointerFocus.current !== node.dataset.id)
					onFocusWorkUnit?.(node.dataset.id, node);
			}}
			onKeyDownCapture={(event) => {
				if (event.key !== "Enter" && event.key !== " ") return;
				const node = (event.target as HTMLElement).closest<HTMLElement>(".react-flow__node");
				if (!node?.dataset.id) return;
				event.preventDefault();
				event.stopPropagation();
				onSelectWorkUnit(node.dataset.id, node);
			}}
		>
			{hasInitializedCurrentRootLayout && (
				<ReactFlow
					key={viewportResetKey}
					nodes={graph.nodes}
					edges={graph.edges}
					fitView
					fitViewOptions={{ padding: 0.18, maxZoom: 1 }}
					nodesDraggable={false}
					nodesConnectable={false}
					edgesReconnectable={false}
					onNodeClick={(event, node) => onSelectWorkUnit(node.id, nodeTrigger(event))}
					onNodeMouseEnter={(event, node) => {
						if (!nodeReceivingPointerFocus.current) onHoverWorkUnit?.(node.id, nodeTrigger(event));
					}}
					onNodeMouseLeave={onLeaveWorkUnit}
					minZoom={0.2}
					maxZoom={1.8}
					colorMode="dark"
					ariaLabelConfig={{
						"controls.zoomIn.ariaLabel": "放大关系图",
						"controls.zoomOut.ariaLabel": "缩小关系图",
						"controls.fitView.ariaLabel": "显示完整关系图",
					}}
				>
					<Background />
					<Controls showInteractive={false} />
				</ReactFlow>
			)}
		</div>
	);
}
