import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { type Options, useHotkeys } from "react-hotkeys-hook";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useProjectNumericSlotGroupHotkeys } from "@/hooks/use-project-numeric-slot-group-hotkeys";
import type { RuntimeProjectSummary } from "@/runtime/types";

vi.mock("react-hotkeys-hook", () => ({
	useHotkeys: vi.fn(),
}));

vi.mock("@/components/app-toaster", () => ({
	showAppToast: vi.fn(),
}));

const mockUseHotkeys = vi.mocked(useHotkeys);

function createProject(id: string): RuntimeProjectSummary {
	return {
		id,
		name: id,
		path: `/repos/${id}`,
		taskCounts: { backlog: 0, in_progress: 0, review: 0, validation: 0, trash: 0 },
		availability: { status: "available" },
		inProgressTaskDetails: [],
	};
}

function HookHarness(props: Parameters<typeof useProjectNumericSlotGroupHotkeys>[0]): null {
	useProjectNumericSlotGroupHotkeys(props);
	return null;
}

type RegisteredHotkeyCallback = (keyboardEvent: KeyboardEvent, hotkeysEvent: { hotkey: string }) => void;

function findRegisteredCallbackForBinding(binding: string): RegisteredHotkeyCallback {
	const call = mockUseHotkeys.mock.calls.find(
		([keys]) => Array.isArray(keys) && (keys as readonly string[]).includes(binding),
	);
	if (!call || typeof call[1] !== "function") {
		throw new Error(`Expected ${binding} to be registered.`);
	}
	return call[1] as unknown as RegisteredHotkeyCallback;
}

// useHotkeys 的第三个参数是 options 与 deps 的联合，而 deps 是 readonly 数组——Array.isArray 的
// 类型谓词（arg is any[]）在否定分支里排不掉它，所以这里显式写一个「是对象且不是数组」的谓词。
function isRegisteredHotkeyOptionsObject(value: unknown): value is Options {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findRegisteredOptionsForBinding(binding: string): Options {
	const call = mockUseHotkeys.mock.calls.find(
		([keys]) => Array.isArray(keys) && (keys as readonly string[]).includes(binding),
	);
	const options = call?.[2];
	if (!isRegisteredHotkeyOptionsObject(options)) {
		throw new Error(`Expected ${binding} to be registered with an options object.`);
	}
	return options;
}

function invokeRegisteredCallback(binding: string): void {
	const callback = findRegisteredCallbackForBinding(binding);
	act(() => {
		callback(new KeyboardEvent("keydown", { cancelable: true }), { hotkey: binding });
	});
}

describe("useProjectNumericSlotGroupHotkeys", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		mockUseHotkeys.mockReset();
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

	async function renderHarness(overrides: Partial<Parameters<typeof useProjectNumericSlotGroupHotkeys>[0]>) {
		const props: Parameters<typeof useProjectNumericSlotGroupHotkeys>[0] = {
			projects: [createProject("alpha"), createProject("bravo")],
			currentProjectId: "alpha",
			numericSlotGroupAssignments: {},
			onSelectProject: () => {},
			onAssignProjectToNumericSlotGroupNumber: () => {},
			...overrides,
		};
		await act(async () => {
			root.render(<HookHarness {...props} />);
		});
	}

	it("registers a jump and a bind hotkey for every one of the nine slots", async () => {
		await renderHarness({});

		for (let slotNumber = 1; slotNumber <= 9; slotNumber += 1) {
			expect(() => findRegisteredCallbackForBinding(`mod+shift+${slotNumber}`)).not.toThrow();
			expect(() => findRegisteredCallbackForBinding(`mod+alt+${slotNumber}`)).not.toThrow();
		}
		// 两次 useHotkeys 调用（每次注册整组），而不是在循环里调 18 次。
		expect(mockUseHotkeys.mock.calls).toHaveLength(2);
	});

	it("jumps to the project bound to the pressed slot", async () => {
		const onSelectProject = vi.fn();
		await renderHarness({
			numericSlotGroupAssignments: { "1": "alpha", "4": "bravo" },
			onSelectProject,
		});

		invokeRegisteredCallback("mod+shift+4");
		expect(onSelectProject).toHaveBeenCalledWith("bravo");
	});

	it("does nothing for an unbound slot or for the project already open", async () => {
		const onSelectProject = vi.fn();
		await renderHarness({
			numericSlotGroupAssignments: { "1": "alpha" },
			onSelectProject,
		});

		invokeRegisteredCallback("mod+shift+9");
		invokeRegisteredCallback("mod+shift+1");
		expect(onSelectProject).not.toHaveBeenCalled();
	});

	it("binds the current project to the pressed slot", async () => {
		const onAssignProjectToNumericSlotGroupNumber = vi.fn();
		await renderHarness({ currentProjectId: "bravo", onAssignProjectToNumericSlotGroupNumber });

		invokeRegisteredCallback("mod+alt+6");
		expect(onAssignProjectToNumericSlotGroupNumber).toHaveBeenCalledWith(6, "bravo");
	});

	it("does not bind anything while no project is open", async () => {
		const onAssignProjectToNumericSlotGroupNumber = vi.fn();
		await renderHarness({ currentProjectId: null, onAssignProjectToNumericSlotGroupNumber });

		invokeRegisteredCallback("mod+alt+2");
		expect(onAssignProjectToNumericSlotGroupNumber).not.toHaveBeenCalled();
	});

	/**
	 * Windows/Linux 的 AltGr 在事件层等价于 Ctrl+Alt，会命中 `mod+alt+<n>`（非 mac 平台 `mod` = ctrl）。
	 * 德语等国际布局用 AltGr+7/8/9/0 敲 `{` `[` `]` `}`，而绑定热键开着 enableOnFormTags /
	 * enableOnContentEditable + preventDefault，不排除的话用户在任务 prompt 输入框里根本打不出这些字符，
	 * 还会被误绑槽位。守卫必须挂在 ignoreEventWhen 上——它在库内部先于 preventDefault 与回调执行。
	 */
	it("ignores AltGr keydowns on the bind hotkey so international layouts can still type characters", async () => {
		await renderHarness({});

		const altGraphKeydown = new KeyboardEvent("keydown", {
			code: "Digit7",
			ctrlKey: true,
			altKey: true,
			modifierAltGraph: true,
			cancelable: true,
		});

		expect(findRegisteredOptionsForBinding("mod+alt+7").ignoreEventWhen?.(altGraphKeydown)).toBe(true);
	});

	it("keeps binding on a genuine Ctrl+Alt keydown that carries no AltGr modifier", async () => {
		await renderHarness({});

		const genuineModifierKeydown = new KeyboardEvent("keydown", {
			code: "Digit7",
			ctrlKey: true,
			altKey: true,
			cancelable: true,
		});

		expect(findRegisteredOptionsForBinding("mod+alt+7").ignoreEventWhen?.(genuineModifierKeydown)).toBe(false);
	});

	// 跳转热键 mod+shift+<n> 不与 AltGr 冲突（AltGr 不带 shift），不该被这层排除波及。
	it("leaves the jump hotkey free of the AltGr guard", async () => {
		await renderHarness({});

		expect(findRegisteredOptionsForBinding("mod+shift+7").ignoreEventWhen).toBeUndefined();
	});
});
