import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createInitialBoardData } from "@/data/board-data";
import { usePostDeployVerification } from "@/hooks/use-post-deploy-verification";
import type { RuntimePostDeployVerificationDeploymentGroup } from "@/runtime/types";
import { PostDeployVerificationPanel, type PostDeployVerificationPanelProps } from "./post-deploy-verification-panel";
import { createPostDeployVerificationTaskReadModelTestFixture } from "./post-deploy-verification-task-read-model-test-fixtures";

const getVerificationStateQueryMock = vi.hoisted(() => vi.fn());
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		deployment: { getPostDeployVerificationState: { query: getVerificationStateQueryMock } },
	}),
}));
vi.mock("@/hooks/use-document-visibility", () => ({ useDocumentVisibility: () => true }));

const showAppToastMock = vi.hoisted(() => vi.fn());
vi.mock("@/components/app-toaster", () => ({ showAppToast: showAppToastMock }));

let container: HTMLDivElement;
let root: Root;
const scrollIntoView = vi.fn();
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
const group: RuntimePostDeployVerificationDeploymentGroup = {
	deploymentId: "11111111-1111-4111-8111-111111111111",
	workspaceId: "source-project",
	deployedSourceCommit: "abcdef",
	previousDeployedSourceCommit: null,
	deployedAtIso: "2026-10-01T00:00:00Z",
	foldedAtIso: "2026-10-02T00:00:00Z",
	tasks: [createPostDeployVerificationTaskReadModelTestFixture()],
};
function props(): PostDeployVerificationPanelProps {
	return {
		entryNavigationReadModelRequest: { workspaceId: group.workspaceId, requestId: 1 },
		activeGroup: null,
		historyGroups: [group],
		hasLoadedOnce: true,
		loadError: null,
		board: createInitialBoardData(),
		realTaskCardRenderingInputs: null,
		postDeployVerificationWorkspaceProjectNameShownInPanelHeader: "来源项目",
		stayInFront: true,
		collapsed: false,
		loweredForDialog: false,
		isBatchClosureWithReasonsInFlight: false,
		completingTaskId: null,
		onToggleStayInFront: vi.fn(),
		onToggleCollapsed: vi.fn(),
		onRequestBatchClosureWithReasonsOfZoneTasks: vi.fn(),
		onToggleChecklistItem: vi.fn(),
		onAddCustomChecklistItem: vi.fn(),
		onRemoveCustomChecklistItem: vi.fn(),
		onRunVerificationItem: vi.fn(),
		onRequestComplete: vi.fn(),
		onSelectTask: vi.fn(),
		onNavigateToBoard: vi.fn(),
		onCreateFollowUpTaskFromChecklistItems: vi.fn(),
		onEntryNavigationFinished: vi.fn(),
		entryNavigationRequest: {
			requestId: 1,
			target: {
				entry: { workspaceId: group.workspaceId, deploymentId: group.deploymentId, taskId: "task-1" },
				navigationKind: "follow_up_origin_entry",
				availability: "retained",
				deployedAtIso: group.deployedAtIso,
				selectedChecklistItemIds: [],
			},
		},
	};
}
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.useFakeTimers();
	scrollIntoView.mockClear();
	showAppToastMock.mockClear();
	getVerificationStateQueryMock.mockReset();
	HTMLElement.prototype.scrollIntoView = scrollIntoView;
	container = document.body.appendChild(document.createElement("div"));
	root = createRoot(container);
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
	HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
	vi.useRealTimers();
	vi.unstubAllGlobals();
});
function render(input: PostDeployVerificationPanelProps) {
	act(() =>
		root.render(
			<TooltipProvider>
				<PostDeployVerificationPanel {...input} />
			</TooltipProvider>,
		),
	);
}
function PanelWithLiveReadModel({ input }: { input: PostDeployVerificationPanelProps }) {
	const verification = usePostDeployVerification(group.workspaceId, {
		pollingEnabled: false,
		showDeploymentNotifications: false,
	});
	return (
		<TooltipProvider>
			<PostDeployVerificationPanel
				{...input}
				activeGroup={verification.activeGroup}
				historyGroups={verification.historyGroups}
				hasLoadedOnce={verification.hasLoadedOnce}
				loadError={verification.loadError}
				entryNavigationReadModelRequest={verification.entryNavigationReadModelRequest}
				onRefreshEntryNavigationReadModel={verification.refreshAndReadActiveGroup}
				isVerificationWriteInFlight={verification.isVerificationWriteInFlight}
			/>
		</TooltipProvider>
	);
}

describe("精确部署条目的展开与高亮", () => {
	it("真实读模型与面板联动：已缓存缺目标的旧数据仍会刷新并定位最新目标", async () => {
		const input = props();
		getVerificationStateQueryMock.mockResolvedValueOnce({
			deploymentGroups: [{ ...group, tasks: [] }],
			activeDeploymentId: null,
		});
		await act(async () => root.render(<PanelWithLiveReadModel input={{ ...input, entryNavigationRequest: null }} />));
		expect(getVerificationStateQueryMock).toHaveBeenCalledTimes(1);
		let resolveLatestSnapshot!: (value: {
			deploymentGroups: RuntimePostDeployVerificationDeploymentGroup[];
			activeDeploymentId: null;
		}) => void;
		getVerificationStateQueryMock.mockReturnValueOnce(
			new Promise((resolve) => {
				resolveLatestSnapshot = resolve;
			}),
		);
		await act(async () => root.render(<PanelWithLiveReadModel input={input} />));
		expect(getVerificationStateQueryMock).toHaveBeenCalledTimes(2);
		expect(input.onEntryNavigationFinished).not.toHaveBeenCalled();
		expect(showAppToastMock).not.toHaveBeenCalled();
		await act(async () => {
			resolveLatestSnapshot({ deploymentGroups: [group], activeDeploymentId: null });
		});
		await act(async () => vi.advanceTimersByTimeAsync(64));
		expect(document.activeElement?.classList.contains("verification-spotlight-active")).toBe(true);
		expect(input.onEntryNavigationFinished).toHaveBeenCalledWith(1);
	});
	it("旧缓存缺目标时保留定位请求，新快照到达后接续高亮", async () => {
		const input = props();
		render({ ...input, entryNavigationReadModelRequest: null, historyGroups: [{ ...group, tasks: [] }] });
		expect(input.onEntryNavigationFinished).not.toHaveBeenCalled();
		render(input);
		await act(async () => vi.advanceTimersByTimeAsync(64));
		expect(document.activeElement?.classList.contains("verification-spotlight-active")).toBe(true);
		expect(input.onEntryNavigationFinished).toHaveBeenCalledWith(1);
	});
	it("只有当前项目及本次请求的新快照才能宣告目标已清理", () => {
		const input = { ...props(), historyGroups: [] };
		render({ ...input, entryNavigationReadModelRequest: { workspaceId: group.workspaceId, requestId: 0 } });
		render({ ...input, entryNavigationReadModelRequest: { workspaceId: "another-workspace", requestId: 1 } });
		expect(input.onEntryNavigationFinished).not.toHaveBeenCalled();
		expect(showAppToastMock).not.toHaveBeenCalled();
		render(input);
		expect(input.onEntryNavigationFinished).toHaveBeenCalledWith(1);
		expect(showAppToastMock).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringContaining("已不在保留记录") }),
		);
	});

	it("失败最多短重试三次，不误报清理，后续有效刷新自动恢复定位", async () => {
		const onRefreshEntryNavigationReadModel = vi.fn(async () => {
			throw new Error("网络中断");
		});
		const input = { ...props(), onRefreshEntryNavigationReadModel };
		render({ ...input, entryNavigationReadModelRequest: null, loadError: "网络中断" });
		await act(async () => vi.advanceTimersByTimeAsync(5_000));
		expect(onRefreshEntryNavigationReadModel).toHaveBeenCalledTimes(3);
		expect(input.onEntryNavigationFinished).not.toHaveBeenCalled();
		expect(showAppToastMock).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringContaining("已保留定位请求") }),
		);
		render(input);
		await act(async () => vi.advanceTimersByTimeAsync(64));
		expect(document.activeElement?.classList.contains("verification-spotlight-active")).toBe(true);
		expect(input.onEntryNavigationFinished).toHaveBeenCalledWith(1);
		expect(onRefreshEntryNavigationReadModel).toHaveBeenCalledTimes(3);
	});

	it("关闭面板取消失败重试与迟到响应，不再移动焦点", async () => {
		let rejectRead!: (error: Error) => void;
		const onRefreshEntryNavigationReadModel = vi.fn(
			() =>
				new Promise<null>((_, reject) => {
					rejectRead = reject;
				}),
		);
		const input = { ...props(), onRefreshEntryNavigationReadModel, entryNavigationReadModelRequest: null };
		render(input);
		render({ ...input, collapsed: true, entryNavigationRequest: null });
		await act(async () => {
			rejectRead(new Error("迟到失败"));
			await vi.advanceTimersByTimeAsync(5_000);
		});
		expect(onRefreshEntryNavigationReadModel).toHaveBeenCalledTimes(1);
		expect(input.onEntryNavigationFinished).not.toHaveBeenCalled();
		expect(showAppToastMock).not.toHaveBeenCalled();
		expect(scrollIntoView).not.toHaveBeenCalled();
	});

	it("旧请求的迟到补证不能完成新定位，写入结束后会立即刷新", async () => {
		const onRefreshEntryNavigationReadModel = vi.fn(async () => null);
		const input = { ...props(), onRefreshEntryNavigationReadModel, isVerificationWriteInFlight: true };
		render(input);
		expect(onRefreshEntryNavigationReadModel).not.toHaveBeenCalled();
		const next = {
			...input,
			isVerificationWriteInFlight: false,
			entryNavigationRequest: { ...input.entryNavigationRequest!, requestId: 2 },
		};
		render(next);
		await act(async () => vi.advanceTimersByTimeAsync(64));
		expect(onRefreshEntryNavigationReadModel).toHaveBeenCalledWith({ workspaceId: group.workspaceId, requestId: 2 });
		expect(input.onEntryNavigationFinished).not.toHaveBeenCalled();
		render({ ...next, entryNavigationReadModelRequest: { workspaceId: group.workspaceId, requestId: 2 } });
		await act(async () => vi.advanceTimersByTimeAsync(64));
		expect(input.onEntryNavigationFinished).toHaveBeenCalledWith(2);
	});

	it("自动展开历史组和核对清单，将焦点及高亮落在精确条目", async () => {
		const input = props();
		render(input);
		await act(async () => vi.advanceTimersByTimeAsync(64));
		const target = document.querySelector<HTMLElement>("[data-post-deploy-verification-entry-navigation-key]");
		expect(target?.classList.contains("verification-spotlight-active")).toBe(true);
		expect(document.activeElement).toBe(target);
		expect(scrollIntoView).toHaveBeenCalled();
		expect(target?.querySelector('button[aria-expanded="true"]')).not.toBeNull();
		expect(input.onEntryNavigationFinished).toHaveBeenCalledWith(1);
		expect(input.onToggleChecklistItem).not.toHaveBeenCalled();
	});
	it("对同一来源再次定位会重新展开清单，不被上一轮已定位状态吞掉", async () => {
		const input = props();
		render(input);
		await act(async () => vi.advanceTimersByTimeAsync(64));
		const toggle = document.querySelector<HTMLButtonElement>(
			'[data-post-deploy-verification-task-entry] button[aria-expanded="true"]',
		);
		act(() => toggle?.click());
		expect(toggle?.getAttribute("aria-expanded")).toBe("false");
		render({
			...input,
			entryNavigationReadModelRequest: { workspaceId: group.workspaceId, requestId: 2 },
			entryNavigationRequest: { ...input.entryNavigationRequest!, requestId: 2 },
		});
		await act(async () => vi.advanceTimersByTimeAsync(64));
		expect(toggle?.getAttribute("aria-expanded")).toBe("true");
		expect(input.onEntryNavigationFinished).toHaveBeenCalledWith(2);
	});
});
