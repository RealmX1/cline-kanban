import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCodexConfigurationSyncStore } from "../../src/codex-configuration-sync/codex-configuration-sync-store";
import { prepareCodexConfigurationWriterBinding } from "../../src/codex-configuration-sync/codex-configuration-writer-binding";
import { inspectCodexNativeSessionControlHostArguments } from "../../src/codex-native-session-control-host/prepare-codex-native-session-control-host-launch";
import { withCodexAppServerRequestConnection } from "../../src/codex-native-session-protocol/codex-app-server-request-connection";
import { prepareAgentLaunch } from "../../src/terminal/agent-session-adapters";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

afterEach(() => vi.unstubAllEnvs());
describe.skipIf(!process.env.KANBAN_CODEX_NATIVE_SESSION_TEST_BINARY)(
	"真实 Codex 任务 effort 启动配置",
	{ timeout: 60_000 },
	() => {
		it.each(["max", "ultra"])("默认模型独立覆盖 %s，真实 app-server 读取到同一值", async (effort) => {
			const fixture = createIsolatedGitTestWorkspaceFixture({
				fixtureRootDirectoryNamePrefix: "codex-task-effort-native-",
			});
			const sourceHome = join(fixture.fixtureRootDirectoryPath, "isolated-codex-source-home");
			await mkdir(sourceHome);
			await writeFile(
				join(sourceHome, "config.toml"),
				'model="fixture-model"\nmodel_reasoning_effort="medium"\ncheck_for_update_on_startup=false\n',
			);
			vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
			vi.stubEnv("CODEX_HOME", sourceHome);
			vi.stubEnv("CODEX_SQLITE_HOME", sourceHome);
			const binding = await prepareCodexConfigurationWriterBinding({
				purpose: "native_session",
				storageHome: sourceHome,
				workspaceId: "effort-fixture",
				conversationSessionId: "abcde",
				runtimeSessionIncarnationId: "00000000-0000-4000-8000-000000000001",
				sessionReasoningEffortOverride: effort,
			});
			const environment = fixture.createIsolatedChildProcessEnvironment({
				CODEX_HOME: binding.configurationHomeDirectoryPath,
				CODEX_SQLITE_HOME: binding.sqliteHomeDirectoryPath,
			});
			const fields = (await readCodexConfigurationSyncStore()).writers[binding.writerId].launchBaselineFields;
			const launch = await prepareAgentLaunch({
				taskId: "abcde",
				workspaceId: "effort-fixture",
				agentId: "codex",
				binary: process.env.KANBAN_CODEX_NATIVE_SESSION_TEST_BINARY ?? "codex",
				args: [],
				cwd: fixture.fixtureRootDirectoryPath,
				prompt: "",
				env: environment,
				codexConfigurationProfileLaunchFields: fields,
				codexReasoningEffortOverride: effort,
			});
			try {
				expect(launch.args).toContain(`model_reasoning_effort="${effort}"`);
				expect(launch.args).not.toContain("--model");
				const nativeConfiguration = await withCodexAppServerRequestConnection(
					{
						binary: process.env.KANBAN_CODEX_NATIVE_SESSION_TEST_BINARY,
						workingDirectory: fixture.fixtureRootDirectoryPath,
						environment,
						argumentsBeforeSubcommand: inspectCodexNativeSessionControlHostArguments(launch.args)
							.appServerRootArguments,
					},
					(port) => port.request("config/read", { includeLayers: false }),
				);
				expect(nativeConfiguration).toMatchObject({
					config: { model: "fixture-model", model_reasoning_effort: effort },
				});
			} finally {
				await launch.cleanup?.();
			}
		});
	},
);
