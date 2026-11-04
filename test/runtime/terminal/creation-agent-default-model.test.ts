import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mutateCodexConfigurationSyncStore } from "../../../src/codex-configuration-sync/codex-configuration-sync-store";
import {
	readCreationAgentDefaultModel,
	readCreationAgentDefaultModelWithoutBlockingBacklogCard,
} from "../../../src/terminal/creation-agent-default-model";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

afterEach(() => vi.unstubAllEnvs());
describe("创建时的 Agent 默认配置", () => {
	it("显式模型不依赖 OMP 或 Claude 默认模型探测，浮动默认别名保持原样", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		vi.stubEnv("PATH", fixture.fixtureRootDirectoryPath);
		expect(
			await readCreationAgentDefaultModel(
				"omp",
				fixture.fixtureRootDirectoryPath,
				undefined,
				"provider/chosen-model",
			),
		).toEqual({ modelId: "provider/chosen-model" });
		expect(await readCreationAgentDefaultModel("claude", fixture.fixtureRootDirectoryPath)).toEqual({
			modelId: "default",
		});
	});
	it("Codex 显式模型仍冻结默认 profile；缺少显式 profile 时不能静默换用其他配置", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
		vi.stubEnv("CODEX_HOME", join(fixture.isolatedHomeDirectoryPath, "isolated-codex-configuration"));
		vi.stubEnv("CODEX_SQLITE_HOME", join(fixture.isolatedHomeDirectoryPath, "isolated-codex-storage"));
		vi.stubEnv("PATH", fixture.fixtureRootDirectoryPath);
		await mutateCodexConfigurationSyncStore((store) => {
			store.defaultCodexConfigurationProfileId = "default-profile";
			store.profiles["default-profile"] = {
				profileId: "default-profile",
				name: "默认配置",
				sourceIdentity: "isolated",
				version: 1,
				fields: {},
				fieldVersions: {},
			};
		});
		expect(
			await readCreationAgentDefaultModel("codex", fixture.fixtureRootDirectoryPath, undefined, "chosen-model"),
		).toEqual({ modelId: "chosen-model", codexConfigurationProfileId: "default-profile" });
		await expect(
			readCreationAgentDefaultModel("codex", fixture.fixtureRootDirectoryPath, "missing-profile", "chosen-model"),
		).rejects.toThrow("不存在");
	});
	it("未绑定 profile 且未要求原生初始化时，默认模型探测失败不阻止建卡", async () => {
		await expect(
			readCreationAgentDefaultModelWithoutBlockingBacklogCard(async () => {
				throw new Error("OMP 默认模型读取超时");
			}, {}),
		).resolves.toEqual({ modelId: null });
		await expect(
			readCreationAgentDefaultModelWithoutBlockingBacklogCard(
				async () => {
					throw new Error("所选 Codex profile 不存在。");
				},
				{ codexConfigurationProfileId: "missing-profile" },
			),
		).rejects.toThrow("不存在");
		await expect(
			readCreationAgentDefaultModelWithoutBlockingBacklogCard(
				async () => {
					throw new Error("原生会话暂时不可读");
				},
				{ taskAgentSessionInitialization: { sourceAgentId: "codex", sourceSessionId: "native" } },
			),
		).rejects.toThrow("原生会话暂时不可读");
	});
});
