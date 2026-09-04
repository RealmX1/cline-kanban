import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionMapAnchorChip } from "@/components/session-map/session-map-anchor-chip";

// 反注入铁律（蓝图 §C.1）的渲染侧回归测试：chip 显示内容恒来自服务端 map 集合
// （resolver 命中），id 不可解析 → 不渲染；marker 内嵌的任何内容永远到不了 UI。

describe("SessionMapAnchorChip", () => {
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

	it("id 在 map 集合不可解析时不渲染任何内容", async () => {
		await act(async () => {
			root.render(<SessionMapAnchorChip mapNodeId="agent-invented-id" resolve={() => null} />);
		});
		expect(container.innerHTML).toBe("");
	});

	it("可解析时渲染服务端节点的标题，点击回调携带 mapNodeId", async () => {
		const onClick = vi.fn();
		await act(async () => {
			root.render(
				<SessionMapAnchorChip
					mapNodeId="node-1"
					resolve={(mapNodeId) =>
						mapNodeId === "node-1" ? { nodeTitle: "定了存储方案", nodeKind: "decision_point" } : null
					}
					onClick={onClick}
				/>,
			);
		});
		const chipButton = container.querySelector("button");
		expect(chipButton).not.toBeNull();
		expect(chipButton?.textContent).toBe("定了存储方案");
		await act(async () => {
			chipButton?.click();
		});
		expect(onClick).toHaveBeenCalledWith("node-1");
	});

	it("未注入 onClick 时仍渲染（纯展示），点击不抛错", async () => {
		await act(async () => {
			root.render(
				<SessionMapAnchorChip
					mapNodeId="node-1"
					resolve={() => ({ nodeTitle: "Milestone A", nodeKind: "milestone" })}
				/>,
			);
		});
		const chipButton = container.querySelector("button");
		expect(chipButton?.textContent).toBe("Milestone A");
		await act(async () => {
			chipButton?.click();
		});
	});
});
