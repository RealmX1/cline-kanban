import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTerminalInputBoxStashResponse } from "@/runtime/types";

const platformState = { isMacPlatform: false };
vi.mock("@/utils/platform", () => ({
	get isMacPlatform() {
		return platformState.isMacPlatform;
	},
}));

const {
	describeTerminalInputBoxStashOutcome,
	isStashTerminalInputBoxToPromptLibraryShortcut,
	PROMPT_LIBRARY_PANEL_STILL_LOCAL_ONLY_UNTIL_MIGRATION_NOTICE,
} = await import("@/terminal/terminal-input-box-stash-shortcut");

function createKeyEvent(init: KeyboardEventInit & { type?: string } = {}): KeyboardEvent {
	const { type = "keydown", ...rest } = init;
	return new KeyboardEvent(type, { key: "s", ...rest });
}

function createStashResponse(
	overrides: Partial<RuntimeTerminalInputBoxStashResponse> & Pick<RuntimeTerminalInputBoxStashResponse, "outcome">,
): RuntimeTerminalInputBoxStashResponse {
	return {
		ok: true,
		stashedPromptId: null,
		stashedTextCharacterCount: 0,
		fidelity: null,
		...overrides,
	};
}

describe("isStashTerminalInputBoxToPromptLibraryShortcut", () => {
	beforeEach(() => {
		platformState.isMacPlatform = false;
	});

	it("Ctrl+S 命中（全平台一致——那是 agent 自己的 stash 键，用户的肌肉记忆在这里）", () => {
		expect(isStashTerminalInputBoxToPromptLibraryShortcut(createKeyEvent({ ctrlKey: true }))).toBe(true);
		platformState.isMacPlatform = true;
		expect(isStashTerminalInputBoxToPromptLibraryShortcut(createKeyEvent({ ctrlKey: true }))).toBe(true);
	});

	it("Cmd+S 只在 macOS 命中（顺带堵掉漏给浏览器的「存储页面」对话框）", () => {
		expect(isStashTerminalInputBoxToPromptLibraryShortcut(createKeyEvent({ metaKey: true }))).toBe(false);
		platformState.isMacPlatform = true;
		expect(isStashTerminalInputBoxToPromptLibraryShortcut(createKeyEvent({ metaKey: true }))).toBe(true);
	});

	it("带 Alt / Shift 修饰的不算，避免抢走别的组合键", () => {
		expect(isStashTerminalInputBoxToPromptLibraryShortcut(createKeyEvent({ ctrlKey: true, altKey: true }))).toBe(
			false,
		);
		expect(isStashTerminalInputBoxToPromptLibraryShortcut(createKeyEvent({ ctrlKey: true, shiftKey: true }))).toBe(
			false,
		);
	});

	it("裸 s、以及 keyup 都不算（只在 keydown 上拦一次）", () => {
		expect(isStashTerminalInputBoxToPromptLibraryShortcut(createKeyEvent({}))).toBe(false);
		expect(isStashTerminalInputBoxToPromptLibraryShortcut(createKeyEvent({ type: "keyup", ctrlKey: true }))).toBe(
			false,
		);
	});
});

describe("describeTerminalInputBoxStashOutcome", () => {
	it("入库成功报字符数，并附上「面板暂时看不到」的说明", () => {
		const toast = describeTerminalInputBoxStashOutcome(
			createStashResponse({ outcome: "stashed_into_prompt_library", stashedTextCharacterCount: 128 }),
		);
		expect(toast?.intent).toBe("success");
		expect(toast?.message).toContain("128");
		expect(toast?.message).toContain(PROMPT_LIBRARY_PANEL_STILL_LOCAL_ONLY_UNTIL_MIGRATION_NOTICE);
	});

	// 钉的是语义不是字句：面板迁移完成前，成功回执不能把用户支到一个看不到这条内容的面板前，
	// 必须同时讲清「东西落在哪」和「面板为什么还没有它」。措辞可改，这两件事不能少。
	it("成功回执必须说清内容落盘位置、以及面板要等迁移完成才显示", () => {
		expect(PROMPT_LIBRARY_PANEL_STILL_LOCAL_ONLY_UNTIL_MIGRATION_NOTICE).toContain("prompt-library.json");
		expect(PROMPT_LIBRARY_PANEL_STILL_LOCAL_ONLY_UNTIL_MIGRATION_NOTICE).toMatch(/面板/);
		expect(PROMPT_LIBRARY_PANEL_STILL_LOCAL_ONLY_UNTIL_MIGRATION_NOTICE).toMatch(/迁移/);
	});

	it("有还原不了的折叠粘贴时降为 warning 并说清有几处", () => {
		const toast = describeTerminalInputBoxStashOutcome(
			createStashResponse({
				outcome: "stashed_into_prompt_library",
				stashedTextCharacterCount: 64,
				fidelity: {
					softWrapJoinCount: 4,
					foldedPastePlaceholderCount: 3,
					backfilledPlaceholderCount: 1,
					placeholdersLeftUnbackfilledBecausePayloadWasDropped: 1,
					placeholdersLeftUnbackfilledBecauseNoLedgerEntryMatched: 1,
					placeholdersLeftUnbackfilledBecausePlaceholderSelfConsistencyCheckFailed: 0,
					// 与上面三项会重叠，**不**参与加总，否则就是虚报。
					unrecoverablePasteCount: 1,
				},
			}),
		);
		expect(toast?.intent).toBe("warning");
		expect(toast?.message).toContain("2 处折叠粘贴无法还原");
	});

	it("整框自洽性校验没过（框里混着手打的同形字面量）时照样说清有几处没还原", () => {
		// 服务端分不清哪处是真占位符，整框放弃回填。这条计数要是不参与加总，用户看到的就是一句
		// 纯成功——而入库的那段文字里其实一处折叠粘贴都没换回来。
		const toast = describeTerminalInputBoxStashOutcome(
			createStashResponse({
				outcome: "stashed_into_prompt_library",
				stashedTextCharacterCount: 96,
				fidelity: {
					softWrapJoinCount: 0,
					foldedPastePlaceholderCount: 2,
					backfilledPlaceholderCount: 0,
					placeholdersLeftUnbackfilledBecausePayloadWasDropped: 0,
					placeholdersLeftUnbackfilledBecauseNoLedgerEntryMatched: 0,
					placeholdersLeftUnbackfilledBecausePlaceholderSelfConsistencyCheckFailed: 2,
					unrecoverablePasteCount: 0,
				},
			}),
		);
		expect(toast?.intent).toBe("warning");
		expect(toast?.message).toContain("2 处折叠粘贴无法还原");
		// 降级成 warning 也仍然是「存进去了」，同样要说清面板此刻看不到它。
		expect(toast?.message).toContain(PROMPT_LIBRARY_PANEL_STILL_LOCAL_ONLY_UNTIL_MIGRATION_NOTICE);
	});

	it("软折行合并次数不算问题，不该把成功降级成告警", () => {
		const toast = describeTerminalInputBoxStashOutcome(
			createStashResponse({
				outcome: "stashed_into_prompt_library",
				stashedTextCharacterCount: 392,
				fidelity: {
					softWrapJoinCount: 4,
					foldedPastePlaceholderCount: 0,
					backfilledPlaceholderCount: 0,
					placeholdersLeftUnbackfilledBecausePayloadWasDropped: 0,
					placeholdersLeftUnbackfilledBecauseNoLedgerEntryMatched: 0,
					placeholdersLeftUnbackfilledBecausePlaceholderSelfConsistencyCheckFailed: 0,
					unrecoverablePasteCount: 0,
				},
			}),
		);
		expect(toast?.intent).toBe("success");
	});

	it("写库失败必须明说内容还在框里", () => {
		const toast = describeTerminalInputBoxStashOutcome(
			createStashResponse({ outcome: "prompt_library_write_failed", ok: false, error: "EACCES" }),
		);
		expect(toast?.intent).toBe("danger");
		expect(toast?.message).toContain("仍留在输入框");
		expect(toast?.message).toContain("EACCES");
	});

	it("已入库但框没清：必须同时说清「存进去了」和「框没被清空」", () => {
		// 只报成功会让用户看着还在的输入框反过来怀疑内容到底存进去没有；只报失败又是反向撒谎。
		const toast = describeTerminalInputBoxStashOutcome(
			createStashResponse({
				outcome: "stashed_into_prompt_library_but_input_box_not_cleared",
				stashedTextCharacterCount: 42,
				stashedPromptId: "prompt-1",
			}),
		);
		expect(toast?.intent).toBe("warning");
		expect(toast?.message).toContain("42");
		expect(toast?.message).toContain("未被清空");
		expect(toast?.message).toContain(PROMPT_LIBRARY_PANEL_STILL_LOCAL_ONLY_UNTIL_MIGRATION_NOTICE);
	});

	it("被重入闸门挡下的那一次必须有回执，不许静默吞掉按键", () => {
		const toast = describeTerminalInputBoxStashOutcome(
			createStashResponse({
				outcome: "another_terminal_input_box_stash_attempt_already_in_flight_for_this_task",
				ok: false,
			}),
		);
		expect(toast).not.toBeNull();
		expect(toast?.intent).toBe("warning");
		expect(toast?.message).toContain("已有一次暂存正在进行中");
	});

	it("什么都没发生的两种结论不弹提示（空框 / 没有终端会话）", () => {
		expect(
			describeTerminalInputBoxStashOutcome(createStashResponse({ outcome: "input_box_empty_nothing_to_stash" })),
		).toBeNull();
		expect(
			describeTerminalInputBoxStashOutcome(createStashResponse({ outcome: "no_active_terminal_session" })),
		).toBeNull();
	});

	it("读不到 / 无法与占位提示区分这两种，都要告诉用户「已交给 agent 自己处理」", () => {
		for (const outcome of [
			"input_box_content_unreadable_forwarded_to_agent_native_stash",
			"input_box_screen_text_not_corroborated_by_keystroke_tracking",
		] as const) {
			expect(describeTerminalInputBoxStashOutcome(createStashResponse({ outcome }))?.message).toContain(
				"已交给 agent 自己处理",
			);
		}
	});
});
