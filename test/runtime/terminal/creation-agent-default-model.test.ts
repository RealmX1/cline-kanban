import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mutateCodexConfigurationSyncStore } from "../../../src/codex-configuration-sync/codex-configuration-sync-store";
import * as CodexAppServerRequestConnections from "../../../src/codex-native-session-protocol/codex-app-server-request-connection";
import type { CodexAppServerRequestPort } from "../../../src/codex-native-session-protocol/codex-native-conversation-history";
import {
	readCreationAgentDefaultModel,
	readCreationAgentDefaultModelWithoutBlockingBacklogCard,
} from "../../../src/terminal/creation-agent-default-model";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});
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
	it.each(["configured-default", null])(
		"Codex 配置模型为 %s 时，经统一辅助连接读取实际默认值",
		async (configuredModel) => {
			const fixture = createIsolatedGitTestWorkspaceFixture();
			const configurationHome = join(fixture.isolatedHomeDirectoryPath, "isolated-codex-configuration");
			vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
			vi.stubEnv("CODEX_HOME", configurationHome);
			vi.stubEnv("CODEX_SQLITE_HOME", join(fixture.isolatedHomeDirectoryPath, "isolated-codex-storage"));
			const request = vi.fn<CodexAppServerRequestPort["request"]>(async (method) =>
				method === "config/read"
					? { config: { model: configuredModel } }
					: { data: [{ model: "catalog-default", isDefault: true }] },
			);
			const connection = vi
				.spyOn(CodexAppServerRequestConnections, "withCodexAppServerRequestConnection")
				.mockImplementation(async (_input, operation) => operation({ request }));
			expect(await readCreationAgentDefaultModel("codex", fixture.fixtureRootDirectoryPath)).toEqual({
				modelId: configuredModel ?? "catalog-default",
				codexConfigurationProfileId: undefined,
			});
			expect(connection).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({
					workingDirectory: fixture.fixtureRootDirectoryPath,
					codexConversationStorageHomeDirectoryPath: configurationHome,
					environment: expect.objectContaining({ CODEX_HOME: configurationHome }),
				}),
				expect.any(Function),
			);
			expect(request.mock.calls.map(([method]) => method)).toEqual(
				configuredModel ? ["config/read"] : ["config/read", "model/list"],
			);
		},
	);
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
