// 一行的泳道图元（B.2）。风格对齐 git history 面板的 GraphSvg——这张图本来就是 git-graph 语义：
// thread = 分支、turn = 提交、多 parent = 合流。
//
// **布局不在这里算**：泳道号、合流来源、分叉来源全部由核心包的 projection 随行下发
// （`laneLayout`，服务端算好）。前端只负责把这些数字画成线，绝不自己再推一遍——两处各算一遍
// 就是两份会漂移的几何。

import type { ReactElement } from "react";
import type { RuntimeExplorationThreadGraphProjectionViewTurnRow } from "@/runtime/types";

// 与 git history 面板同款几何，保证两张图在视觉上是一家人。
const ROW_HEIGHT = 44;
const LANE_WIDTH = 12;
const NODE_RADIUS = 4;
const GRAPH_LEFT_PAD = 8;

// 泳道配色。按泳道号取模——同一条 thread 在相邻行里恒在同一泳道，颜色因此稳定。
const LANE_COLORS = ["#60a5fa", "#f472b6", "#34d399", "#fbbf24", "#a78bfa", "#22d3ee", "#fb923c"] as const;

function resolveLaneColor(lane: number): string {
	return LANE_COLORS[lane % LANE_COLORS.length] ?? LANE_COLORS[0];
}

function laneCenterX(lane: number): number {
	return GRAPH_LEFT_PAD + lane * LANE_WIDTH + LANE_WIDTH / 2;
}

/** 渲染层要预留多宽：调用方按整张图的 laneCount 统一给，各行宽度必须一致才对得齐。 */
export function computeThreadGraphSvgWidth(laneCount: number): number {
	return GRAPH_LEFT_PAD + laneCount * LANE_WIDTH + LANE_WIDTH;
}

export const THREAD_GRAPH_ROW_HEIGHT = ROW_HEIGHT;

export function ExplorationThreadGraphLaneRowSvg({
	laneLayout,
	laneCount,
	isLastRow,
}: {
	laneLayout: RuntimeExplorationThreadGraphProjectionViewTurnRow["laneLayout"];
	laneCount: number;
	// 最后一行（最旧的 turn）下方不再画延伸线——那会画出一条通向空白的尾巴。
	isLastRow: boolean;
}): ReactElement {
	const width = computeThreadGraphSvgWidth(laneCount);
	const centerY = ROW_HEIGHT / 2;
	const nodeX = laneCenterX(laneLayout.rowLane);
	const nodeColor = resolveLaneColor(laneLayout.rowLane);

	return (
		<svg width={width} height={ROW_HEIGHT} className="shrink-0" aria-hidden="true">
			<title>thread lane</title>

			{/* 各泳道的竖线。行序是新→旧，所以「向上」通向更新的 turn、「向下」通向更旧的。 */}
			{laneLayout.laneWaitingForIds.map((waitingForId, lane) => {
				const x = laneCenterX(lane);
				const color = resolveLaneColor(lane);
				// 本行开启的新泳道：上半段不画（它在这一行之上还不存在）。
				const skipUpperHalf = lane === laneLayout.rowLane && laneLayout.rowStartsLane;
				return (
					<g key={`${waitingForId}-${lane}`}>
						{!skipUpperHalf && !laneLayout.isFirstRow ? (
							<line x1={x} y1={0} x2={x} y2={centerY} stroke={color} strokeWidth={1.5} />
						) : null}
						{!isLastRow ? (
							<line x1={x} y1={centerY} x2={x} y2={ROW_HEIGHT} stroke={color} strokeWidth={1.5} />
						) : null}
					</g>
				);
			})}

			{/* 合流线：这些泳道在本行汇入当前节点（= 该 turn 有多个 parent）。 */}
			{laneLayout.mergeFromLanes.map((mergeLane) => {
				const x = laneCenterX(mergeLane);
				return (
					<path
						key={`merge-${mergeLane}`}
						d={`M ${x} ${ROW_HEIGHT} C ${x} ${centerY}, ${nodeX} ${centerY}, ${nodeX} ${centerY}`}
						fill="none"
						stroke={resolveLaneColor(mergeLane)}
						strokeWidth={1.5}
					/>
				);
			})}

			{/* 分叉线：本行是一条新泳道的起点，它从哪条泳道分出来。 */}
			{laneLayout.splitFromLane !== null ? (
				<path
					d={`M ${nodeX} ${centerY} C ${nodeX} ${ROW_HEIGHT}, ${laneCenterX(laneLayout.splitFromLane)} ${centerY}, ${laneCenterX(laneLayout.splitFromLane)} ${ROW_HEIGHT}`}
					fill="none"
					stroke={resolveLaneColor(laneLayout.splitFromLane)}
					strokeWidth={1.5}
				/>
			) : null}

			<circle cx={nodeX} cy={centerY} r={NODE_RADIUS} fill={nodeColor} />
		</svg>
	);
}
