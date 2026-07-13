import { describe, expect, it } from "vitest";

import { hasTaskCreateFormEdits, type TaskCreateFormSnapshot } from "@/components/task-create-dialog";

function baseline(overrides: Partial<TaskCreateFormSnapshot> = {}): TaskCreateFormSnapshot {
	return {
		prompt: "",
		multiPromptContent: "",
		imageCount: 0,
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		branchRef: "main",
		worktreeMode: "branch",
		agentId: undefined,
		clineSettings: undefined,
		terminalAgentModelOverrideSettings: undefined,
		...overrides,
	};
}

describe("hasTaskCreateFormEdits", () => {
	it("reports no edits when the snapshot is identical to the baseline", () => {
		expect(hasTaskCreateFormEdits(baseline(), baseline())).toBe(false);
	});

	it("treats a whitespace-only prompt as unchanged", () => {
		expect(hasTaskCreateFormEdits(baseline({ prompt: "   \n  " }), baseline())).toBe(false);
	});

	it("detects typed prompt content", () => {
		expect(hasTaskCreateFormEdits(baseline({ prompt: "Fix the bug" }), baseline())).toBe(true);
	});

	it("detects multi-task prompt content", () => {
		expect(hasTaskCreateFormEdits(baseline({ multiPromptContent: "task a\ntask b" }), baseline())).toBe(true);
	});

	it("detects added images", () => {
		expect(hasTaskCreateFormEdits(baseline({ imageCount: 1 }), baseline())).toBe(true);
	});

	it("detects a plan-mode toggle", () => {
		expect(hasTaskCreateFormEdits(baseline({ startInPlanMode: true }), baseline())).toBe(true);
	});

	it("detects an auto-review toggle relative to the opened baseline", () => {
		expect(hasTaskCreateFormEdits(baseline({ autoReviewEnabled: true }), baseline())).toBe(true);
	});

	it("does NOT flag a sticky auto-review preference that was already on at open", () => {
		// 打开时 auto-review 就是 on（localStorage sticky），本次没动 → 基线==当前 → 不脏
		const openedWithAutoReviewOn = baseline({ autoReviewEnabled: true, autoReviewMode: "pr" });
		expect(hasTaskCreateFormEdits(openedWithAutoReviewOn, openedWithAutoReviewOn)).toBe(false);
	});

	it("detects an auto-review mode change", () => {
		expect(hasTaskCreateFormEdits(baseline({ autoReviewMode: "pr" }), baseline())).toBe(true);
	});

	it("detects a branch change", () => {
		expect(hasTaskCreateFormEdits(baseline({ branchRef: "feature-x" }), baseline())).toBe(true);
	});

	it("detects a worktree-mode change", () => {
		expect(hasTaskCreateFormEdits(baseline({ worktreeMode: "inplace" }), baseline())).toBe(true);
	});

	it("detects an agent change", () => {
		expect(hasTaskCreateFormEdits(baseline({ agentId: "claude" }), baseline())).toBe(true);
	});

	it("detects cline settings being set", () => {
		expect(
			hasTaskCreateFormEdits(
				baseline({ clineSettings: { providerId: "anthropic", modelId: "claude-opus-4-8" } }),
				baseline(),
			),
		).toBe(true);
	});

	it("treats structurally-equal cline settings as unchanged", () => {
		const settings = { providerId: "anthropic", modelId: "claude-opus-4-8" };
		expect(
			hasTaskCreateFormEdits(
				baseline({ clineSettings: { ...settings } }),
				baseline({ clineSettings: { ...settings } }),
			),
		).toBe(false);
	});

	it("detects a terminal-agent model override change", () => {
		expect(
			hasTaskCreateFormEdits(
				baseline({ terminalAgentModelOverrideSettings: { agentId: "claude", modelId: "opus" } }),
				baseline(),
			),
		).toBe(true);
	});

	it("treats an equal terminal-agent model override as unchanged", () => {
		const override = { agentId: "claude" as const, modelId: "opus" };
		expect(
			hasTaskCreateFormEdits(
				baseline({ terminalAgentModelOverrideSettings: { ...override } }),
				baseline({ terminalAgentModelOverrideSettings: { ...override } }),
			),
		).toBe(false);
	});
});
