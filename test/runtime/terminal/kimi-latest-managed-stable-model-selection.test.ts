import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KimiServerModelCatalogItem } from "../../../src/terminal/kimi-latest-managed-stable-model-selection";
import * as KimiModelSelectionModule from "../../../src/terminal/kimi-latest-managed-stable-model-selection";
import { getTerminalAgentModelSelectionOptions } from "../../../src/terminal/terminal-agent-model-selection";

vi.mock("../../../src/terminal/kimi-latest-managed-stable-model-selection", async (importOriginal) => ({
	...(await importOriginal<typeof KimiModelSelectionModule>()),
	loadRefreshedKimiManagedModelCatalog: vi.fn(),
}));

function model(modelAlias: string, overrides: Partial<KimiServerModelCatalogItem> = {}): KimiServerModelCatalogItem {
	return { provider: "managed:kimi-code", model: modelAlias, max_context_size: 1_048_576, ...overrides };
}

const catalog = [
	model("kimi-code/k3.1-pro-highspeed"),
	model("kimi-code/k3-256k", { max_context_size: 262_144 }),
	model("kimi-code/k4-preview"),
	model("kimi-code/k3"),
	model("kimi-code/k3.1-pro"),
	model("kimi-code/k3.1", { max_context_size: 2_097_152 }),
	model("kimi-code/k99-pro", { provider: "third-party" }),
];

beforeEach(() => {
	vi.mocked(KimiModelSelectionModule.loadRefreshedKimiManagedModelCatalog).mockReset().mockResolvedValue(catalog);
});

describe("Kimi 最新稳定标准模型选择", () => {
	it("打乱目录后仍按版本、Pro 档、上下文选择，排除 Highspeed、Preview 与第三方", () => {
		for (let offset = 0; offset < catalog.length; offset += 1) {
			const reordered = [...catalog.slice(offset), ...catalog.slice(0, offset)].reverse();
			expect(KimiModelSelectionModule.selectLatestKimiManagedStableModel(reordered).model).toBe(
				"kimi-code/k3.1-pro",
			);
		}
	});

	it.each(["k3.2", "k4", "k3.10-pro"])("发布 %s 时自动跟随，不依赖当前版本常量", (futureModel) => {
		expect(
			KimiModelSelectionModule.selectLatestKimiManagedStableModel([...catalog, model(`kimi-code/${futureModel}`)])
				.model,
		).toBe(`kimi-code/${futureModel}`);
	});

	it("同代同档优先更大上下文，256k 不抢占标准默认", () => {
		expect(
			KimiModelSelectionModule.selectLatestKimiManagedStableModel([
				model("kimi-code/k3-256k", { max_context_size: 262_144 }),
				model("kimi-code/k3"),
			]).model,
		).toBe("kimi-code/k3");
	});

	it("版本末尾零等价，标签中的 Preview/Highspeed 也必须排除", () => {
		expect(
			KimiModelSelectionModule.selectLatestKimiManagedStableModel([
				model("kimi-code/k3.1.0"),
				model("kimi-code/k3.1-pro"),
				model("kimi-code/k4", { display_name: "K4 Preview" }),
				model("kimi-code/k5", { display_name: "K5 Highspeed" }),
			]).model,
		).toBe("kimi-code/k3.1-pro");
	});

	it("不存在合格模型时明确失败", () => {
		expect(() =>
			KimiModelSelectionModule.selectLatestKimiManagedStableModel(
				catalog.filter((item) => /preview|highspeed|k99/.test(item.model)),
			),
		).toThrow("没有可选择");
	});

	it("默认模型响应携带实际选择，显式模型目录仍保留旧版本和变体", async () => {
		const response = await getTerminalAgentModelSelectionOptions("kimi");
		expect(response.defaultModelId).toBe("kimi-code/k3.1-pro");
		expect(response.defaultLabel).toContain("kimi-code/k3.1-pro");
		expect(response.options.map((option) => option.modelId)).toEqual(catalog.map((item) => item.model));
		expect(response.options.every((option) => option.modelSelectionGroup === "pinned_version")).toBe(true);
	});

	it.each(["刷新失败", "非法目录"])("%s 返回 warning 与空默认值，不返回旧模型", async (failure) => {
		vi.mocked(KimiModelSelectionModule.loadRefreshedKimiManagedModelCatalog).mockRejectedValueOnce(
			new Error(failure),
		);
		expect(await getTerminalAgentModelSelectionOptions("kimi")).toMatchObject({
			defaultModelId: null,
			options: [],
			warning: failure,
		});
	});

	it("成功刷新但无合格模型的响应也必须携带 warning", async () => {
		vi.mocked(KimiModelSelectionModule.loadRefreshedKimiManagedModelCatalog).mockResolvedValueOnce([]);
		expect(await getTerminalAgentModelSelectionOptions("kimi")).toMatchObject({
			defaultModelId: null,
			options: [],
			warning: expect.stringContaining("没有可选择"),
		});
	});
});
