import { afterEach, describe, expect, it, vi } from "vitest";
import * as CodexAppServerRequestConnections from "../../../src/codex-native-session-protocol/codex-app-server-request-connection";
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
			await readCreationAgentDefaultModel("omp", fixture.fixtureRootDirectoryPath, "provider/chosen-model"),
		).toEqual({ modelId: "provider/chosen-model" });
		expect(await readCreationAgentDefaultModel("claude", fixture.fixtureRootDirectoryPath)).toEqual({
			modelId: "default",
		});
	});
	it("新建 Codex 卡片保留原生模型选择，避免探测启动并写入用户 SQLite", async () => {
		const connection = vi.spyOn(CodexAppServerRequestConnections, "withCodexAppServerRequestConnection");
		const fixture = createIsolatedGitTestWorkspaceFixture();
		await expect(readCreationAgentDefaultModel("codex", fixture.fixtureRootDirectoryPath)).resolves.toEqual({
			modelId: null,
		});
		await expect(
			readCreationAgentDefaultModel("codex", fixture.fixtureRootDirectoryPath, "chosen-model"),
		).resolves.toEqual({
			modelId: "chosen-model",
		});
		expect(connection).not.toHaveBeenCalled();
	});
	it("未要求原生初始化时，默认模型探测失败不阻止建卡", async () => {
		await expect(
			readCreationAgentDefaultModelWithoutBlockingBacklogCard(async () => {
				throw new Error("OMP 默认模型读取超时");
			}, {}),
		).resolves.toEqual({ modelId: null });
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
