import { describe, expect, it } from "vitest";
import { resolveCodexTaskReasoningEffortSelection } from "@/hooks/codex-task-reasoning-effort-selection";
import type { RuntimeTerminalAgentModelSelectionOptionsResponse } from "@/runtime/types";

const catalog: RuntimeTerminalAgentModelSelectionOptionsResponse = {
	agentId: "codex",
	defaultModelId: "native-model",
	defaultLabel: "默认",
	options: [
		{
			modelId: "native-model",
			label: "原生模型",
			supportedReasoningEfforts: [{ effort: "high" }, { effort: "max" }, { effort: "ultra" }, { effort: "future" }],
			defaultReasoningEffort: "max",
		},
		{ modelId: "limited-model", label: "受限模型", supportedReasoningEfforts: [{ effort: "low" }] },
	],
};
const selection = (overrides: Partial<Parameters<typeof resolveCodexTaskReasoningEffortSelection>[0]> = {}) =>
	resolveCodexTaskReasoningEffortSelection({
		catalog,
		explicitModelId: undefined,
		override: undefined,
		catalogWarning: null,
		...overrides,
	});

describe("Codex 任务推理档位", () => {
	it("沿用原生默认模型时仍能独立选择原生新档位", () => {
		expect(selection({ override: "ultra" })).toMatchObject({
			inheritedEffort: "max",
			validationError: null,
			recoveryMessage: null,
		});
		expect(selection().options.map((option) => option.effort)).toEqual(["high", "max", "ultra", "future"]);
	});
	it("显式模型筛选档位，只有确证不兼容时才报错", () => {
		expect(selection({ explicitModelId: "limited-model" }).validationError).toBeNull();
		expect(selection({ explicitModelId: "limited-model", override: "ultra" }).validationError).toContain("不支持");
		expect(selection({ explicitModelId: "limited-model", override: "low" }).validationError).toBeNull();
		expect(selection({ explicitModelId: "unknown-model", override: "ultra" })).toMatchObject({
			validationError: null,
			recoveryMessage: expect.any(String),
		});
	});
	it("目录读取失败保留选择与恢复提示，不把未知当成不兼容", () => {
		expect(
			selection({ catalogWarning: "读取失败", explicitModelId: "limited-model", override: "ultra" }),
		).toMatchObject({ validationError: null, recoveryMessage: expect.any(String) });
		expect(selection({ catalog: null, override: "ultra" }).validationError).toBeNull();
	});
	it("任务未指定模型时，使用目录里的原生默认模型", () => {
		expect(
			selection({
				catalog: { ...catalog, defaultModelId: "native-model" },
			}).options.map((option) => option.effort),
		).toEqual(["high", "max", "ultra", "future"]);
	});
	it("首次读取目录不是失败，已有目录的刷新也不放开已确认的不兼容", () => {
		expect(selection({ catalog: null, catalogIsLoading: true, override: "ultra" })).toMatchObject({
			validationError: null,
			recoveryMessage: null,
		});
		expect(
			selection({ explicitModelId: "limited-model", override: "ultra", catalogIsLoading: true }).validationError,
		).toContain("不支持");
		expect(
			selection({ explicitModelId: "limited-model", override: "ultra", catalogIsLoading: true }).recoveryMessage,
		).toBeNull();
	});
});
