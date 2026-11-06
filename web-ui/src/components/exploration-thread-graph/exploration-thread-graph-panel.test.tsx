import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ExplorationThreadGraphPanel } from "@/components/exploration-thread-graph/exploration-thread-graph-panel";

it.each(["ready", "loading", "error"] as const)("合并标题的探索地图在 %s 时保留折叠按钮名称", async (queryPhase) => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const container = document.body.appendChild(document.createElement("div"));
	const root = createRoot(container);
	try {
		await act(async () =>
			root.render(
				<ExplorationThreadGraphPanel
					workspaceId="workspace-1"
					explorationId="task-1"
					headerNavigationContent={<span>区域导航</span>}
					data={{ queryPhase, view: null, turnSourceUnavailableSessionIds: [] }}
				/>,
			),
		);
		const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="展开探索地图内容"]');
		expect(toggle).not.toBeNull();
		expect(toggle!.getAttribute("aria-expanded")).toBe("false");
		await act(async () => toggle!.click());
		expect(toggle!.getAttribute("aria-label")).toBe("收起探索地图内容");
		expect(toggle!.getAttribute("aria-expanded")).toBe("true");
	} finally {
		act(() => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	}
});
