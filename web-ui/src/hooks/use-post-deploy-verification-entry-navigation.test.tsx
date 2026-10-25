import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimePostDeployVerificationEntryNavigationTarget, RuntimeProjectSummary } from "@/runtime/types";
import { usePostDeployVerificationEntryNavigation } from "./use-post-deploy-verification-entry-navigation";

const toast = vi.hoisted(() => vi.fn());
vi.mock("@/components/app-toaster", () => ({ showAppToast: toast }));
let container: HTMLDivElement;
let root: Root;
let controller: ReturnType<typeof usePostDeployVerificationEntryNavigation>;
type Inputs = Parameters<typeof usePostDeployVerificationEntryNavigation>[0];
const sourceTarget: RuntimePostDeployVerificationEntryNavigationTarget = {
	entry: { workspaceId: "source-project", deploymentId: "deployment", taskId: "source" },
	navigationKind: "follow_up_origin_entry",
	availability: "retained",
	deployedAtIso: null,
	selectedChecklistItemIds: [],
};
function inputs(): Inputs {
	return {
		currentWorkspaceId: "current-project",
		selectedBoardOrSingleProjectScope: "single_project_scope",
		projects: [{ id: "source-project", availability: { status: "available" } } as RuntimeProjectSummary],
	};
}
function Harness({ input }: { input: Inputs }) {
	controller = usePostDeployVerificationEntryNavigation(input);
	return null;
}
function render(input = inputs()) {
	act(() => root.render(<Harness input={input} />));
}
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.clearAllMocks();
	container = document.body.appendChild(document.createElement("div"));
	root = createRoot(container);
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});
describe("Task 的部署后验证定位请求生命周期", () => {
	it("从查询起点登记意图，拒绝已取消或不属于当前宿主的信号", () => {
		render();
		let first!: AbortSignal;
		let second!: AbortSignal;
		act(() => {
			first = controller.beginNavigationIntent();
			second = controller.beginNavigationIntent();
		});
		expect(first.aborted).toBe(true);
		act(() => {
			expect(controller.requestNavigation(sourceTarget, first)).toBe(false);
			expect(controller.requestNavigation(sourceTarget, new AbortController().signal)).toBe(false);
			expect(controller.requestNavigation(sourceTarget, second)).toBe(true);
		});
		expect(controller.explicitEntryNavigationWorkspaceId).toBe("source-project");
		act(() => controller.clearNavigation());
		expect(second.aborted).toBe(true);
		act(() => {
			expect(controller.requestNavigation(sourceTarget, second)).toBe(false);
		});
		expect(controller.entryNavigationRequest).toBeNull();
		expect(toast).not.toHaveBeenCalled();
	});
	it("新查询保留跨项目面板绑定并取消前次待定位，关闭才释放绑定", () => {
		render();
		act(() => {
			controller.requestNavigation(sourceTarget);
		});
		act(() => {
			controller.beginNavigationIntent();
		});
		expect(controller.explicitEntryNavigationWorkspaceId).toBe("source-project");
		expect(controller.entryNavigationRequest).toBeNull();
		act(() => controller.clearNavigation());
		expect(controller.explicitEntryNavigationWorkspaceId).toBeNull();
	});
	it("来源项目不可用时拒绝导航，恢复后可重试", () => {
		render({ ...inputs(), projects: [] });
		act(() => {
			expect(controller.requestNavigation(sourceTarget)).toBe(false);
		});
		expect(controller.explicitEntryNavigationWorkspaceId).toBeNull();
		expect(toast).toHaveBeenCalled();
		render();
		act(() => {
			expect(controller.requestNavigation(sourceTarget)).toBe(true);
		});
		expect(controller.explicitEntryNavigationWorkspaceId).toBe("source-project");
	});
	it("迟到的旧完成回调不能吞掉新请求；定位完成后保持项目绑定直至关闭", () => {
		render();
		act(() => {
			controller.requestNavigation(sourceTarget);
		});
		const firstId = controller.entryNavigationRequest!.requestId;
		act(() => {
			controller.requestNavigation(sourceTarget);
		});
		const secondId = controller.entryNavigationRequest!.requestId;
		act(() => controller.finishNavigation(firstId));
		expect(controller.entryNavigationRequest?.requestId).toBe(secondId);
		act(() => controller.finishNavigation(secondId));
		expect(controller.entryNavigationRequest).toBeNull();
		expect(controller.explicitEntryNavigationWorkspaceId).toBe("source-project");
		act(() => controller.clearNavigation());
		expect(controller.explicitEntryNavigationWorkspaceId).toBeNull();
	});
	it("切换看板范围后取消旧定位", () => {
		render();
		act(() => {
			controller.requestNavigation(sourceTarget);
		});
		render({ ...inputs(), selectedBoardOrSingleProjectScope: "board_scope_all_projects" });
		expect(controller.entryNavigationRequest).toBeNull();
		expect(controller.explicitEntryNavigationWorkspaceId).toBeNull();
	});
});
