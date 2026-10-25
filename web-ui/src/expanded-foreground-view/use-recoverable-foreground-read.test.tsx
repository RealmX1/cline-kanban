import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRecoverableForegroundRead } from "@/expanded-foreground-view/use-recoverable-foreground-read";

vi.mock("@/stores/task-visualization-browser-bridge", () => ({
	subscribeToTaskVisualizationBrowserEvents: () => () => undefined,
}));
type Snapshot = ReturnType<typeof useRecoverableForegroundRead<string>>;
function Harness({
	identity,
	read,
	observe,
}: {
	identity: string;
	read: (signal: AbortSignal) => Promise<string>;
	observe: (snapshot: Snapshot) => void;
}) {
	const snapshot = useRecoverableForegroundRead({ identity, read });
	useEffect(() => observe(snapshot), [observe, snapshot]);
	return null;
}
describe("前台只读请求的有界恢复与归属", () => {
	let root: Root;
	let container: HTMLDivElement;
	let latest: Snapshot | null;
	const observe = (snapshot: Snapshot) => {
		latest = snapshot;
	};
	beforeEach(() => {
		vi.useFakeTimers();
		latest = null;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});
	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		vi.useRealTimers();
	});
	it("临时故障只自动重试两次，随后显示失败；恢复事件可重新补读", async () => {
		const read = vi.fn().mockRejectedValue(new Error("运行时暂不可用"));
		await act(async () => root.render(<Harness identity="a" read={read} observe={observe} />));
		await act(async () => vi.advanceTimersByTimeAsync(400));
		await act(async () => vi.advanceTimersByTimeAsync(1_200));
		expect(read).toHaveBeenCalledTimes(3);
		expect(latest).toMatchObject({ loading: false, error: "运行时暂不可用" });
		read.mockResolvedValue("已恢复");
		await act(async () => window.dispatchEvent(new Event("online")));
		expect(latest).toMatchObject({ value: "已恢复", error: null, loading: false });
	});
	it("缺失身份不重复尝试，也不替换为其他任务", async () => {
		const read = vi.fn().mockRejectedValue({ message: "身份不存在", data: { code: "NOT_FOUND" } });
		await act(async () => root.render(<Harness identity="a" read={read} observe={observe} />));
		await act(async () => vi.advanceTimersByTimeAsync(30_000));
		expect(read).toHaveBeenCalledTimes(1);
		expect(latest?.loading).toBe(false);
	});
	it("切换目标取消旧请求，迟到结果不能覆盖当前内容", async () => {
		let oldSignal: AbortSignal | null = null;
		let resolveOld: (value: string) => void = () => undefined;
		const oldRead = (signal: AbortSignal) => {
			oldSignal = signal;
			return new Promise<string>((resolve) => {
				resolveOld = resolve;
			});
		};
		const nextRead = vi.fn().mockResolvedValue("目标 B");
		await act(async () => root.render(<Harness identity="a" read={oldRead} observe={observe} />));
		await act(async () => root.render(<Harness identity="b" read={nextRead} observe={observe} />));
		expect(oldSignal).toHaveProperty("aborted", true);
		await act(async () => resolveOld("迟到的目标 A"));
		expect(latest).toMatchObject({ identity: "b", value: "目标 B" });
	});
});
