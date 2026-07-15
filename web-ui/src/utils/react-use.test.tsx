import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useBooleanLocalStorageValue, useJsonLocalStorageValue, useRawLocalStorageValue } from "@/utils/react-use";

// 回归测试背景：react-use useLocalStorage 的 `set` 回调依赖数组缺 state（最新 17.6.1 仍如此），
// 直接向它传函数式更新器会拿到首帧冻结的旧值——曾导致 Post-Deploy Verification 面板的
// 折叠/置顶按钮只能单向翻转一次、之后永久失效。这里断言三个 wrapper 的函数式更新器
// 始终基于最新值，防止回归。

type BooleanHookSnapshot = {
	value: boolean;
	setValue: ReturnType<typeof useBooleanLocalStorageValue>[1];
};

function BooleanHookHarness({
	storageKey,
	initialValue,
	onSnapshot,
}: {
	storageKey: string;
	initialValue: boolean;
	onSnapshot: (snapshot: BooleanHookSnapshot) => void;
}): null {
	const [value, setValue] = useBooleanLocalStorageValue(storageKey, initialValue);

	useEffect(() => {
		onSnapshot({ value, setValue });
	}, [onSnapshot, value, setValue]);

	return null;
}

type JsonHookSnapshot = {
	value: number;
	setValue: ReturnType<typeof useJsonLocalStorageValue<number>>[1];
};

function JsonHookHarness({
	storageKey,
	initialValue,
	onSnapshot,
}: {
	storageKey: string;
	initialValue: number;
	onSnapshot: (snapshot: JsonHookSnapshot) => void;
}): null {
	const [value, setValue] = useJsonLocalStorageValue<number>(storageKey, initialValue);

	useEffect(() => {
		onSnapshot({ value, setValue });
	}, [onSnapshot, value, setValue]);

	return null;
}

type PanelSide = "left" | "right";

function normalizePanelSide(value: string): PanelSide | null {
	return value === "left" || value === "right" ? value : null;
}

type RawHookSnapshot = {
	value: PanelSide;
	setValue: ReturnType<typeof useRawLocalStorageValue<PanelSide>>[1];
};

function RawHookHarness({
	storageKey,
	initialValue,
	onSnapshot,
}: {
	storageKey: string;
	initialValue: PanelSide;
	onSnapshot: (snapshot: RawHookSnapshot) => void;
}): null {
	const [value, setValue] = useRawLocalStorageValue<PanelSide>(storageKey, initialValue, normalizePanelSide);

	useEffect(() => {
		onSnapshot({ value, setValue });
	}, [onSnapshot, value, setValue]);

	return null;
}

describe("localStorage wrapper hooks (stale closure regression)", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		localStorage.clear();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
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
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	describe("useBooleanLocalStorageValue", () => {
		it("supports repeated functional toggles across the full round trip", async () => {
			let latestSnapshot: BooleanHookSnapshot | null = null;

			await act(async () => {
				root.render(
					<BooleanHookHarness
						storageKey="test.boolean-toggle"
						initialValue={false}
						onSnapshot={(snapshot) => {
							latestSnapshot = snapshot;
						}}
					/>,
				);
			});

			if (latestSnapshot === null) {
				throw new Error("Expected an initial hook snapshot.");
			}
			expect((latestSnapshot as BooleanHookSnapshot).value).toBe(false);

			await act(async () => {
				(latestSnapshot as BooleanHookSnapshot).setValue((current) => !current);
			});
			expect((latestSnapshot as BooleanHookSnapshot).value).toBe(true);

			// 修复前第二次 toggle 会基于首帧冻结值再算一次 !false=true，卡死在 true。
			await act(async () => {
				(latestSnapshot as BooleanHookSnapshot).setValue((current) => !current);
			});
			expect((latestSnapshot as BooleanHookSnapshot).value).toBe(false);
			expect(localStorage.getItem("test.boolean-toggle")).toBe("false");
		});

		it("applies a functional update on top of the latest literal set, not the first-render value", async () => {
			let latestSnapshot: BooleanHookSnapshot | null = null;

			await act(async () => {
				root.render(
					<BooleanHookHarness
						storageKey="test.boolean-literal-then-functional"
						initialValue={false}
						onSnapshot={(snapshot) => {
							latestSnapshot = snapshot;
						}}
					/>,
				);
			});

			if (latestSnapshot === null) {
				throw new Error("Expected an initial hook snapshot.");
			}

			await act(async () => {
				(latestSnapshot as BooleanHookSnapshot).setValue(true);
			});
			expect((latestSnapshot as BooleanHookSnapshot).value).toBe(true);

			await act(async () => {
				(latestSnapshot as BooleanHookSnapshot).setValue((current) => !current);
			});
			expect((latestSnapshot as BooleanHookSnapshot).value).toBe(false);
		});

		// 回归：latestValueRef 绝不能在写盘前被急切前移。react-use 的 `set` 把 localStorage.setItem
		// 与 setState 放在同一 try 块里并静默吞错——一次瞬时写盘失败会跳过 setState、显示值停在旧值。
		// 若此时急切前移 ref，下一次函数式 toggle 会基于「已前移但未持久化、也未显示」的幽灵值计算，
		// 白吃一次点击（!false=true 与已显示的 true 相同 -> React 跳过重渲染），永远翻不回去。
		it("does not eat a functional toggle after a transient localStorage write failure", async () => {
			let latestSnapshot: BooleanHookSnapshot | null = null;
			const storageKey = "test.boolean-transient-write-failure";

			await act(async () => {
				root.render(
					<BooleanHookHarness
						storageKey={storageKey}
						initialValue={false}
						onSnapshot={(snapshot) => {
							latestSnapshot = snapshot;
						}}
					/>,
				);
			});

			if (latestSnapshot === null) {
				throw new Error("Expected an initial hook snapshot.");
			}

			// 第一次 toggle：写盘成功 -> true。
			await act(async () => {
				(latestSnapshot as BooleanHookSnapshot).setValue((current) => !current);
			});
			expect((latestSnapshot as BooleanHookSnapshot).value).toBe(true);
			expect(localStorage.getItem(storageKey)).toBe("true");

			const realSetItem = Storage.prototype.setItem;
			let failNextWrite = true;
			const setItemSpy = vi
				.spyOn(Storage.prototype, "setItem")
				.mockImplementation((itemKey: string, itemValue: string) => {
					if (failNextWrite) {
						failNextWrite = false;
						throw new DOMException("Quota exceeded", "QuotaExceededError");
					}
					realSetItem.call(localStorage, itemKey, itemValue);
				});

			try {
				// 第二次 toggle：写盘瞬时失败 -> 显示值与持久化值都应停在 true，不被污染成 false。
				await act(async () => {
					(latestSnapshot as BooleanHookSnapshot).setValue((current) => !current);
				});
				expect((latestSnapshot as BooleanHookSnapshot).value).toBe(true);
				expect(localStorage.getItem(storageKey)).toBe("true");

				// 第三次 toggle：写盘已恢复。ref 未被上一次失败写盘污染，应正常翻回 false（点击未被白吃）。
				await act(async () => {
					(latestSnapshot as BooleanHookSnapshot).setValue((current) => !current);
				});
				expect((latestSnapshot as BooleanHookSnapshot).value).toBe(false);
				expect(localStorage.getItem(storageKey)).toBe("false");
			} finally {
				setItemSpy.mockRestore();
			}
		});
	});

	describe("useJsonLocalStorageValue", () => {
		it("applies functional updates based on the latest value", async () => {
			let latestSnapshot: JsonHookSnapshot | null = null;

			await act(async () => {
				root.render(
					<JsonHookHarness
						storageKey="test.json-counter"
						initialValue={0}
						onSnapshot={(snapshot) => {
							latestSnapshot = snapshot;
						}}
					/>,
				);
			});

			if (latestSnapshot === null) {
				throw new Error("Expected an initial hook snapshot.");
			}

			await act(async () => {
				(latestSnapshot as JsonHookSnapshot).setValue((current) => current + 1);
			});
			await act(async () => {
				(latestSnapshot as JsonHookSnapshot).setValue((current) => current + 1);
			});
			expect((latestSnapshot as JsonHookSnapshot).value).toBe(2);
			expect(localStorage.getItem("test.json-counter")).toBe("2");
		});
	});

	describe("useRawLocalStorageValue", () => {
		it("applies functional updates based on the latest value", async () => {
			let latestSnapshot: RawHookSnapshot | null = null;
			const flipPanelSide = (current: PanelSide): PanelSide => (current === "left" ? "right" : "left");

			await act(async () => {
				root.render(
					<RawHookHarness
						storageKey="test.raw-panel-side"
						initialValue="left"
						onSnapshot={(snapshot) => {
							latestSnapshot = snapshot;
						}}
					/>,
				);
			});

			if (latestSnapshot === null) {
				throw new Error("Expected an initial hook snapshot.");
			}
			expect((latestSnapshot as RawHookSnapshot).value).toBe("left");

			await act(async () => {
				(latestSnapshot as RawHookSnapshot).setValue(flipPanelSide);
			});
			expect((latestSnapshot as RawHookSnapshot).value).toBe("right");

			// 修复前第二次函数式翻转会基于首帧冻结值再算一次 flip("left")="right"，卡死在 right。
			await act(async () => {
				(latestSnapshot as RawHookSnapshot).setValue(flipPanelSide);
			});
			expect((latestSnapshot as RawHookSnapshot).value).toBe("left");
			expect(localStorage.getItem("test.raw-panel-side")).toBe("left");
		});
	});
});
