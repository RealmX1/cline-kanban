import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useExpandedForegroundViewNavigation } from "@/expanded-foreground-view/expanded-foreground-view-context";
import {
	buildExpandedForegroundViewUrl,
	type ExpandedForegroundViewTarget,
} from "@/expanded-foreground-view/expanded-foreground-view-navigation";
import { ExpandedForegroundViewProvider } from "@/expanded-foreground-view/expanded-foreground-view-provider";
import { ExpandedForegroundViewSurface } from "@/expanded-foreground-view/expanded-foreground-view-surface";
import { useExpandedForegroundViewSurface } from "@/expanded-foreground-view/use-expanded-foreground-view-surface";

vi.mock("@/expanded-foreground-view/expanded-foreground-view-detached-content", () => ({
	ExpandedForegroundViewDetachedContent: ({ target }: { target: ExpandedForegroundViewTarget }) => (
		<div
			data-detached-target={`${target.workspaceId}/${target.taskId}`}
			data-target-identity={JSON.stringify(target)}
		/>
	),
}));
const target = {
	viewKind: "task_relations" as const,
	workspaceId: "source",
	taskId: "original",
	taskIncarnationCreatedAtEpochMs: 10,
};
const contentMounted = vi.fn();
function MountedContent() {
	useEffect(() => {
		contentMounted();
	}, []);
	return <iframe title="保留的内容" />;
}
function SourcePanel({ sourceTarget = target }: { sourceTarget?: ExpandedForegroundViewTarget }) {
	const surface = useExpandedForegroundViewSurface(sourceTarget);
	const navigation = useExpandedForegroundViewNavigation();
	return (
		<>
			<button
				type="button"
				onClick={() =>
					navigation?.open({ ...target, workspaceId: "other-project", taskIncarnationCreatedAtEpochMs: 20 })
				}
			>
				打开跨项目关系图
			</button>
			<ExpandedForegroundViewSurface controller={surface} title="来源面板">
				<button
					type="button"
					onClick={() => {
						navigation?.dismissForTaskNavigation();
						window.history.replaceState({ taskNavigation: true }, "", "/other-project?task=destination");
					}}
				>
					打开目标任务
				</button>
				<button type="button" onClick={surface.open}>
					展开来源面板
				</button>
				<MountedContent />
			</ExpandedForegroundViewSurface>
		</>
	);
}

function ExpandedForegroundNavigationTestControls({
	nextTarget,
	preserveSourceSurfaceOwner = false,
}: {
	nextTarget: ExpandedForegroundViewTarget;
	preserveSourceSurfaceOwner?: boolean;
}) {
	const navigation = useExpandedForegroundViewNavigation();
	return (
		<>
			<button
				type="button"
				onClick={() =>
					navigation?.open(
						nextTarget,
						preserveSourceSurfaceOwner ? (navigation.ownerSurfaceId ?? undefined) : undefined,
					)
				}
			>
				切换前台内容
			</button>
			<button type="button" onClick={() => navigation?.close()}>
				返回所属任务
			</button>
		</>
	);
}

describe("前台宿主生命周期与浏览器历史", () => {
	let root: Root;
	let container: HTMLDivElement;
	beforeEach(() => {
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		window.history.replaceState({ otherFeature: "retained" }, "", "/source?task=original");
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		contentMounted.mockClear();
	});
	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		vi.restoreAllMocks();
	});
	function button(text: string) {
		const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
			(entry) => entry.textContent === text,
		);
		if (!found) throw new Error(`没有按钮：${text}`);
		return found;
	}
	it("任务导航同步退出展开层，不调用异步 back，也不覆盖后续任务导航 URL", async () => {
		const back = vi.spyOn(window.history, "back");
		await act(async () =>
			root.render(
				<ExpandedForegroundViewProvider>
					<SourcePanel />
				</ExpandedForegroundViewProvider>,
			),
		);
		await act(async () => button("展开来源面板").click());
		expect(container.querySelector('[data-expanded-foreground-view="active"]')).not.toBeNull();
		await act(async () => button("打开目标任务").click());
		expect(container.querySelector('[data-expanded-foreground-view="active"]')).toBeNull();
		expect(back).not.toHaveBeenCalled();
		expect(window.location.pathname + window.location.search).toBe("/other-project?task=destination");
		expect(window.history.state.kanbanExpandedForegroundView).toBeUndefined();
		await act(async () => window.dispatchEvent(new PopStateEvent("popstate")));
		expect(window.location.pathname + window.location.search).toBe("/other-project?task=destination");
		expect(container.querySelector("[data-detached-target]")).toBeNull();
	});
	const expandedForegroundContentSwitchCases = [
		{
			name: "可视化版本",
			initialTarget: {
				...target,
				viewKind: "task_visualization",
				visualizationArtifactId: "artifact",
				revisionId: "v1",
			},
			nextTarget: {
				...target,
				viewKind: "task_visualization",
				visualizationArtifactId: "artifact",
				revisionId: "v2",
			},
		},
		{
			name: "Relations 中心",
			initialTarget: target,
			nextTarget: {
				...target,
				workspaceId: "other-project",
				taskId: "other-task",
				taskIncarnationCreatedAtEpochMs: 20,
			},
		},
	] as const satisfies readonly {
		name: string;
		initialTarget: ExpandedForegroundViewTarget;
		nextTarget: ExpandedForegroundViewTarget;
	}[];
	for (const entryMode of ["直接打开", "刷新后"] as const) {
		it.each(expandedForegroundContentSwitchCases)(
			`${entryMode}切换 $name 后返回所属任务，不误用浏览器后退`,
			async ({ initialTarget, nextTarget }) => {
				if (entryMode === "直接打开") {
					window.history.replaceState(
						{ otherFeature: "retained" },
						"",
						buildExpandedForegroundViewUrl(window.location.href, initialTarget),
					);
				} else {
					await act(async () =>
						root.render(
							<ExpandedForegroundViewProvider key="before-refresh">
								<ExpandedForegroundNavigationTestControls nextTarget={initialTarget} />
							</ExpandedForegroundViewProvider>,
						),
					);
					await act(async () => button("切换前台内容").click());
				}
				await act(async () =>
					root.render(
						<ExpandedForegroundViewProvider key="after-refresh">
							<ExpandedForegroundNavigationTestControls nextTarget={nextTarget} />
						</ExpandedForegroundViewProvider>,
					),
				);
				const historyBack = vi.spyOn(window.history, "back").mockImplementation(() => {});
				const historyPush = vi.spyOn(window.history, "pushState");
				const historyReplace = vi.spyOn(window.history, "replaceState");
				await act(async () => button("切换前台内容").click());
				expect(historyPush).not.toHaveBeenCalled();
				expect(historyReplace).toHaveBeenCalledTimes(1);
				expect(container.querySelector("[data-target-identity]")?.getAttribute("data-target-identity")).toBe(
					JSON.stringify(nextTarget),
				);
				await act(async () => button("返回所属任务").click());
				expect(historyBack).not.toHaveBeenCalled();
				expect(window.location.pathname).toBe(`/${nextTarget.workspaceId}`);
				expect(window.location.search).toBe(`?task=${nextTarget.taskId}`);
				expect(window.history.state.otherFeature).toBe("retained");
				expect(container.querySelector("[data-detached-target]")).toBeNull();
			},
		);
	}
	it("展开、替换版本、返回、前进保持同一个内容实例与 iframe 浏览上下文", async () => {
		await act(async () =>
			root.render(
				<ExpandedForegroundViewProvider>
					<SourcePanel sourceTarget={expandedForegroundContentSwitchCases[0].initialTarget} />
					<ExpandedForegroundNavigationTestControls
						nextTarget={expandedForegroundContentSwitchCases[0].nextTarget}
						preserveSourceSurfaceOwner
					/>
				</ExpandedForegroundViewProvider>,
			),
		);
		const frame = container.querySelector("iframe");
		const browsingContext = frame?.contentWindow;
		const trigger = button("展开来源面板");
		trigger.focus();
		await act(async () => trigger.click());
		expect(container.querySelector('[data-expanded-foreground-view="active"]')).not.toBeNull();
		expect(container.querySelector("iframe")).toBe(frame);
		expect(window.history.state.otherFeature).toBe("retained");
		const historyPush = vi.spyOn(window.history, "pushState");
		const historyReplace = vi.spyOn(window.history, "replaceState");
		await act(async () => button("切换前台内容").click());
		expect(historyPush).not.toHaveBeenCalled();
		expect(historyReplace).toHaveBeenCalledTimes(1);
		expect(new URLSearchParams(window.location.search).get("expandedVisualizationRevisionId")).toBe("v2");
		expect(container.querySelector("iframe")).toBe(frame);
		const back = new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));
		await act(async () => {
			button("返回").click();
			await back;
		});
		expect(window.location.search).toBe("?task=original");
		expect(container.querySelector("iframe")?.contentWindow).toBe(browsingContext);
		expect(document.activeElement).toBe(trigger);
		const forward = new Promise<void>((resolve) =>
			window.addEventListener("popstate", () => resolve(), { once: true }),
		);
		await act(async () => {
			window.history.forward();
			await forward;
		});
		expect(container.querySelector('[data-expanded-foreground-view="active"]')).not.toBeNull();
		expect(new URLSearchParams(window.location.search).get("expandedVisualizationRevisionId")).toBe("v2");
		expect(container.querySelector("iframe")).toBe(frame);
		expect(contentMounted).toHaveBeenCalledTimes(1);
	});
	it.each(["卸载", "切换任务"] as const)("返回后来源宿主%s，再前进会按完整目标恢复独立宿主", async (sourceChange) => {
		await act(async () =>
			root.render(
				<ExpandedForegroundViewProvider>
					<SourcePanel />
				</ExpandedForegroundViewProvider>,
			),
		);
		await act(async () => button("展开来源面板").click());
		const back = new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));
		await act(async () => {
			button("返回").click();
			await back;
		});
		await act(async () =>
			root.render(
				<ExpandedForegroundViewProvider>
					{sourceChange === "卸载" ? (
						<p>来源任务已离开</p>
					) : (
						<SourcePanel sourceTarget={{ ...target, taskIncarnationCreatedAtEpochMs: 20 }} />
					)}
				</ExpandedForegroundViewProvider>,
			),
		);
		const forward = new Promise<void>((resolve) =>
			window.addEventListener("popstate", () => resolve(), { once: true }),
		);
		await act(async () => {
			window.history.forward();
			await forward;
		});
		expect(
			JSON.parse(container.querySelector("[data-target-identity]")?.getAttribute("data-target-identity") ?? "null"),
		).toEqual(target);
		expect(window.history.state.kanbanExpandedForegroundView.ownerSurfaceId).toBeNull();
	});
	it("跨项目目标拥有独立身份，来源页面与内容继续挂载", async () => {
		await act(async () =>
			root.render(
				<ExpandedForegroundViewProvider>
					<SourcePanel />
				</ExpandedForegroundViewProvider>,
			),
		);
		await act(async () => button("打开跨项目关系图").click());
		expect(window.location.pathname).toBe("/source");
		expect(new URLSearchParams(window.location.search).get("task")).toBe("original");
		expect(container.querySelector('[data-detached-target="other-project/original"]')).not.toBeNull();
		expect(contentMounted).toHaveBeenCalledTimes(1);
	});
	it("来源宿主移除后按完整目标恢复独立宿主，历史前进不留下失效所有者", async () => {
		await act(async () =>
			root.render(
				<ExpandedForegroundViewProvider>
					<SourcePanel />
				</ExpandedForegroundViewProvider>,
			),
		);
		await act(async () => button("展开来源面板").click());
		await act(async () =>
			root.render(
				<ExpandedForegroundViewProvider>
					<p>来源任务已离开</p>
				</ExpandedForegroundViewProvider>,
			),
		);
		expect(container.querySelector('[data-detached-target="source/original"]')).not.toBeNull();
		expect(window.history.state.kanbanExpandedForegroundView.ownerSurfaceId).toBeNull();
	});
	it("前台按键不会触发背景快捷键，Esc 返回来源", async () => {
		const backgroundShortcut = vi.fn();
		document.addEventListener("keydown", backgroundShortcut);
		try {
			await act(async () =>
				root.render(
					<ExpandedForegroundViewProvider>
						<SourcePanel />
					</ExpandedForegroundViewProvider>,
				),
			);
			await act(async () => button("展开来源面板").click());
			await act(async () => button("返回").dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true })));
			const back = new Promise<void>((resolve) =>
				window.addEventListener("popstate", () => resolve(), { once: true }),
			);
			await act(async () => {
				button("返回").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
				await back;
			});
			expect(window.location.search).toBe("?task=original");
			expect(backgroundShortcut).not.toHaveBeenCalled();
		} finally {
			document.removeEventListener("keydown", backgroundShortcut);
		}
	});
});
