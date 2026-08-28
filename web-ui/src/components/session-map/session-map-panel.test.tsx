import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionMapPanel } from "@/components/session-map/session-map-panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import type {
	RuntimeConversationSessionTurnProjectionResponse,
	RuntimeConversationTurnProjectionEntry,
	RuntimeExploratorySessionMapCollection,
} from "@/runtime/types";

function createTurnEntry(
	turnNumber: number,
	overrides: Partial<RuntimeConversationTurnProjectionEntry> = {},
): RuntimeConversationTurnProjectionEntry {
	return {
		turnNumber,
		turnStartedAt: turnNumber,
		turnUserMessageExcerpt: `第 ${turnNumber} 轮的用户消息首行`,
		turnAssistantResponseExcerpt: null,
		turnMessageCount: 2,
		turnCheckpointCommit: `commit-${turnNumber}`,
		turnCheckpointAlignmentConfidence: "exact_ordinal_match",
		turnIsInProgress: false,
		turnHasConversationTreeForkAnchor: false,
		...overrides,
	};
}

function createProjection(
	overrides: Partial<RuntimeConversationSessionTurnProjectionResponse> = {},
): RuntimeConversationSessionTurnProjectionResponse {
	return {
		harnessSource: "exact_structured",
		turnProjectionEntries: [createTurnEntry(1), createTurnEntry(2)],
		turnProjectionSignature: "2:last:10",
		turnProjectionIsIncomplete: false,
		...overrides,
	};
}

function createMapCollection(
	overrides: Partial<RuntimeExploratorySessionMapCollection> = {},
): RuntimeExploratorySessionMapCollection {
	return {
		sourceTurnProjectionSignature: "2:last:10",
		mapNodes: [
			{
				mapNodeId: "node-1",
				anchorConversationSessionTaskId: "task-1",
				anchorTurnNumber: 2,
				anchorTurnCheckpointCommit: "commit-2",
				anchorTurnUserMessagePreview: null,
				nodeKind: "milestone",
				nodeTitle: "定了存储方案",
				nodeSummaryMarkdown: null,
				referencedFindingId: null,
				nodeGenerationSource: "agent_live_session_maintenance",
				createdAt: 1,
				updatedAt: 1,
			},
		],
		mapStaleReason: null,
		lastMaintenanceJobCompletedAt: null,
		updatedAt: 1,
		...overrides,
	};
}

describe("SessionMapPanel", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
	});

	async function renderPanel(props: Parameters<typeof SessionMapPanel>[0]): Promise<void> {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<SessionMapPanel {...props} />
				</TooltipProvider>,
			);
		});
	}

	async function expandPanel(): Promise<void> {
		const headerButton = Array.from(container.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Session Map"),
		);
		expect(headerButton).toBeDefined();
		await act(async () => {
			headerButton?.click();
		});
	}

	it("M0 默认折叠：只渲染 header，不渲染 turn 骨架", async () => {
		await renderPanel({ queryPhase: "ready", projection: createProjection(), mapCollection: null });
		expect(container.textContent).toContain("Session Map");
		expect(container.textContent).toContain("2 turns");
		expect(container.textContent).not.toContain("第 1 轮的用户消息首行");
	});

	it("展开后渲染 turn 骨架：turn 号胶囊 + 用户消息摘录", async () => {
		await renderPanel({ queryPhase: "ready", projection: createProjection(), mapCollection: null });
		await expandPanel();
		expect(container.textContent).toContain("T1");
		expect(container.textContent).toContain("第 1 轮的用户消息首行");
		expect(container.textContent).toContain("T2");
	});

	it("harnessSource 为 unavailable_live_terminal_pty 时渲染降级占位（不点名 PTY——ACP 在 M0 同档）", async () => {
		await renderPanel({
			queryPhase: "ready",
			projection: createProjection({
				harnessSource: "unavailable_live_terminal_pty",
				turnProjectionEntries: [],
				turnProjectionSignature: "0:none:0",
			}),
			mapCollection: null,
		});
		await expandPanel();
		expect(container.textContent).toContain("Session structure view is not available for this session type yet.");
		expect(container.textContent).not.toContain("PTY");
	});

	it("map 集合非空时渲染节点列表并挂 data-session-map-node-anchor", async () => {
		await renderPanel({
			queryPhase: "ready",
			projection: createProjection(),
			mapCollection: createMapCollection(),
		});
		await expandPanel();
		expect(container.textContent).toContain("定了存储方案");
		const anchor = container.querySelector('[data-session-map-node-anchor="node-1"]');
		expect(anchor).not.toBeNull();
		expect(anchor?.textContent).toContain("T2");
	});

	it("mapStaleReason 非 null 时顶部出「map 落后于会话」badge", async () => {
		await renderPanel({
			queryPhase: "ready",
			projection: createProjection(),
			mapCollection: createMapCollection({ mapStaleReason: "turn_projection_signature_drift" }),
		});
		await expandPanel();
		expect(container.textContent).toContain("Map is behind the conversation");
	});

	it("expandToken 递增即展开（聊天内锚 chip 点击的信号通道）", async () => {
		await renderPanel({ queryPhase: "ready", projection: createProjection(), mapCollection: null, expandToken: 0 });
		expect(container.textContent).not.toContain("第 1 轮的用户消息首行");
		await act(async () => {
			root.render(
				<TooltipProvider>
					<SessionMapPanel
						queryPhase="ready"
						projection={createProjection()}
						mapCollection={null}
						expandToken={1}
					/>
				</TooltipProvider>,
			);
		});
		expect(container.textContent).toContain("第 1 轮的用户消息首行");
	});

	it("初始加载中渲染 spinner 占位", async () => {
		await renderPanel({ queryPhase: "loading", projection: null, mapCollection: null });
		await expandPanel();
		expect(container.textContent).toContain("Loading session structure…");
	});
});
