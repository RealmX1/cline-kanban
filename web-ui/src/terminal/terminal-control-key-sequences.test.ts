import { describe, expect, it } from "vitest";

import {
	TERMINAL_CONTROL_KEY_DEFINITIONS_BY_ID,
	TERMINAL_VIRTUAL_KEY_BAR_ACTION_KEY_IDS,
	TERMINAL_VIRTUAL_KEY_BAR_DIRECTIONAL_CLUSTER_ROWS,
	TERMINAL_VIRTUAL_KEY_BAR_SUBMIT_KEY_ID,
	type TerminalControlKeyId,
} from "@/terminal/terminal-control-key-sequences";

describe("terminal control key sequences", () => {
	it("emits the exact bytes a physical keypress would produce", () => {
		const sequencesById = Object.fromEntries(
			Object.entries(TERMINAL_CONTROL_KEY_DEFINITIONS_BY_ID).map(([keyId, definition]) => [
				keyId,
				definition.sequence,
			]),
		);

		expect(sequencesById).toEqual({
			interrupt_and_clear_input_line: "\u0003",
			rewind_double_escape: "\u001b\u001b",
			arrow_up: "\u001b[A",
			arrow_down: "\u001b[B",
			arrow_left: "\u001b[D",
			arrow_right: "\u001b[C",
			submit: "\r",
			tab: "\t",
			back_tab: "\u001b[Z",
		});
	});

	it("uses CSI cursor keys rather than the application-cursor-key form", () => {
		// ESC O A 只在终端开启 DECCKM 时有效，而 xterm 不暴露该模式状态。见模块头注释。
		for (const keyId of ["arrow_up", "arrow_down", "arrow_left", "arrow_right"] as const) {
			expect(TERMINAL_CONTROL_KEY_DEFINITIONS_BY_ID[keyId].sequence.startsWith("\u001b[")).toBe(true);
		}
	});

	it("keeps every key referenced by the virtual key bar layout defined", () => {
		const laidOutKeyIds: TerminalControlKeyId[] = [
			...TERMINAL_VIRTUAL_KEY_BAR_DIRECTIONAL_CLUSTER_ROWS.flat().filter(
				(keyId): keyId is TerminalControlKeyId => keyId !== null,
			),
			...TERMINAL_VIRTUAL_KEY_BAR_ACTION_KEY_IDS,
			TERMINAL_VIRTUAL_KEY_BAR_SUBMIT_KEY_ID,
		];

		for (const keyId of laidOutKeyIds) {
			expect(TERMINAL_CONTROL_KEY_DEFINITIONS_BY_ID[keyId]).toBeDefined();
		}
		// 布局不得重复排同一个键，否则按键条会出现两个一样的按钮。
		expect(new Set(laidOutKeyIds).size).toBe(laidOutKeyIds.length);
	});

	it("lays the directional keys out as an inverted-T cluster rather than a flat row", () => {
		// 拇指靠空间记忆而非读标签：摊平成一行后四个方向键退化成一排等价方块。
		expect(TERMINAL_VIRTUAL_KEY_BAR_DIRECTIONAL_CLUSTER_ROWS).toEqual([
			[null, "arrow_up", null],
			["arrow_left", "arrow_down", "arrow_right"],
		]);
	});

	it("enables long-press auto-repeat for the arrow keys only", () => {
		// 连发是为了在长选项列表里少点几十下；其余键连发的后果不可逆或代价明显更高：
		// Ctrl+C 刷屏打断、Enter 重复提交、Tab/⇧Tab 把权限档位循环到没预期的位置。
		const autoRepeatingKeyIds = Object.values(TERMINAL_CONTROL_KEY_DEFINITIONS_BY_ID)
			.filter((definition) => definition.supportsAutoRepeatOnLongPress)
			.map((definition) => definition.id)
			.sort();

		expect(autoRepeatingKeyIds).toEqual(["arrow_down", "arrow_left", "arrow_right", "arrow_up"]);
	});

	it("marks Ctrl+C as the only destructive key so it reads differently in a dense cluster", () => {
		const destructiveKeyIds = Object.values(TERMINAL_CONTROL_KEY_DEFINITIONS_BY_ID)
			.filter((definition) => definition.isDestructive)
			.map((definition) => definition.id);

		expect(destructiveKeyIds).toEqual(["interrupt_and_clear_input_line"]);
	});

	it("gives every key an accessible description, since touch devices have no hover tooltip", () => {
		for (const definition of Object.values(TERMINAL_CONTROL_KEY_DEFINITIONS_BY_ID)) {
			expect(definition.label.length).toBeGreaterThan(0);
			expect(definition.accessibleDescription.length).toBeGreaterThan(0);
		}
	});
});
