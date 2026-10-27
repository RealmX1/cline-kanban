import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { prepareCodexRemoteConversationLaunchPlan } from "../../src/codex-native-session-control-host/codex-remote-conversation-launch-plan";
import {
	inspectCodexNativeSessionControlHostArguments,
	prepareCodexNativeSessionControlHostLaunch,
} from "../../src/codex-native-session-control-host/prepare-codex-native-session-control-host-launch";
import { withCodexAppServerRequestConnection } from "../../src/rvf-automatic-closeout/codex-app-server-request-connection";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

afterEach(() => vi.unstubAllEnvs());

describe.skipIf(!process.env.KANBAN_CODEX_NATIVE_RVF_CLOSEOUT_SMOKE_BINARY)(
	"真实 Codex 加载独享宿主的权限配置顺序",
	{ timeout: 120_000 },
	() => {
		it("初始、恢复与分叉宿主保持原生点路径覆盖结果，短等号只读配置可创建新 thread", async () => {
			const fixture = createIsolatedGitTestWorkspaceFixture({
				fixtureRootDirectoryNamePrefix: "codex-permission-defaults-native-",
			});
			const codexHome = join(fixture.fixtureRootDirectoryPath, "isolated-codex-home");
			await mkdir(codexHome);
			await writeFile(
				join(codexHome, "config.toml"),
				'check_for_update_on_startup=false\napproval_policy="never"\nsandbox_mode="danger-full-access"\n',
			);
			vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
			vi.stubEnv("CODEX_HOME", codexHome);
			vi.stubEnv("CODEX_SQLITE_HOME", codexHome);
			const environment = fixture.createIsolatedChildProcessEnvironment({
				CODEX_HOME: codexHome,
				CODEX_SQLITE_HOME: codexHome,
			});
			const inspectNativeConfiguration = (arguments_: string[]) =>
				withCodexAppServerRequestConnection(
					{
						binary: process.env.KANBAN_CODEX_NATIVE_RVF_CLOSEOUT_SMOKE_BINARY,
						workingDirectory: fixture.fixtureRootDirectoryPath,
						environment,
						argumentsBeforeSubcommand: arguments_,
						experimentalApi: true,
					},
					async (port) => {
						const configuration = z
							.object({ config: z.record(z.string(), z.unknown()) })
							.parse(await port.request("config/read", { includeLayers: false })).config;
						const thread = await port.request("thread/start", {
							cwd: fixture.fixtureRootDirectoryPath,
							ephemeral: true,
						});
						return { configuration, thread };
					},
				);
			const nativeConfigurationArguments = [
				"-c",
				"approval_policy={ granular = { sandbox_approval = true, rules = true, skill_approval = true, request_permissions = true, mcp_elicitations = true } }",
				"-c",
				"approval_policy.granular.sandbox_approval=false",
				"-c",
				'sandbox_mode="read-only"',
			];
			const native = await inspectNativeConfiguration(nativeConfigurationArguments);
			expect(native.configuration).toMatchObject({ approval_policy: { granular: { sandbox_approval: false } } });
			for (const operation of ["new", "resume", "fork"] as const) {
				const hostArguments =
					operation === "new"
						? inspectCodexNativeSessionControlHostArguments(nativeConfigurationArguments).appServerRootArguments
						: prepareCodexRemoteConversationLaunchPlan(
								[...nativeConfigurationArguments, operation, "source-id"],
								fixture.fixtureRootDirectoryPath,
							)?.appServerRootArguments;
				if (!hostArguments) throw new Error("应生成独享宿主参数。");
				const owned = await inspectNativeConfiguration(hostArguments);
				expect(owned.configuration.approval_policy).toEqual(native.configuration.approval_policy);
				expect(owned.thread).toMatchObject({
					approvalPolicy: { granular: { sandbox_approval: false } },
					sandbox: { type: "readOnly" },
				});
				const shortArguments = ["-s=read-only", "-a=never", '-c=approval_policy="on-request"'];
				const shortHostArguments =
					operation === "new"
						? inspectCodexNativeSessionControlHostArguments(shortArguments).appServerRootArguments
						: prepareCodexRemoteConversationLaunchPlan(
								[...shortArguments, operation, "source-id"],
								fixture.fixtureRootDirectoryPath,
							)?.appServerRootArguments;
				if (!shortHostArguments) throw new Error("短等号权限应生成独享宿主参数。");
				expect((await inspectNativeConfiguration(shortHostArguments)).thread).toMatchObject({
					approvalPolicy: "never",
					sandbox: { type: "readOnly" },
				});
				const untrustedArguments = [
					"-capproval_policy=untrusted",
					...(operation === "new" ? [] : [operation, "source-id"]),
				];
				await expect(
					prepareCodexNativeSessionControlHostLaunch({
						binary: process.env.KANBAN_CODEX_NATIVE_RVF_CLOSEOUT_SMOKE_BINARY ?? "codex",
						arguments: untrustedArguments,
						workingDirectoryPath: fixture.fixtureRootDirectoryPath,
						environment,
						workspaceId: "isolated-permission-workspace",
						conversationSessionId: "isolated-permission-session",
						runtimeSessionIncarnationId: "isolated-permission-incarnation",
					}),
				).rejects.toThrow("无法为受管宿主提供 untrusted 默认审批策略");
			}
			await expect(
				promisify(execFile)(
					process.env.KANBAN_CODEX_NATIVE_RVF_CLOSEOUT_SMOKE_BINARY ?? "codex",
					["-capproval_policy=untrusted", "app-server", "--stdio"],
					{ cwd: fixture.fixtureRootDirectoryPath, env: environment, timeout: 5_000 },
				),
			).rejects.toMatchObject({
				stderr: expect.stringContaining('approval_policy = "untrusted" is no longer supported'),
			});
			await expect(
				promisify(execFile)(
					process.env.KANBAN_CODEX_NATIVE_RVF_CLOSEOUT_SMOKE_BINARY ?? "codex",
					["-a", "untrusted", "--no-alt-screen"],
					{ cwd: fixture.fixtureRootDirectoryPath, env: environment, timeout: 5_000 },
				),
			).rejects.toMatchObject({
				stderr: expect.stringContaining("invalid value 'untrusted' for '--ask-for-approval"),
			});
		});
	},
);
