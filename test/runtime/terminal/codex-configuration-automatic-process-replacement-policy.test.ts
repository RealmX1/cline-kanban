import { describe, expect, it } from "vitest";
import {
	assessCodexConfigurationAutomaticProcessReplacement,
	codexConfigurationAutomaticReplacementLaunchOverlay,
	codexConfigurationDiskFieldsAwaitingAutomaticReplacement,
} from "../../../src/codex-configuration-sync/codex-configuration-automatic-process-replacement-policy";
import type {
	StoredCodexConfigurationProfile,
	StoredCodexConfigurationWriter,
} from "../../../src/codex-configuration-sync/codex-configuration-sync-store";

const renderingFieldKey = JSON.stringify(["config.toml", "tui", "alternate_screen"]);
const modelFieldKey = JSON.stringify(["config.toml", "model"]);
const baseline = { [renderingFieldKey]: { value: "always" }, [modelFieldKey]: { value: "selected-model" } };
const writer = {
	launchBaselineFields: baseline,
	codexConfigurationProfileId: "profile",
} as StoredCodexConfigurationWriter;
const profile: StoredCodexConfigurationProfile = {
	profileId: "profile",
	name: "配置方案",
	sourceIdentity: "source",
	version: 2,
	fields: { ...baseline, [renderingFieldKey]: { value: "never" } },
	fieldVersions: { [renderingFieldKey]: 2, [modelFieldKey]: 1 },
};

describe("Codex 自动重启的完整配置 cache 风险", () => {
	it("纯渲染变化允许在安全回合边界自动采用", () => {
		expect(assessCodexConfigurationAutomaticProcessReplacement(writer, profile).allowed).toBe(true);
	});
	it("渲染设置不能夹带模型变化", () => {
		expect(
			assessCodexConfigurationAutomaticProcessReplacement(writer, {
				...profile,
				fields: { ...profile.fields, [modelFieldKey]: { value: "new-model" } },
			}).allowed,
		).toBe(false);
	});
	it("未知字段及缺失启动基线保留待后续启动", () => {
		expect(
			assessCodexConfigurationAutomaticProcessReplacement(writer, {
				...profile,
				fields: { ...profile.fields, [JSON.stringify(["config.toml", "future_setting"])]: { value: true } },
			}).allowed,
		).toBe(false);
		expect(assessCodexConfigurationAutomaticProcessReplacement(undefined, profile).allowed).toBe(false);
	});
	it("磁盘上尚未被 profile 覆盖的模型变化，以及即将写入的启动选择，阻止自动重启", () => {
		const observedModel = { [modelFieldKey]: { value: "disk-model" } };
		const diskFields = codexConfigurationDiskFieldsAwaitingAutomaticReplacement(
			{ consumedProfileFieldVersions: { [modelFieldKey]: 1 }, localExceptionOverrides: {} },
			profile,
			observedModel,
		);
		expect(assessCodexConfigurationAutomaticProcessReplacement(writer, profile, diskFields).allowed).toBe(false);
		const overlay = codexConfigurationAutomaticReplacementLaunchOverlay(
			{ taskModelSelectionAtLaunch: "selected-model" },
			{ sessionModelId: "launch-model" },
		);
		expect(assessCodexConfigurationAutomaticProcessReplacement(writer, profile, overlay).allowed).toBe(false);
		expect(
			codexConfigurationAutomaticReplacementLaunchOverlay(
				{ taskModelSelectionAtLaunch: "selected-model" },
				{ sessionModelId: "selected-model" },
			),
		).toEqual({});
	});
	it("仍有效的局部值参与全部启动变化判定", () => {
		const withLocalModel = {
			...writer,
			localExceptionOverrides: {
				model: { profileVersionAtSelection: 2, fields: { [modelFieldKey]: { value: "local-model" } } },
			},
		};
		expect(assessCodexConfigurationAutomaticProcessReplacement(withLocalModel, profile).allowed).toBe(false);
	});
});
