import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify, type TomlTable } from "smol-toml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { readCodexConfigurationSyncStore } from "../../src/codex-configuration-sync/codex-configuration-sync-store";
import {
	buildCodexConfigurationWriterEnvironment,
	prepareCodexConfigurationWriterBinding,
} from "../../src/codex-configuration-sync/codex-configuration-writer-binding";
import { prepareManagedCodexConversationStorageHome } from "../../src/codex-conversation-storage/codex-conversation-storage-home";
import { withCodexAppServerRequestConnection } from "../../src/codex-native-session-protocol/codex-app-server-request-connection";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

afterEach(() => vi.unstubAllEnvs());
const hooksResponseSchema = z.object({
	data: z.array(
		z.object({
			hooks: z.array(
				z.object({ key: z.string(), currentHash: z.string(), trustStatus: z.string(), enabled: z.boolean() }),
			),
		}),
	),
});

describe.skipIf(!process.env.KANBAN_CODEX_NATIVE_CONFIGURATION_SYNC_SMOKE_BINARY)(
	"真实 Codex 未来 writer 在定义变化后保留显式禁用",
	{ timeout: 90_000 },
	() => {
		it.each([false, true])("既有 enabled=%s 的决定保留，过期原生信任必须失效", async (enabled) => {
			const fixture = createIsolatedGitTestWorkspaceFixture({
				fixtureRootDirectoryNamePrefix: "codex-hook-definition-disabled-",
			});
			const sourceHome = join(fixture.isolatedHomeDirectoryPath, ".codex");
			const sqliteHome = join(fixture.fixtureRootDirectoryPath, "isolated-sqlite");
			vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
			vi.stubEnv("CODEX_HOME", sourceHome);
			vi.stubEnv("CODEX_SQLITE_HOME", sqliteHome);
			await mkdir(sourceHome, { recursive: true });
			const binary = process.env.KANBAN_CODEX_NATIVE_CONFIGURATION_SYNC_SMOKE_BINARY ?? "codex";
			const environment = fixture.createIsolatedChildProcessEnvironment({
				CODEX_HOME: sourceHome,
				CODEX_SQLITE_HOME: sqliteHome,
			});
			const readNativeHook = (writerEnvironment: NodeJS.ProcessEnv) =>
				withCodexAppServerRequestConnection(
					{
						binary,
						workingDirectory: fixture.fixtureRootDirectoryPath,
						experimentalApi: true,
						environment: writerEnvironment,
					},
					async (port) => {
						const hook = hooksResponseSchema.parse(
							await port.request("hooks/list", { cwds: [fixture.fixtureRootDirectoryPath] }),
						).data[0]?.hooks[0];
						if (!hook) throw new Error("缺少隔离原生 hook");
						return hook;
					},
				);
			const writeHookDefinition = (command: string) =>
				writeFile(
					join(sourceHome, "hooks.json"),
					JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command }] }] } }),
				);
			const configuration: TomlTable = {
				features: { hooks: true, memories: false },
				check_for_update_on_startup: false,
				analytics: { enabled: false },
				feedback: { enabled: false },
			};
			await writeHookDefinition("true");
			await writeFile(join(sourceHome, "config.toml"), stringify(configuration));
			const initialHook = await readNativeHook(environment);
			expect(initialHook.trustStatus).toBe("untrusted");
			configuration.hooks = { state: { [initialHook.key]: { enabled, trusted_hash: initialHook.currentHash } } };
			await writeFile(join(sourceHome, "config.toml"), stringify(configuration));
			const storageHome = await prepareManagedCodexConversationStorageHome(sourceHome);
			const createWriter = () =>
				prepareCodexConfigurationWriterBinding({
					purpose: "native_session",
					storageHome,
					runtimeSessionIncarnationId: randomUUID(),
					binary,
					environment,
				});
			const previous = await createWriter();
			const before = await readNativeHook({ ...environment, ...buildCodexConfigurationWriterEnvironment(previous) });
			expect(before).toMatchObject({ enabled, trustStatus: "trusted" });
			await writeHookDefinition("true # 新定义");
			const future = await createWriter();
			const after = await readNativeHook({ ...environment, ...buildCodexConfigurationWriterEnvironment(future) });
			expect(after).toMatchObject({ enabled, trustStatus: "untrusted" });
			expect(after.currentHash).not.toBe(initialHook.currentHash);
			const futureConfiguration = parse(
				await readFile(join(future.configurationHomeDirectoryPath, "config.toml"), "utf8"),
			);
			expect(JSON.stringify(futureConfiguration)).not.toContain("trusted_hash");
			const store = await readCodexConfigurationSyncStore();
			expect(store.sourceObservations).toHaveLength(1);
			expect(store.changes.every((change) => change.approvalStatus !== "approved")).toBe(true);
			expect((await readNativeHook(environment)).enabled).toBe(enabled);
		});
	},
);
