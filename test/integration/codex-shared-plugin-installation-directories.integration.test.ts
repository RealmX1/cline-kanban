import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readdir, readFile, realpath, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse, stringify } from "smol-toml";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";
import { configurationTable } from "../../src/codex-configuration-sync/codex-configuration-field-projection";
import {
	buildCodexConfigurationWriterEnvironment,
	prepareCodexConfigurationWriterBinding,
} from "../../src/codex-configuration-sync/codex-configuration-writer-binding";
import {
	prepareCodexSharedPluginInstallationForNativeLaunch,
	recoverPendingCodexSharedPluginInstallations,
} from "../../src/codex-configuration-sync/codex-source-shared-plugin-installation-coordinator";
import { withCodexAppServerRequestConnection } from "../../src/codex-native-session-protocol/codex-app-server-request-connection";
import type { CodexConfigurationWriterBinding } from "../../src/core/codex-configuration-sync-contract";
import { readProcessCommandLinesForProcessIds } from "../../src/diagnostics/posix-process-table-with-resource-columns-reader";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { requireDefinedTestFixtureValue } from "../utilities/require-defined-test-fixture-value";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(async () => {
	await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
	vi.unstubAllEnvs();
});
const upgradeResponseSchema = z.object({
	selectedMarketplaces: z.array(z.string()),
	upgradedRoots: z.array(z.string()),
	errors: z.array(z.unknown()),
});
const marketplaceName = "shared-installation-fixture";
const configuredPluginNames = ["hook-example", "skills-example", "second-example"];
const hooksResponseSchema = z.object({
	data: z.array(
		z.object({
			hooks: z.array(
				z.object({
					key: z.string(),
					currentHash: z.string(),
					trustStatus: z.string(),
					enabled: z.boolean().optional(),
				}),
			),
		}),
	),
});

async function recordNativeVerificationEvidence(
	name: string,
	evidence: unknown,
	nativeFixture: { sourceHome: string; gitTraceFilePath: string },
) {
	const directory = process.env.KANBAN_CODEX_SHARED_PLUGIN_INSTALLATION_EVIDENCE_DIRECTORY;
	if (!directory) return;
	await mkdir(directory, { recursive: true });
	const rawNativeReceiptsDirectoryPath = join(directory, `${name}-native-receipts`);
	await mkdir(rawNativeReceiptsDirectoryPath, { recursive: true });
	const sourceCoordinationDirectory = join(
		nativeFixture.sourceHome,
		"plugins",
		".kanban-source-installation-coordination",
	);
	for (const entry of await readdir(sourceCoordinationDirectory, { withFileTypes: true })) {
		const source = join(sourceCoordinationDirectory, entry.name);
		const destination = join(rawNativeReceiptsDirectoryPath, entry.name);
		if (
			entry.isFile() &&
			(/^source-.*\.json$/.test(entry.name) || entry.name === "source-installation-progress-events.jsonl")
		)
			await cp(source, destination);
		if (entry.isDirectory() && /^native-attempt-[a-f0-9-]{36}$/.test(entry.name)) {
			await mkdir(destination, { recursive: true });
			for (const receipt of await readdir(source, { withFileTypes: true }))
				if (
					receipt.isFile() &&
					["native.stdout.json", "native.stderr.log", "native-completion.json"].includes(receipt.name)
				)
					await cp(join(source, receipt.name), join(destination, receipt.name));
		}
	}
	await cp(nativeFixture.gitTraceFilePath, join(rawNativeReceiptsDirectoryPath, "native-git-trace2-events.jsonl"));
	await writeFile(
		join(directory, `${name}.json`),
		`${JSON.stringify({ actualFilesystemWriter: "unknown", observedAt: new Date().toISOString(), rawNativeReceiptsDirectoryPath, evidence }, null, 2)}\n`,
	);
}

async function createNativeInstallationFixture() {
	const fixture = createIsolatedGitTestWorkspaceFixture({ fixtureRootDirectoryNamePrefix: "codex-shared-plugins-" });
	const root = fixture.fixtureRootDirectoryPath;
	const sourceHome = join(fixture.isolatedHomeDirectoryPath, ".codex");
	vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
	vi.stubEnv("CODEX_HOME", sourceHome);
	vi.stubEnv("CODEX_SQLITE_HOME", sourceHome);
	const binary = requireDefinedTestFixtureValue(process.env.KANBAN_CODEX_NATIVE_CONFIGURATION_SYNC_SMOKE_BINARY);
	const pluginRepository = fixture.createNonBareRepository({ repositoryDirectoryName: "hook-plugin-origin" });
	await mkdir(join(pluginRepository.repositoryPath, ".codex-plugin"));
	await mkdir(join(pluginRepository.repositoryPath, "hooks"));
	await writeFile(
		join(pluginRepository.repositoryPath, ".codex-plugin", "plugin.json"),
		JSON.stringify({ name: "hook-example", version: "1.0.0" }),
	);
	await writeFile(
		join(pluginRepository.repositoryPath, "hooks", "hooks.json"),
		JSON.stringify({
			hooks: {
				UserPromptSubmit: [{ hooks: [{ type: "command", command: `python3 "\${PLUGIN_ROOT}/record-hook.py"` }] }],
			},
		}),
	);
	await writeFile(
		join(pluginRepository.repositoryPath, "record-hook.py"),
		`import json, pathlib, sys\nbody=json.load(sys.stdin)\nwith pathlib.Path(${JSON.stringify(join(root, "executed-plugin-hooks.jsonl"))}).open("a") as output:\n output.write(json.dumps(body)+"\\n")\n`,
	);
	pluginRepository.commitAllRepositoryFilesAtDate({
		message: "建立隔离插件",
		authorAndCommitterIsoDate: "2026-10-01T00:00:00Z",
	});
	const marketplaceRepository = fixture.createNonBareRepository({ repositoryDirectoryName: "marketplace-origin" });
	await mkdir(join(marketplaceRepository.repositoryPath, ".agents", "plugins"), { recursive: true });
	await writeFile(
		join(marketplaceRepository.repositoryPath, ".agents", "plugins", "marketplace.json"),
		JSON.stringify({
			name: marketplaceName,
			plugins: configuredPluginNames.map((name, index) => ({
				name,
				source:
					index === 0
						? { source: "url", url: pathToFileURL(pluginRepository.repositoryPath).href, ref: "main" }
						: { source: "local", path: `./plugins/${name}` },
			})),
		}),
	);
	for (const name of configuredPluginNames.slice(1)) {
		const pluginPath = join(marketplaceRepository.repositoryPath, "plugins", name);
		await mkdir(join(pluginPath, ".codex-plugin"), { recursive: true });
		await mkdir(join(pluginPath, "skills", "example"), { recursive: true });
		await writeFile(join(pluginPath, ".codex-plugin", "plugin.json"), JSON.stringify({ name, version: "1.0.0" }));
		await writeFile(
			join(pluginPath, "skills", "example", "SKILL.md"),
			"---\nname: example\ndescription: 隔离技能\n---\n技能内容\n",
		);
	}
	marketplaceRepository.commitAllRepositoryFilesAtDate({
		message: "建立隔离 marketplace",
		authorAndCommitterIsoDate: "2026-10-01T00:00:00Z",
	});
	await mkdir(sourceHome, { recursive: true });
	await writeFile(
		join(sourceHome, "config.toml"),
		stringify({
			check_for_update_on_startup: false,
			features: { plugins: true, hooks: true, memories: false },
			plugins: Object.fromEntries(
				configuredPluginNames.map((name) => [`${name}@${marketplaceName}`, { enabled: true }]),
			),
			marketplaces: {
				[marketplaceName]: {
					source_type: "git",
					source: pathToFileURL(marketplaceRepository.repositoryPath).href,
					ref: "main",
				},
			},
			projects: { [root]: { trust_level: "trusted" } },
		}),
	);
	const environment = fixture.createIsolatedChildProcessEnvironment(
		{
			CODEX_HOME: sourceHome,
			CODEX_SQLITE_HOME: sourceHome,
		},
		{ gitTrace2EventOutputFileName: "native-git-lifecycle-trace.jsonl" },
	);
	const traceFile = requireDefinedTestFixtureValue(environment.GIT_TRACE2_EVENT);
	const writer = (binaryOverride = binary) =>
		prepareCodexConfigurationWriterBinding({
			purpose: "native_session",
			storageHome: sourceHome,
			workspaceId: "shared-plugin-fixture",
			conversationSessionId: randomUUID(),
			runtimeSessionIncarnationId: randomUUID(),
			binary: binaryOverride,
			environment,
		});
	const upgrade = async (home = sourceHome, sourceReadArguments: string[] = []) => {
		const child = children.register(
			spawn(binary, ["plugin", "marketplace", "upgrade", "--json", ...sourceReadArguments], {
				cwd: root,
				env: { ...environment, CODEX_HOME: home },
				stdio: ["ignore", "pipe", "pipe"],
			}),
		);
		let stdout = "",
			stderr = "";
		child.stdout?.on("data", (bytes) => {
			stdout += bytes.toString();
		});
		child.stderr?.on("data", (bytes) => {
			stderr += bytes.toString();
		});
		await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline({ annotate: async () => {} }, child, {
			waitedForDescription: "隔离 Codex 原生 marketplace 升级完成并退出",
			softDeadlineMsExpectedOnUncontendedHost: 10_000,
			hardDeadlineMsOnlyExplainedByRealHangOrRegression: 60_000,
		});
		const result = { exitCode: child.exitCode, stdout, stderr, traceFile };
		return { ...result, outcome: child.exitCode === 0 ? upgradeResponseSchema.parse(JSON.parse(stdout)) : null };
	};
	const snapshot = async () =>
		Promise.all(
			configuredPluginNames.map(async (name) => {
				const pluginPath = join(sourceHome, "plugins", "cache", marketplaceName, name, "1.0.0");
				const metadata = await stat(pluginPath);
				const digest = createHash("sha256");
				const visit = async (directory: string, relativePath = "") => {
					for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
						left.name.localeCompare(right.name),
					)) {
						if (entry.name === ".git") continue;
						const filePath = join(directory, entry.name),
							relativeFilePath = join(relativePath, entry.name);
						if (entry.isDirectory()) await visit(filePath, relativeFilePath);
						else {
							digest.update(relativeFilePath);
							digest.update(await readFile(filePath));
						}
					}
				};
				await visit(pluginPath);
				return {
					name,
					path: pluginPath,
					identity: `${metadata.dev}:${metadata.ino}`,
					payloadDigest: digest.digest("hex"),
				};
			}),
		);
	const managedLaunch = (binding: CodexConfigurationWriterBinding) =>
		prepareCodexSharedPluginInstallationForNativeLaunch({
			binding,
			binary,
			environment: { ...environment, ...buildCodexConfigurationWriterEnvironment(binding) },
			nativeLaunchArguments: [],
			workingDirectory: root,
		});
	return {
		fixture,
		root,
		sourceHome,
		binary,
		environment,
		writer,
		upgrade,
		snapshot,
		marketplaceRepository,
		pluginRepository,
		managedLaunch,
		gitTraceFilePath: traceFile,
		gitLifecycleCounts: async () => {
			const records = (await readFile(traceFile, "utf8").catch(() => ""))
				.split("\n")
				.filter(Boolean)
				.map((line) =>
					z.object({ event: z.string(), argv: z.array(z.string()).optional() }).parse(JSON.parse(line)),
				);
			const starts = records.filter((record) => record.event === "start");
			return {
				revisionProbes: starts.filter((record) => record.argv?.includes("ls-remote")).length,
				marketplaceClones: starts.filter(
					(record) =>
						record.argv?.includes("clone") &&
						record.argv.some((argument) => argument.includes("marketplaces/.staging")),
				).length,
				pluginSourceClones: starts.filter(
					(record) =>
						record.argv?.includes("clone") &&
						record.argv.some((argument) => argument.includes(".marketplace-plugin-source-staging")),
				).length,
			};
		},
	};
}

describe.skipIf(!process.env.KANBAN_CODEX_NATIVE_CONFIGURATION_SYNC_SMOKE_BINARY)(
	"真实 Codex 同源插件安装记录与目录稳定性",
	{ timeout: 240_000 },
	() => {
		it("已有完整记录时，新 writer 不重新安装相同 revision 的最终插件目录", async () => {
			const native = await createNativeInstallationFixture();
			expect((await native.upgrade()).outcome?.upgradedRoots).toHaveLength(1);
			const before = await native.snapshot();
			const binding = await native.writer();
			const completion = await native.upgrade(binding.configurationHomeDirectoryPath);
			expect(completion, completion.stderr).toMatchObject({ exitCode: 0 });
			expect(await native.snapshot()).toEqual(before);
			expect(completion.outcome?.upgradedRoots).toEqual([]);
		});

		it("来源域协调让冷启动、已有记录与真实 revision 更新的三个并发进程仅完成一次最终安装", async () => {
			const native = await createNativeInstallationFixture();
			const bindings = await Promise.all([native.writer(), native.writer(), native.writer()]);
			const concurrentUpgrade = () => Promise.all(bindings.map((binding) => native.managedLaunch(binding)));
			const cold = await concurrentUpgrade();
			expect(
				cold.reduce((count, result) => count + result.nativeUpgradeCount, 0),
				JSON.stringify(cold),
			).toBe(1);
			expect(cold.reduce((count, result) => count + result.nativePluginInstallationCount, 0)).toBe(3);
			const installed = await native.snapshot();
			const steady = await concurrentUpgrade();
			expect(
				steady.every((result) => result.nativeUpgradeCount === 0 && result.nativePluginInstallationCount === 0),
				JSON.stringify(steady),
			).toBe(true);
			expect(await native.snapshot()).toEqual(installed);
			await writeFile(join(native.marketplaceRepository.repositoryPath, "new-revision.txt"), "真实更新\n");
			native.marketplaceRepository.commitAllRepositoryFilesAtDate({
				message: "真实 revision 更新",
				authorAndCommitterIsoDate: "2026-10-02T00:00:00Z",
			});
			const updated = await concurrentUpgrade();
			expect(
				updated.reduce((count, result) => count + result.nativeUpgradeCount, 0),
				JSON.stringify(updated),
			).toBe(1);
			expect(updated.reduce((count, result) => count + result.nativePluginInstallationCount, 0)).toBe(3);
			const current = await native.snapshot();
			expect(current.map((plugin) => plugin.identity)).not.toEqual(installed.map((plugin) => plugin.identity));
			expect((await concurrentUpgrade()).every((result) => result.nativeUpgradeCount === 0)).toBe(true);
			expect(await native.snapshot()).toEqual(current);
			await recordNativeVerificationEvidence(
				"concurrent-cold-steady-and-revision-update",
				{
					cold,
					steady,
					updated,
					installed,
					current,
					gitLifecycleCounts: await native.gitLifecycleCounts(),
					finalDirectoryReplacementsOnRealRevisionUpdate: current.filter(
						(plugin, index) => plugin.identity !== installed[index].identity,
					).length,
				},
				native,
			);
			for (let index = 0; index < bindings.length; index++) {
				const completion = await native.upgrade(
					bindings[index].configurationHomeDirectoryPath,
					cold[index].arguments,
				);
				expect(completion.outcome?.selectedMarketplaces).toEqual([]);
			}
			for (const binding of bindings) {
				expect(await realpath(join(binding.configurationHomeDirectoryPath, "plugins"))).toBe(
					join(native.sourceHome, "plugins"),
				);
				expect(buildCodexConfigurationWriterEnvironment(binding).CODEX_SQLITE_HOME).toBe(native.sourceHome);
			}
		});

		it("两次真实 prompt 之间启动同源辅助 app-server，hook 实际执行且原所有者的批准和插件目录不变", async () => {
			const native = await createNativeInstallationFixture();
			let responseSequence = 0;
			const model = createServer(async (request, response) => {
				for await (const _chunk of request) {
					/* 完整消费本地请求。 */
				}
				if (!request.url?.includes("responses")) {
					response.writeHead(200, { "Content-Type": "application/json" });
					response.end('{"data":[]}');
					return;
				}
				const sequence = ++responseSequence;
				const item = {
					type: "message",
					id: `message-${sequence}`,
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "隔离 hook 验证", annotations: [] }],
				};
				const result = {
					id: `response-${sequence}`,
					object: "response",
					created_at: Math.floor(Date.now() / 1000),
					status: "completed",
					model: "gpt-5.4",
					output: [item],
					usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
				};
				response.writeHead(200, { "Content-Type": "text/event-stream" });
				for (const [type, fields] of [
					["response.created", { response: { ...result, status: "in_progress", output: [] } }],
					["response.output_item.done", { output_index: 0, item }],
					["response.completed", { response: result }],
				] as const)
					response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
				response.end();
			});
			await new Promise<void>((resolveListening) => model.listen(0, "127.0.0.1", resolveListening));
			onTestFinished(async () => {
				model.closeAllConnections();
				await new Promise<void>((resolveClosed) => model.close(() => resolveClosed()));
			});
			const address = model.address();
			if (!address || typeof address === "string") throw new Error("隔离模型服务未监听。");
			const configurationPath = join(native.sourceHome, "config.toml");
			const configuration = parse(await readFile(configurationPath, "utf8"));
			configuration.model = "gpt-5.4";
			configuration.model_provider = "isolated_plugin_hook_model";
			configuration.model_providers = {
				isolated_plugin_hook_model: {
					name: "隔离插件 hook 模型",
					base_url: `http://127.0.0.1:${address.port}/v1`,
					wire_api: "responses",
					requires_openai_auth: false,
					supports_websockets: false,
				},
			};
			const unrelatedLocalMarketplace = join(native.root, "unrelated-local-marketplace");
			const unrelatedLocalSource = join(unrelatedLocalMarketplace, "plugins", "unrelated-local");
			await mkdir(join(unrelatedLocalMarketplace, ".agents", "plugins"), { recursive: true });
			await mkdir(join(unrelatedLocalSource, ".codex-plugin"), { recursive: true });
			await writeFile(
				join(unrelatedLocalSource, ".codex-plugin", "plugin.json"),
				JSON.stringify({ name: "unrelated-local", version: "1.0.0" }),
			);
			await writeFile(join(unrelatedLocalSource, "local-resource.txt"), "无关本地插件资源\n");
			await writeFile(
				join(unrelatedLocalMarketplace, ".agents", "plugins", "marketplace.json"),
				JSON.stringify({
					name: "unrelated-local-fixture",
					plugins: [{ name: "unrelated-local", source: { source: "local", path: "./plugins/unrelated-local" } }],
				}),
			);
			const unrelatedLocalInstallation = join(
				native.sourceHome,
				"plugins",
				"cache",
				"unrelated-local-fixture",
				"unrelated-local",
				"1.0.0",
			);
			await cp(unrelatedLocalSource, unrelatedLocalInstallation, { recursive: true });
			const unrelatedLocalIdentity = (await stat(unrelatedLocalInstallation)).ino;
			if (!configurationTable(configuration.marketplaces) || !configurationTable(configuration.plugins))
				throw new Error("隔离插件配置缺失。");
			configuration.marketplaces["unrelated-local-fixture"] = {
				source_type: "local",
				source: unrelatedLocalMarketplace,
			};
			configuration.plugins["unrelated-local@unrelated-local-fixture"] = { enabled: true };
			await writeFile(configurationPath, stringify(configuration));
			const standaloneSkillPath = join(native.sourceHome, "skills", "independent-skill", "SKILL.md");
			await mkdir(join(standaloneSkillPath, ".."), { recursive: true });
			await writeFile(
				standaloneSkillPath,
				"---\nname: independent-skill\ndescription: 独立技能\n---\n独立技能内容\n",
			);
			const standaloneSkillBefore = await readFile(standaloneSkillPath, "utf8");
			const binding = await native.writer();
			const launch = await native.managedLaunch(binding);
			const environment = { ...native.environment, ...buildCodexConfigurationWriterEnvironment(binding) };
			const nativeInput = {
				binary: native.binary,
				workingDirectory: native.root,
				environment,
				experimentalApi: true,
				argumentsBeforeSubcommand: launch.arguments,
			};
			const initialHook = await withCodexAppServerRequestConnection(
				nativeInput,
				async (port) =>
					hooksResponseSchema.parse(await port.request("hooks/list", { cwds: [native.root] })).data[0].hooks[0],
			);
			const [trusted_hash, trusted_content_hash] = initialHook.currentHash.split("/");
			expect(trusted_content_hash).toMatch(/^sha256:/);
			const writerConfigurationPath = join(binding.configurationHomeDirectoryPath, "config.toml");
			const writerConfiguration = parse(await readFile(writerConfigurationPath, "utf8"));
			writerConfiguration.hooks = {
				state: { [initialHook.key]: { enabled: true, trusted_hash, trusted_content_hash } },
			};
			await writeFile(writerConfigurationPath, stringify(writerConfiguration));
			const installedBefore = await native.snapshot();
			await withCodexAppServerRequestConnection(nativeInput, async (owner) => {
				const effective = z
					.object({
						config: z.object({ marketplaces: z.record(z.string(), z.object({ source_type: z.string() })) }),
					})
					.parse(await owner.request("config/read", { includeLayers: false }));
				expect(effective.config.marketplaces[marketplaceName].source_type).toBe("local");
				const thread = z.object({ thread: z.object({ id: z.string(), path: z.string().nullable() }) }).parse(
					await owner.request("thread/start", {
						cwd: native.root,
						approvalPolicy: "never",
						sandbox: "danger-full-access",
						persistExtendedHistory: true,
					}),
				).thread;
				const runTurn = async (prompt: string) => {
					const turn = z.object({ turn: z.object({ id: z.string() }) }).parse(
						await owner.request("turn/start", {
							threadId: thread.id,
							input: [{ type: "text", text: prompt }],
						}),
					).turn;
					await vi.waitFor(
						async () => {
							const result = z
								.object({
									thread: z.object({ turns: z.array(z.object({ id: z.string(), status: z.string() })) }),
								})
								.parse(await owner.request("thread/read", { threadId: thread.id, includeTurns: true }));
							expect(result.thread.turns.find((candidate) => candidate.id === turn.id)?.status).toBe(
								"completed",
							);
						},
						{ timeout: 60_000, interval: 50 },
					);
				};
				await runTurn("第一次原生插件 hook 验证");
				await withCodexAppServerRequestConnection(
					{
						...nativeInput,
						argumentsBeforeSubcommand: [],
						codexConversationStorageHomeDirectoryPath: binding.configurationHomeDirectoryPath,
					},
					async (helper) => {
						const hook = hooksResponseSchema.parse(await helper.request("hooks/list", { cwds: [native.root] }))
							.data[0].hooks[0];
						expect(hook.currentHash).toBe(initialHook.currentHash);
					},
				);
				await runTurn("第二次原生插件 hook 验证");
				const hook = hooksResponseSchema.parse(await owner.request("hooks/list", { cwds: [native.root] })).data[0]
					.hooks[0];
				expect(hook).toMatchObject({ trustStatus: "trusted", currentHash: initialHook.currentHash });
				if (!thread.path) throw new Error("原所有者未返回可核验转录路径。");
				expect(await readFile(thread.path, "utf8")).not.toContain(
					"plugin contents changed; hook approval required",
				);
			});
			const observations = (await readFile(join(native.root, "executed-plugin-hooks.jsonl"), "utf8"))
				.trim()
				.split("\n")
				.map((line) => z.object({ prompt: z.string(), hook_event_name: z.string() }).parse(JSON.parse(line)));
			expect(observations.map((entry) => entry.prompt)).toEqual([
				"第一次原生插件 hook 验证",
				"第二次原生插件 hook 验证",
			]);
			expect(observations.every((entry) => entry.hook_event_name === "UserPromptSubmit")).toBe(true);
			expect(await native.snapshot()).toEqual(installedBefore);
			expect(await readFile(standaloneSkillPath, "utf8")).toBe(standaloneSkillBefore);
			expect((await stat(unrelatedLocalInstallation)).ino).toBe(unrelatedLocalIdentity);
			expect(await readFile(join(unrelatedLocalInstallation, "local-resource.txt"), "utf8")).toBe(
				"无关本地插件资源\n",
			);
			expect(parse(await readFile(writerConfigurationPath, "utf8")).marketplaces).toEqual(
				configuration.marketplaces,
			);
			await recordNativeVerificationEvidence(
				"two-native-prompts-with-intermediate-auxiliary-process",
				{
					observations,
					nativeHookFingerprint: initialHook.currentHash,
					installedBefore,
					installedAfter: await native.snapshot(),
					gitLifecycleCounts: await native.gitLifecycleCounts(),
					originalGitConfigurationRetained: true,
					unrelatedLocalInstallationIdentity: unrelatedLocalIdentity,
				},
				native,
			);
		});

		it("marketplace 已激活但后续插件缺失时，三次失败后只补证；来源恢复后自动接续且不重装已完成插件", async () => {
			const native = await createNativeInstallationFixture();
			const sourceConfigurationPath = join(native.sourceHome, "config.toml");
			const configured = parse(await readFile(sourceConfigurationPath, "utf8"));
			await writeFile(sourceConfigurationPath, stringify({ ...configured, plugins: {} }));
			expect((await native.upgrade()).outcome?.upgradedRoots).toHaveLength(1);
			await writeFile(sourceConfigurationPath, stringify(configured));
			const marketplaceRoot = join(native.sourceHome, ".tmp", "marketplaces", marketplaceName);
			const activatedIdentity = (await stat(marketplaceRoot)).ino;
			const missingSource = join(marketplaceRoot, "plugins", "second-example");
			await rename(missingSource, `${missingSource}-interrupted`);
			const binding = await native.writer();
			await expect(native.managedLaunch(binding)).rejects.toThrow(/机器补证/);
			const directory = join(native.sourceHome, "plugins", ".kanban-source-installation-coordination");
			const statePath = join(
				directory,
				requireDefinedTestFixtureValue(
					(await readdir(directory)).find((name) => /^source-installation-[a-f0-9]{64}\.json$/.test(name)),
				),
			);
			const pending = JSON.parse(await readFile(statePath, "utf8"));
			expect(pending).toMatchObject({
				phase: "waiting_for_evidence",
				attemptCount: 3,
				completedMarketplaceNames: [marketplaceName],
			});
			const completedHookPlugin = pending.completedPluginInstallations[`hook-example@${marketplaceName}`];
			expect(completedHookPlugin).toBeDefined();
			const attemptsBefore = (await readdir(directory)).filter((name) => name.startsWith("native-attempt-"));
			await expect(native.managedLaunch(binding)).rejects.toThrow(/机器补证/);
			expect((await readdir(directory)).filter((name) => name.startsWith("native-attempt-"))).toEqual(
				attemptsBefore,
			);
			await rename(`${missingSource}-interrupted`, missingSource);
			const latest = JSON.parse(await readFile(statePath, "utf8"));
			await writeFile(statePath, JSON.stringify({ ...latest, nextEvidenceObservationAtMs: 0 }));
			await recoverPendingCodexSharedPluginInstallations([binding], native.environment);
			const recovered = JSON.parse(await readFile(statePath, "utf8"));
			expect(recovered.phase).toBe("ready");
			expect(recovered.completedPluginInstallations[`hook-example@${marketplaceName}`]).toEqual(completedHookPlugin);
			expect((await stat(marketplaceRoot)).ino).toBe(activatedIdentity);
			expect(await native.snapshot()).toHaveLength(3);
			expect(await readFile(join(directory, "source-installation-progress-events.jsonl"), "utf8")).toContain(
				'"phase":"waiting_for_evidence"',
			);
		});

		it("跨 profile 接管先等待存活原生进程，恢复时自动接续持久意图并复用已完成插件", async () => {
			const native = await createNativeInstallationFixture();
			const gate = join(native.root, "hold-first-native-plugin-installation");
			const ready = join(native.root, "held-native-plugin-process.json");
			await writeFile(gate, "暂停原生安装，以验证崩溃恢复");
			const instrumentedBinary = join(native.root, "codex-native-installation-lifecycle-fixture");
			await writeFile(
				instrumentedBinary,
				`#!${process.execPath}\nconst fs=require('node:fs');const cp=require('node:child_process');const args=process.argv.slice(2);if(args[0]==='plugin'&&args[1]==='add'&&fs.existsSync(${JSON.stringify(gate)})){fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid}));setTimeout(()=>process.exit(124),60000);}else{const child=cp.spawn(${JSON.stringify(native.binary)},args,{stdio:'inherit'});child.on('exit',(code)=>{process.exitCode=code??1;});}\n`,
				{ mode: 0o700 },
			);
			const binding = await native.writer(instrumentedBinary);
			const moduleUrl = new URL(
				"../../src/codex-configuration-sync/codex-source-shared-plugin-installation-coordinator.ts",
				import.meta.url,
			).href;
			const clientScript = join(native.root, "run-native-installation-coordinator.mjs");
			await writeFile(
				clientScript,
				`import {prepareCodexSharedPluginInstallationForNativeLaunch} from ${JSON.stringify(moduleUrl)};await prepareCodexSharedPluginInstallationForNativeLaunch({binding:${JSON.stringify(binding)},binary:${JSON.stringify(instrumentedBinary)},environment:process.env,nativeLaunchArguments:[],workingDirectory:${JSON.stringify(native.root)}});\n`,
			);
			const coordinator = children.register(
				spawn(
					process.execPath,
					["--import", new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url).pathname, clientScript],
					{ cwd: native.root, env: native.environment, stdio: "ignore" },
				),
			);
			let heldNativePid: number | undefined;
			onTestFinished(async () => {
				if (!heldNativePid) {
					try {
						heldNativePid = JSON.parse(await readFile(ready, "utf8")).pid;
					} catch {
						/* 原生进程可能尚未启动。 */
					}
				}
				if (heldNativePid) {
					const command = (await readProcessCommandLinesForProcessIds([heldNativePid])).get(heldNativePid);
					try {
						if (command?.includes(instrumentedBinary)) {
							process.kill(heldNativePid, "SIGKILL");
						}
					} catch {
						/* 已退出。 */
					}
				}
			});
			await vi.waitFor(
				async () => {
					heldNativePid = z.object({ pid: z.number() }).parse(JSON.parse(await readFile(ready, "utf8"))).pid;
				},
				{ timeout: 30_000, interval: 50 },
			);
			coordinator.kill("SIGKILL");
			await vi.waitFor(() => expect(coordinator.signalCode).toBe("SIGKILL"), { timeout: 10_000 });
			const directory = join(native.sourceHome, "plugins", ".kanban-source-installation-coordination");
			const statePath = join(
				directory,
				requireDefinedTestFixtureValue(
					(await readdir(directory)).find((name) => /^source-installation-[a-f0-9]{64}\.json$/.test(name)),
				),
			);
			const before = JSON.parse(await readFile(statePath, "utf8"));
			expect(before.completedMarketplaceNames).toEqual([marketplaceName]);
			const otherProfileBinding = await native.writer(instrumentedBinary);
			const otherProfileConfigurationPath = join(otherProfileBinding.configurationHomeDirectoryPath, "config.toml");
			const otherProfileConfiguration = parse(await readFile(otherProfileConfigurationPath, "utf8"));
			otherProfileConfiguration.plugins = { [`skills-example@${marketplaceName}`]: { enabled: true } };
			await writeFile(otherProfileConfigurationPath, stringify(otherProfileConfiguration));
			const attemptsBefore = (await readdir(directory)).filter((name) => name.startsWith("native-attempt-"));
			const staleTimestamp = new Date(Date.now() - 60_000);
			await utimes(join(directory, "native-source-installation.lock"), staleTimestamp, staleTimestamp);
			const request = (requestedBinding = binding) =>
				prepareCodexSharedPluginInstallationForNativeLaunch({
					binding: requestedBinding,
					binary: instrumentedBinary,
					environment: native.environment,
					nativeLaunchArguments: [],
					workingDirectory: native.root,
				});
			await expect(request(otherProfileBinding)).rejects.toThrow(/原生插件安装所有者仍在执行/);
			expect((await readdir(directory)).filter((name) => name.startsWith("native-attempt-"))).toEqual(
				attemptsBefore,
			);
			const intentsDirectory = join(directory, "native-launch-preparation-intents");
			const otherProfileIntentPath = requireDefinedTestFixtureValue(
				(
					await Promise.all(
						(
							await readdir(intentsDirectory)
						).map(async (name) => {
							const path = join(intentsDirectory, name);
							const intent = JSON.parse(await readFile(path, "utf8"));
							return intent.writerId === otherProfileBinding.writerId ? path : undefined;
						}),
					)
				).find(Boolean),
			);
			const otherProfileIntent = JSON.parse(await readFile(otherProfileIntentPath, "utf8"));
			expect(otherProfileIntent.status).toBe("pending");
			expect(otherProfileIntent.sourceInstallationStatePath).not.toBe(statePath);
			process.kill(requireDefinedTestFixtureValue(heldNativePid), "SIGKILL");
			await rm(gate);
			await vi.waitFor(
				async () => {
					const command = (
						await readProcessCommandLinesForProcessIds([requireDefinedTestFixtureValue(heldNativePid)])
					).get(requireDefinedTestFixtureValue(heldNativePid));
					expect(command?.includes(instrumentedBinary) ?? false).toBe(false);
				},
				{ timeout: 30_000, interval: 100 },
			);
			await writeFile(
				otherProfileIntentPath,
				JSON.stringify({ ...otherProfileIntent, nextEvidenceObservationAtMs: 0 }),
			);
			await recoverPendingCodexSharedPluginInstallations([otherProfileBinding], native.environment);
			const otherProfileRecovered = JSON.parse(
				await readFile(otherProfileIntent.sourceInstallationStatePath, "utf8"),
			);
			expect(otherProfileRecovered.phase).toBe("ready");
			expect(JSON.parse(await readFile(otherProfileIntentPath, "utf8")).status).toBe("completed");
			const installedSkillsIdentity = (
				await stat(join(native.sourceHome, "plugins", "cache", marketplaceName, "skills-example", "1.0.0"))
			).ino;
			const recoveredLaunch = await request();
			expect(recoveredLaunch.status).toBe("ready");
			expect(recoveredLaunch.nativePluginInstallationCount).toBe(2);
			expect(
				(await stat(join(native.sourceHome, "plugins", "cache", marketplaceName, "skills-example", "1.0.0"))).ino,
			).toBe(installedSkillsIdentity);
			expect(
				JSON.parse(await readFile(statePath, "utf8")).completedPluginInstallations[
					`skills-example@${marketplaceName}`
				].reusedCompletionEvidenceStatePath,
			).toBe(otherProfileIntent.sourceInstallationStatePath);
			expect(JSON.parse(await readFile(statePath, "utf8")).completedMarketplaceNames).toEqual([marketplaceName]);
			expect(await native.snapshot()).toHaveLength(3);
			await recordNativeVerificationEvidence(
				"coordinator-restart-and-surviving-native-owner",
				{
					before,
					otherProfileIntent,
					otherProfileRecovered,
					recoveredLaunch,
					recovered: JSON.parse(await readFile(statePath, "utf8")),
					attemptsBefore,
					gitLifecycleCounts: await native.gitLifecycleCounts(),
				},
				native,
			);
		});

		it("已存在真实旧 writer 安装树时复用完整树和原生记录，不替换最终插件目录", async () => {
			const native = await createNativeInstallationFixture();
			expect((await native.upgrade()).outcome?.upgradedRoots).toHaveLength(1);
			const legacy = await prepareCodexConfigurationWriterBinding({
				purpose: "native_session",
				storageHome: native.sourceHome,
				runtimeSessionIncarnationId: randomUUID(),
				environment: native.environment,
			});
			expect(legacy.sourceSharedPluginInstallationDirectoriesBinding).toBeUndefined();
			expect((await native.upgrade(legacy.configurationHomeDirectoryPath)).outcome?.upgradedRoots).toHaveLength(1);
			const before = await native.snapshot();
			const originalMetadata = await readFile(
				join(
					legacy.configurationHomeDirectoryPath,
					".tmp",
					"marketplaces",
					marketplaceName,
					".codex-marketplace-install.json",
				),
				"utf8",
			);
			await rm(join(native.sourceHome, ".tmp", "marketplaces", marketplaceName), { recursive: true });
			const binding = await native.writer();
			const launch = await native.managedLaunch(binding);
			expect(launch).toMatchObject({ nativeUpgradeCount: 0, nativePluginInstallationCount: 0, status: "ready" });
			expect(await native.snapshot()).toEqual(before);
			expect(
				await readFile(
					join(native.sourceHome, ".tmp", "marketplaces", marketplaceName, ".codex-marketplace-install.json"),
					"utf8",
				),
			).toBe(originalMetadata);
		});

		it("断网保留完整缓存，三次后只观察，连接恢复后自动重验且不重复安装", async () => {
			const native = await createNativeInstallationFixture();
			const binding = await native.writer();
			const initial = await native.managedLaunch(binding);
			const before = await native.snapshot();
			const origin = native.marketplaceRepository.repositoryPath;
			await rename(origin, `${origin}-offline`);
			const unavailable = await native.managedLaunch(binding);
			expect(unavailable.status).toBe("ready_with_pending_native_update");
			expect(await native.snapshot()).toEqual(before);
			const statePath = requireDefinedTestFixtureValue("statePath" in initial ? initial.statePath : undefined);
			const pending = JSON.parse(await readFile(statePath, "utf8"));
			expect(pending.attemptCount).toBe(3);
			const directory = join(statePath, "..");
			const attempts = (await readdir(directory)).filter((name) => name.startsWith("native-attempt-"));
			await native.managedLaunch(binding);
			expect((await readdir(directory)).filter((name) => name.startsWith("native-attempt-"))).toEqual(attempts);
			await rename(`${origin}-offline`, origin);
			await writeFile(
				statePath,
				JSON.stringify({ ...JSON.parse(await readFile(statePath, "utf8")), nextEvidenceObservationAtMs: 0 }),
			);
			await recoverPendingCodexSharedPluginInstallations([binding], native.environment);
			const recovered = JSON.parse(await readFile(statePath, "utf8"));
			expect(recovered.phase).toBe("ready");
			expect(await native.snapshot()).toEqual(before);
			await recordNativeVerificationEvidence(
				"network-loss-and-automatic-recovery",
				{
					pending,
					recovered,
					before,
					after: await native.snapshot(),
				},
				native,
			);
		});

		it("同名 marketplace 的 URL、ref 或 sparse paths 不同，即使 revision 相同也不误用旧安装记录", async () => {
			const native = await createNativeInstallationFixture();
			const binding = await native.writer();
			await native.managedLaunch(binding);
			const duplicate = native.fixture.createNonBareRepository({
				repositoryDirectoryName: "same-revision-different-url-origin",
			});
			for (const name of [".agents", "plugins"])
				await cp(join(native.marketplaceRepository.repositoryPath, name), join(duplicate.repositoryPath, name), {
					recursive: true,
				});
			const duplicateRevision = duplicate.commitAllRepositoryFilesAtDate({
				message: "建立隔离 marketplace",
				authorAndCommitterIsoDate: "2026-10-01T00:00:00Z",
			});
			expect(duplicateRevision).toBe(native.marketplaceRepository.runGit(["rev-parse", "HEAD"]).stdout.trim());
			duplicate.runGit(["branch", "alternate-ref"]);
			const path = join(binding.configurationHomeDirectoryPath, "config.toml");
			const configuration = parse(await readFile(path, "utf8"));
			const outcomes = [];
			for (const replacement of [
				{ source_type: "git", source: pathToFileURL(duplicate.repositoryPath).href, ref: "main" },
				{ source_type: "git", source: pathToFileURL(duplicate.repositoryPath).href, ref: "alternate-ref" },
				{
					source_type: "git",
					source: pathToFileURL(duplicate.repositoryPath).href,
					ref: "alternate-ref",
					sparse_paths: [".agents", "plugins"],
				},
			]) {
				configuration.marketplaces = {
					[marketplaceName]: {
						source_type: replacement.source_type,
						source: replacement.source,
						ref: replacement.ref,
						...(replacement.sparse_paths ? { sparse_paths: replacement.sparse_paths } : {}),
					},
				};
				await writeFile(path, stringify(configuration));
				const result = await native.managedLaunch(binding);
				expect(result).toMatchObject({ status: "ready", nativeUpgradeCount: 1, nativePluginInstallationCount: 3 });
				const metadata = JSON.parse(
					await readFile(
						join(native.sourceHome, ".tmp", "marketplaces", marketplaceName, ".codex-marketplace-install.json"),
						"utf8",
					),
				);
				expect(metadata.source).toBe(replacement.source);
				expect(metadata.ref_name).toBe(replacement.ref);
				expect(metadata.revision).toBe(duplicateRevision);
				outcomes.push({ replacement, result, metadata });
			}
			await recordNativeVerificationEvidence("same-name-different-url-ref-and-sparse-paths", outcomes, native);
		});

		it("真实脚本变化、失效批准、禁用与撤销保持原生门禁；协调器不恢复脚本或重新签名", async () => {
			const native = await createNativeInstallationFixture();
			const binding = await native.writer();
			const launch = await native.managedLaunch(binding);
			const input = {
				binary: native.binary,
				workingDirectory: native.root,
				environment: { ...native.environment, ...buildCodexConfigurationWriterEnvironment(binding) },
				experimentalApi: true,
				argumentsBeforeSubcommand: launch.arguments,
			};
			const hooks = () =>
				withCodexAppServerRequestConnection(
					input,
					async (port) =>
						hooksResponseSchema.parse(await port.request("hooks/list", { cwds: [native.root] })).data[0].hooks[0],
				);
			const initial = await hooks();
			const [trusted_hash, trusted_content_hash] = initial.currentHash.split("/");
			const path = join(binding.configurationHomeDirectoryPath, "config.toml");
			const configuration = parse(await readFile(path, "utf8"));
			configuration.hooks = { state: { [initial.key]: { enabled: true, trusted_hash, trusted_content_hash } } };
			await writeFile(path, stringify(configuration));
			expect((await hooks()).trustStatus).toBe("trusted");
			const pluginPath = join(native.sourceHome, "plugins", "cache", marketplaceName, "hook-example", "1.0.0");
			const originalIdentity = (await stat(pluginPath)).ino;
			const script = join(pluginPath, "record-hook.py");
			const changedScript = `${await readFile(script, "utf8")}\n# 实际脚本变化，必须重新确认\n`;
			await writeFile(script, changedScript);
			const stable = await native.managedLaunch(binding);
			expect(stable.nativePluginInstallationCount).toBe(0);
			expect((await stat(pluginPath)).ino).toBe(originalIdentity);
			expect(await readFile(script, "utf8")).toBe(changedScript);
			expect((await hooks()).trustStatus).toBe("modified");
			configuration.hooks = { state: { [initial.key]: { enabled: false, trusted_hash, trusted_content_hash } } };
			await writeFile(path, stringify(configuration));
			await native.managedLaunch(binding);
			expect((await hooks()).enabled).toBe(false);
			configuration.hooks = { state: { [initial.key]: { enabled: true } } };
			await writeFile(path, stringify(configuration));
			await native.managedLaunch(binding);
			expect((await hooks()).trustStatus).toBe("untrusted");
			expect(parse(await readFile(path, "utf8")).hooks).toEqual(configuration.hooks);
		});

		it("完整缓存不能在仍存活的原生子进程上返回可启动", async () => {
			const native = await createNativeInstallationFixture();
			const binding = await native.writer();
			const initial = await native.managedLaunch(binding);
			const before = await native.snapshot();
			const statePath = requireDefinedTestFixtureValue("statePath" in initial ? initial.statePath : undefined);
			const state = JSON.parse(await readFile(statePath, "utf8"));
			const attemptId = randomUUID();
			const attemptDirectory = join(statePath, "..", `native-attempt-${attemptId}`);
			await mkdir(attemptDirectory);
			const processMarker = join(attemptDirectory, "native-logs");
			const held = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", processMarker], {
				detached: true,
				stdio: "ignore",
			});
			onTestFinished(() => {
				try {
					if (held.pid) process.kill(-held.pid, "SIGKILL");
				} catch {
					/* 原生子进程已退出。 */
				}
			});
			state.phase = "ready";
			state.activeNativeAttempt = {
				attemptId,
				operationKey: `plugin_install:hook-example@${marketplaceName}`,
				kind: "plugin_install",
				selection: `hook-example@${marketplaceName}`,
				stdoutPath: join(attemptDirectory, "native.stdout.json"),
				stderrPath: join(attemptDirectory, "native.stderr.log"),
				processMarker,
				startedAtMs: Date.now(),
				processId: held.pid,
			};
			await writeFile(statePath, JSON.stringify(state));
			await expect(native.managedLaunch(binding)).rejects.toThrow(/原生插件安装所有者仍在执行/);
			expect(await native.snapshot()).toEqual(before);
		});

		it("插件仓库 revision 变化而 marketplace revision 不变时仍执行原生 plugin add", async () => {
			const native = await createNativeInstallationFixture();
			const binding = await native.writer();
			await native.managedLaunch(binding);
			const before = await native.snapshot();
			const script = join(native.pluginRepository.repositoryPath, "record-hook.py");
			await writeFile(script, `${await readFile(script, "utf8")}# 插件源 revision 更新\n`);
			native.pluginRepository.commitAllRepositoryFilesAtDate({
				message: "插件源 revision 更新",
				authorAndCommitterIsoDate: "2026-10-03T00:00:00Z",
			});
			const updated = await native.managedLaunch(binding);
			expect(updated.nativePluginInstallationCount).toBe(1);
			const after = await native.snapshot();
			const plugin = (name: string, snapshot: typeof before) =>
				requireDefinedTestFixtureValue(snapshot.find((entry) => entry.name === name));
			expect(plugin("hook-example", after).payloadDigest).not.toBe(plugin("hook-example", before).payloadDigest);
			expect(plugin("skills-example", after).identity).toBe(plugin("skills-example", before).identity);
			expect(plugin("second-example", after).identity).toBe(plugin("second-example", before).identity);
		});

		it("marketplace 已激活到新 revision 而最终插件仍是旧缓存时补跑原生安装", async () => {
			const native = await createNativeInstallationFixture();
			expect((await native.upgrade()).outcome?.upgradedRoots).toHaveLength(1);
			const before = await native.snapshot();
			const skill = join(
				native.marketplaceRepository.repositoryPath,
				"plugins",
				"skills-example",
				"skills",
				"example",
				"SKILL.md",
			);
			await writeFile(skill, "---\nname: example\ndescription: 隔离技能\n---\n新修订内容\n");
			native.marketplaceRepository.commitAllRepositoryFilesAtDate({
				message: "只推进 marketplace revision",
				authorAndCommitterIsoDate: "2026-10-04T00:00:00Z",
			});
			const sourceConfigurationPath = join(native.sourceHome, "config.toml");
			const configured = parse(await readFile(sourceConfigurationPath, "utf8"));
			await writeFile(sourceConfigurationPath, stringify({ ...configured, plugins: {} }));
			expect((await native.upgrade()).outcome?.upgradedRoots).toHaveLength(1);
			await writeFile(sourceConfigurationPath, stringify(configured));
			expect(await native.snapshot()).toEqual(before);
			const binding = await native.writer();
			const repaired = await native.managedLaunch(binding);
			expect(repaired.nativePluginInstallationCount).toBe(1);
			const after = await native.snapshot();
			expect(
				requireDefinedTestFixtureValue(after.find((entry) => entry.name === "skills-example")).payloadDigest,
			).not.toBe(
				requireDefinedTestFixtureValue(before.find((entry) => entry.name === "skills-example")).payloadDigest,
			);
			expect(
				await readFile(
					join(
						native.sourceHome,
						"plugins",
						"cache",
						marketplaceName,
						"skills-example",
						"1.0.0",
						"skills",
						"example",
						"SKILL.md",
					),
					"utf8",
				),
			).toContain("新修订内容");
			expect(requireDefinedTestFixtureValue(after.find((entry) => entry.name === "hook-example")).identity).toBe(
				requireDefinedTestFixtureValue(before.find((entry) => entry.name === "hook-example")).identity,
			);
		});
	},
);
