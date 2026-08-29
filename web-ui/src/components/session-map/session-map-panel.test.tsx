import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionMapPanel } from "@/components/session-map/session-map-panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import type {
	RuntimeConversationSessionTurnProjectionResponse,
	RuntimeConversationTurnProjectionEntry,
	RuntimeExploratoryFindingEntry,
	RuntimeExploratorySessionMapCollection,
} from "@/runtime/types";

const { confirmFindingMock, rejectFindingMock, notifyErrorMock } = vi.hoisted(() => ({
	confirmFindingMock: vi.fn(),
	rejectFindingMock: vi.fn(),
	notifyErrorMock: vi.fn(),
}));

vi.mock("@/runtime/findings-query", () => ({
	confirmExploratoryFinding: confirmFindingMock,
	rejectExploratoryFinding: rejectFindingMock,
}));

vi.mock("@/components/app-toaster", () => ({
	notifyError: notifyErrorMock,
	showAppToast: vi.fn(),
}));

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
		confirmFindingMock.mockReset();
		rejectFindingMock.mockReset();
		notifyErrorMock.mockReset();
		confirmFindingMock.mockImplementation(async () => ({ finding: null }));
		rejectFindingMock.mockImplementation(async () => ({ removed: true }));
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

	it("节点按 anchorTurnNumber 升序渲染（map 不存边，显示序由锚 turn 派生）", async () => {
		const nodeAt = (turn: number, title: string) => ({
			mapNodeId: `node-${turn}`,
			anchorConversationSessionTaskId: "task-1",
			anchorTurnNumber: turn,
			anchorTurnCheckpointCommit: `commit-${turn}`,
			anchorTurnUserMessagePreview: null,
			nodeKind: "milestone" as const,
			nodeTitle: title,
			nodeSummaryMarkdown: null,
			referencedFindingId: null,
			nodeGenerationSource: "agent_live_session_maintenance" as const,
			createdAt: turn,
			updatedAt: turn,
		});
		await renderPanel({
			queryPhase: "ready",
			projection: createProjection(),
			// 落地序乱序（apply 漏斗按提案序归并），渲染必须重排。
			mapCollection: createMapCollection({
				mapNodes: [nodeAt(3, "第三个点"), nodeAt(1, "第一个点"), nodeAt(2, "第二个点")],
			}),
		});
		await expandPanel();
		const renderedIds = Array.from(container.querySelectorAll("[data-session-map-node-anchor]")).map((element) =>
			element.getAttribute("data-session-map-node-anchor"),
		);
		expect(renderedIds).toEqual(["node-1", "node-2", "node-3"]);
	});

	it("节点带摘要时渲染第二行摘要文本", async () => {
		await renderPanel({
			queryPhase: "ready",
			projection: createProjection(),
			mapCollection: createMapCollection({
				mapNodes: [
					{
						...createMapCollection().mapNodes[0]!,
						nodeSummaryMarkdown: "比较了三种方案后选了 WAL，理由是崩溃恢复语义最简单。",
					},
				],
			}),
		});
		await expandPanel();
		expect(container.textContent).toContain("定了存储方案");
		expect(container.textContent).toContain("比较了三种方案后选了 WAL");
	});

	it("defaultOpen=true（exploratory 会话）时初始即展开，无需手动点开", async () => {
		await renderPanel({
			queryPhase: "ready",
			projection: createProjection(),
			mapCollection: null,
			defaultOpen: true,
		});
		expect(container.textContent).toContain("第 1 轮的用户消息首行");
	});

	it("defaultOpen 跟随 prop 直到用户首次手动开合；用户表过态后不再被默认值推翻", async () => {
		await renderPanel({
			queryPhase: "ready",
			projection: createProjection(),
			mapCollection: null,
			defaultOpen: false,
		});
		expect(container.textContent).not.toContain("第 1 轮的用户消息首行");

		// 模式解析落定/切到 exploratory 会话 → 默认值翻 true，未表过态的面板跟随展开。
		await renderPanel({
			queryPhase: "ready",
			projection: createProjection(),
			mapCollection: null,
			defaultOpen: true,
		});
		expect(container.textContent).toContain("第 1 轮的用户消息首行");

		// 用户手动折叠后，默认值再翻转也不再推翻用户选择。
		await expandPanel(); // 这里复用「点 header」——此刻是折叠动作
		expect(container.textContent).not.toContain("第 1 轮的用户消息首行");
		await renderPanel({
			queryPhase: "ready",
			projection: createProjection(),
			mapCollection: null,
			defaultOpen: false,
		});
		expect(container.textContent).not.toContain("第 1 轮的用户消息首行");
		await renderPanel({
			queryPhase: "ready",
			projection: createProjection(),
			mapCollection: null,
			defaultOpen: true,
		});
		expect(container.textContent).not.toContain("第 1 轮的用户消息首行");
	});

	// ── 「本会话 findings」section（蓝图 §G.2，M2）──────────────────────────

	function createFinding(overrides: Partial<RuntimeExploratoryFindingEntry> = {}): RuntimeExploratoryFindingEntry {
		return {
			findingId: "finding-1",
			findingTitle: "本会话的结论",
			findingBodyMarkdown: "结论正文全文",
			findingStatus: "active",
			supersededByFindingId: null,
			findingGenerationSource: "user_saved",
			provenanceLinks: [
				{
					linkKind: "turn_anchor",
					conversationSessionTaskId: "session-1",
					turnNumber: 2,
					turnCheckpointCommit: "commit-2",
				},
			],
			originConversationSessionTaskId: "session-1",
			createdAt: 1,
			updatedAt: 1,
			...overrides,
		};
	}

	const sessionFindingsContext = (findings: RuntimeExploratoryFindingEntry[] | null) => ({
		workspaceId: "workspace-1",
		conversationSessionTaskId: "session-1",
		findings,
	});

	async function renderPanelWithFindings(findings: RuntimeExploratoryFindingEntry[] | null): Promise<void> {
		await renderPanel({
			queryPhase: "ready",
			projection: createProjection(),
			mapCollection: null,
			sessionFindings: sessionFindingsContext(findings),
		});
	}

	async function expandFindingsSection(): Promise<void> {
		const sectionButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Findings" || button.textContent?.includes("Findings"),
		);
		expect(sectionButton).toBeDefined();
		await act(async () => {
			sectionButton?.click();
		});
	}

	it("无 sessionFindings 上下文时不渲染 findings section", async () => {
		await renderPanel({ queryPhase: "ready", projection: createProjection(), mapCollection: null });
		expect(container.textContent).not.toContain("Findings");
	});

	it("切片只含 provenanceLinks 命中当前会话的条目；archived 不进切片", async () => {
		await renderPanelWithFindings([
			createFinding({ findingId: "f-1", findingTitle: "本会话结论甲" }),
			createFinding({
				findingId: "f-2",
				findingTitle: "别的会话结论",
				provenanceLinks: [
					{
						linkKind: "turn_anchor",
						conversationSessionTaskId: "session-2",
						turnNumber: 1,
						turnCheckpointCommit: null,
					},
				],
			}),
			createFinding({ findingId: "f-3", findingStatus: "archived", findingTitle: "已归档的旧结论" }),
		]);
		await expandFindingsSection();
		expect(container.textContent).toContain("本会话结论甲");
		expect(container.textContent).not.toContain("别的会话结论");
		expect(container.textContent).not.toContain("已归档的旧结论");
	});

	it("待确认条目带角标（header 计数 + 行 badge）与行内确认/拒绝按钮", async () => {
		await renderPanelWithFindings([
			createFinding({
				findingId: "f-pending",
				findingStatus: "suggested_pending_confirmation",
				findingTitle: "待确认建议",
			}),
		]);
		// header 角标在折叠态也可见。
		expect(container.textContent).toContain("1 to confirm");
		await expandFindingsSection();
		expect(container.textContent).toContain("Pending confirmation");

		await act(async () => {
			(
				container.querySelector("button[aria-label='Confirm finding 待确认建议']") as HTMLButtonElement | null
			)?.click();
		});
		expect(confirmFindingMock).toHaveBeenCalledWith("workspace-1", "f-pending");
		await act(async () => {
			(
				container.querySelector("button[aria-label='Reject finding 待确认建议']") as HTMLButtonElement | null
			)?.click();
		});
		expect(rejectFindingMock).toHaveBeenCalledWith("workspace-1", "f-pending");
	});

	it("确认/拒绝失败时 toast 报错（notifyError）", async () => {
		confirmFindingMock.mockImplementation(async () => {
			throw new Error("状态机违规");
		});
		await renderPanelWithFindings([
			createFinding({
				findingId: "f-pending",
				findingStatus: "suggested_pending_confirmation",
				findingTitle: "待确认建议",
			}),
		]);
		await expandFindingsSection();
		await act(async () => {
			(
				container.querySelector("button[aria-label='Confirm finding 待确认建议']") as HTMLButtonElement | null
			)?.click();
		});
		expect(notifyErrorMock).toHaveBeenCalledWith("状态机违规");
	});

	it("点击条目展开正文（简单展开，不做深链跳转）", async () => {
		await renderPanelWithFindings([createFinding({ findingTitle: "本会话结论甲" })]);
		await expandFindingsSection();
		expect(container.textContent).not.toContain("结论正文全文");
		const rowButton = Array.from(container.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("本会话结论甲"),
		);
		expect(rowButton).toBeDefined();
		await act(async () => {
			rowButton?.click();
		});
		expect(container.textContent).toContain("结论正文全文");
	});

	it("findings 未加载（null）时 section 显示加载态", async () => {
		await renderPanelWithFindings(null);
		await expandFindingsSection();
		expect(container.textContent).toContain("Loading findings…");
	});
});
