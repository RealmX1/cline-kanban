import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePostDeployVerificationEntryNavigation } from "@/hooks/use-post-deploy-verification-entry-navigation";
import type { RuntimePostDeployVerificationEntryNavigationTarget, RuntimeProjectSummary } from "@/runtime/types";
import { PostDeployVerificationEntryNavigationButton } from "./post-deploy-verification-entry-navigation-button";
import { PostDeployVerificationEntryNavigationHostProvider } from "./post-deploy-verification-entry-navigation-host-context";

const fetchTargets = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());
vi.mock("@/runtime/post-deploy-verification-entry-navigation-query", () => ({
	fetchTaskPostDeployVerificationEntryNavigationTargets: fetchTargets,
}));
vi.mock("@/components/app-toaster", () => ({ showAppToast: toast }));
let root: Root;
let container: HTMLDivElement;
const own: RuntimePostDeployVerificationEntryNavigationTarget = {
	entry: { workspaceId: "project", deploymentId: "deployment", taskId: "task" },
	navigationKind: "task_own_entry",
	availability: "retained",
	deployedAtIso: "2026-10-25T00:00:00Z",
	selectedChecklistItemIds: [],
};
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.resetAllMocks();
	container = document.body.appendChild(document.createElement("div"));
	root = createRoot(container);
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});
function render(taskId = "task") {
	const navigateToEntry = vi.fn();
	const selectCard = vi.fn();
	act(() =>
		root.render(
			<PostDeployVerificationEntryNavigationHostProvider
				value={{
					workspaceIdOwningHydratedBoard: "project",
					beginNavigationIntent: () => new AbortController().signal,
					navigateToEntry,
				}}
			>
				<div onClick={selectCard}>
					<PostDeployVerificationEntryNavigationButton taskId={taskId} />
				</div>
			</PostDeployVerificationEntryNavigationHostProvider>,
		),
	);
	return { navigateToEntry, selectCard };
}
async function click(label: string) {
	const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
		(b) => b.getAttribute("aria-label") === label || b.textContent?.includes(label),
	);
	if (!button) throw new Error(`找不到按钮 ${label}`);
	await act(async () => button.click());
}
describe("Task 的 PDV 定位快捷入口", () => {
	it("只在点击时读取，单个目标直接导航，事件不打开 Task", async () => {
		fetchTargets.mockResolvedValue({ targets: [own], originEntriesReadError: null });
		const handlers = render();
		expect(fetchTargets).not.toHaveBeenCalled();
		await click("定位部署后验证");
		expect(fetchTargets).toHaveBeenCalledWith({ workspaceId: "project", taskId: "task" });
		expect(handlers.navigateToEntry).toHaveBeenCalledWith(own, expect.any(AbortSignal));
		expect(handlers.selectCard).not.toHaveBeenCalled();
	});
	it("自身和来源同时存在时列出选项，可直接选择来源记录", async () => {
		const origin = {
			...own,
			entry: { ...own.entry, taskId: "source", workspaceId: "source-project" },
			navigationKind: "follow_up_origin_entry" as const,
		};
		fetchTargets.mockResolvedValue({ targets: [own, origin], originEntriesReadError: null });
		const handlers = render();
		await click("定位部署后验证");
		expect(handlers.navigateToEntry).not.toHaveBeenCalled();
		await click("来源任务的验证");
		expect(handlers.navigateToEntry).toHaveBeenCalledWith(origin, expect.any(AbortSignal));
	});
	it("读取失败与没有记录分别反馈，失败后再次点击可以重试", async () => {
		fetchTargets
			.mockRejectedValueOnce(new Error("连接中断"))
			.mockResolvedValueOnce({ targets: [], originEntriesReadError: null });
		render();
		await click("定位部署后验证");
		expect(toast).toHaveBeenLastCalledWith(expect.objectContaining({ message: expect.stringContaining("连接中断") }));
		await click("定位部署后验证");
		expect(toast).toHaveBeenLastCalledWith(expect.objectContaining({ message: expect.stringContaining("暂无保留") }));
	});
	it("来源不可读时仍可打开已知自身记录，并保留未知状态提示", async () => {
		fetchTargets.mockResolvedValue({ targets: [own], originEntriesReadError: "关系账本暂不可用" });
		const handlers = render();
		await click("定位部署后验证");
		expect(handlers.navigateToEntry).toHaveBeenCalledWith(own, expect.any(AbortSignal));
		expect(toast).toHaveBeenCalledWith(expect.objectContaining({ message: "关系账本暂不可用" }));
	});
});

let navigationController: ReturnType<typeof usePostDeployVerificationEntryNavigation>;
function SharedNavigationHost({
	workspaceId = "project",
	boardScope = false,
}: {
	workspaceId?: string;
	boardScope?: boolean;
}) {
	navigationController = usePostDeployVerificationEntryNavigation({
		currentWorkspaceId: workspaceId,
		selectedBoardOrSingleProjectScope: boardScope ? "board_scope_all_projects" : "single_project_scope",
		projects: [{ id: "project", availability: { status: "available" } } as RuntimeProjectSummary],
	});
	return (
		<PostDeployVerificationEntryNavigationHostProvider
			value={{
				workspaceIdOwningHydratedBoard: "project",
				beginNavigationIntent: navigationController.beginNavigationIntent,
				navigateToEntry: navigationController.requestNavigation,
			}}
		>
			<PostDeployVerificationEntryNavigationButton taskId="first" workspaceId="project" />
			<PostDeployVerificationEntryNavigationButton taskId="second" workspaceId="project" />
		</PostDeployVerificationEntryNavigationHostProvider>
	);
}
function pendingTargets() {
	let resolve!: (result: {
		targets: RuntimePostDeployVerificationEntryNavigationTarget[];
		originEntriesReadError: string | null;
	}) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<Parameters<typeof resolve>[0]>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}
function navigationButtons() {
	return Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-label="定位部署后验证"]'));
}
describe("宿主统一取消定位意图", () => {
	it("跨按钮逆序返回时最后点击的目标获胜，前一个按钮立即恢复可用", async () => {
		const first = pendingTargets();
		const second = pendingTargets();
		fetchTargets.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		act(() => root.render(<SharedNavigationHost />));
		await act(async () => navigationButtons()[0]!.click());
		await act(async () => navigationButtons()[1]!.click());
		const firstButtonCanceledBeforeResponse = !navigationButtons()[0]!.disabled;
		const secondTarget = { ...own, entry: { ...own.entry, taskId: "second" } };
		await act(async () => second.resolve({ targets: [secondTarget], originEntriesReadError: null }));
		await act(async () => first.resolve({ targets: [own], originEntriesReadError: null }));
		expect(navigationController.entryNavigationRequest?.target).toEqual(secondTarget);
		expect(firstButtonCanceledBeforeResponse).toBe(true);
	});
	it.each(
		["关闭面板", "切换项目", "切换看板范围"].flatMap((cancellation) =>
			[true, false].map((multipleTargets) => ({ cancellation, multipleTargets })),
		),
	)(
		"$cancellation 后迟到查询不得重新定位或显示选择（多目标：$multipleTargets）",
		async ({ cancellation, multipleTargets }) => {
			const pending = pendingTargets();
			fetchTargets.mockReturnValueOnce(pending.promise);
			act(() => root.render(<SharedNavigationHost />));
			await act(async () => navigationButtons()[0]!.click());
			act(() => {
				if (cancellation === "关闭面板") navigationController.clearNavigation();
				else
					root.render(
						<SharedNavigationHost
							workspaceId={cancellation === "切换项目" ? "other" : "project"}
							boardScope={cancellation === "切换看板范围"}
						/>,
					);
			});
			const buttonCanceledBeforeResponse = !navigationButtons()[0]!.disabled;
			await act(async () =>
				pending.resolve({
					targets: multipleTargets ? [own, { ...own, entry: { ...own.entry, taskId: "other" } }] : [own],
					originEntriesReadError: "过期警告",
				}),
			);
			expect(navigationController.entryNavigationRequest).toBeNull();
			expect(document.querySelector('[aria-label="选择部署后验证记录"]')).toBeNull();
			expect(toast).not.toHaveBeenCalled();
			expect(buttonCanceledBeforeResponse).toBe(true);
		},
	);
	it("取消后忽略异步错误，并可立即发起新查询", async () => {
		const pending = pendingTargets();
		fetchTargets
			.mockReturnValueOnce(pending.promise)
			.mockResolvedValueOnce({ targets: [own], originEntriesReadError: null });
		act(() => root.render(<SharedNavigationHost />));
		await act(async () => navigationButtons()[0]!.click());
		act(() => navigationController.clearNavigation());
		await act(async () => navigationButtons()[0]!.click());
		await act(async () => pending.reject(new Error("过期错误")));
		expect(navigationController.entryNavigationRequest?.target).toEqual(own);
		expect(toast).not.toHaveBeenCalled();
	});
	it.each(["取消意图", "新建意图"])("%s 关闭旧多目标选择，旧选项无法再导航", async (action) => {
		fetchTargets.mockResolvedValueOnce({
			targets: [own, { ...own, entry: { ...own.entry, taskId: "other" } }],
			originEntriesReadError: null,
		});
		act(() => root.render(<SharedNavigationHost />));
		await act(async () => navigationButtons()[0]!.click());
		const oldOption = document.querySelector<HTMLButtonElement>('[aria-label="选择部署后验证记录"] button')!;
		expect(oldOption).not.toBeNull();
		act(() => {
			if (action === "取消意图") navigationController.clearNavigation();
			else navigationController.beginNavigationIntent();
			oldOption.click();
		});
		expect(navigationController.entryNavigationRequest).toBeNull();
		expect(document.querySelector('[aria-label="选择部署后验证记录"]')).toBeNull();
	});
});
