import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CodexConfigurationProfileDefaultEditor } from "@/components/codex-configuration-profile-default-editor";
import type { CodexConfigurationProfile } from "@/runtime/types";

vi.mock("@/components/task-agent-model-picker", () => ({
	useTaskAgentModelPicker: () => ({
		terminalAgentModelCatalog: {
			agentId: "codex",
			defaultModelId: "native-model",
			options: [
				{
					modelId: "native-model",
					label: "原生模型",
					supportedReasoningEfforts: [{ effort: "max" }, { effort: "ultra" }],
					defaultReasoningEffort: "max",
				},
				{ modelId: "limited-model", label: "受限模型", supportedReasoningEfforts: [{ effort: "low" }] },
			],
		},
		terminalAgentModelCatalogWarning: null,
		retryTerminalAgentModelCatalog: vi.fn(),
		isLoadingTerminalAgentModels: false,
	}),
}));
let root: Root, container: HTMLDivElement, profile: CodexConfigurationProfile;
const action = vi.fn();
const controller = {
	workspaceId: "fixture",
	historicalDefaultEditRequest: null,
	clearHistoricalDefaultEditRequest: vi.fn(),
	profileAction: action,
	pendingChangeId: null,
};
const key = (name: string) => JSON.stringify(["config.toml", name]);
const render = async () =>
	act(async () => root.render(<CodexConfigurationProfileDefaultEditor controller={controller} profile={profile} />));
const select = async (field: HTMLSelectElement, value: string) =>
	act(async () => {
		field.value = value;
		field.dispatchEvent(new Event("change", { bubbles: true }));
	});
const save = () => [...container.querySelectorAll("button")].find((button) => button.textContent === "保存默认并同步")!;
beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	action.mockReset().mockResolvedValue(true);
	profile = {
		profileId: "profile",
		name: "工作配置",
		sourceIdentity: "source",
		version: 1,
		fields: [],
		fieldVersions: {},
	};
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await render();
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});
it("未设置模型时也能显式选择原生推理档位，只提交实际修改字段及联动版本", async () => {
	const effort = container.querySelector<HTMLSelectElement>(
		'[data-verification-anchor="codex-task-reasoning-effort-select"] select',
	)!;
	expect([...effort.options].map((option) => option.value)).toEqual(["", "max", "ultra"]);
	await select(effort, "ultra");
	await act(async () => save().click());
	expect(action).toHaveBeenCalledWith(
		expect.objectContaining({
			fields: [{ fieldKey: key("model_reasoning_effort"), value: "ultra", delete: false }],
			expectedFieldVersions: { [key("model")]: null, [key("model_reasoning_effort")]: null },
		}),
	);
});
it("后台无关刷新保留草稿，同字段变化显示最新默认并要求重新确认", async () => {
	const effort = container.querySelector<HTMLSelectElement>(
		'[data-verification-anchor="codex-task-reasoning-effort-select"] select',
	)!;
	await select(effort, "ultra");
	profile = { ...profile, version: 3, fieldVersions: { [key("other_preference")]: 3 } };
	await render();
	expect(effort.value).toBe("ultra");
	expect(save().disabled).toBe(false);
	profile = {
		...profile,
		version: 4,
		fieldVersions: { ...profile.fieldVersions, [key("model_reasoning_effort")]: 4 },
		fields: [
			{
				fieldKey: key("model_reasoning_effort"),
				fieldLabel: "model_reasoning_effort",
				value: "max",
				valueSummary: "max",
				version: 4,
				exceptionGroup: "reasoning_effort",
			},
		],
	};
	await render();
	expect(effort.value).toBe("ultra");
	expect(save().disabled).toBe(true);
	expect(container.textContent).toContain("草稿已保留");
	await act(async () =>
		[...container.querySelectorAll("button")]
			.find((button) => button.textContent === "根据最新默认重新确认")!
			.click(),
	);
	expect(save().disabled).toBe(false);
});
it("切换模型联合校验推理兼容性，权限缺省字段提供显式入口", async () => {
	const selects = container.querySelectorAll<HTMLSelectElement>("select");
	await select(selects[1]!, "ultra");
	await select(selects[0]!, "limited-model");
	expect(save().disabled).toBe(true);
	expect(container.textContent).toContain("不支持推理强度 ultra");
	await select(selects[1]!, "low");
	expect(save().disabled).toBe(false);
	expect(container.textContent).toContain("完整权限");
	expect(container.querySelectorAll("textarea")).toHaveLength(5);
});
