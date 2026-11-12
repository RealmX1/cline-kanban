import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { createTRPCProxyClient, httpLink, type TRPCClient } from "@trpc/client";
import type { RuntimeAppRouter } from "../../src/trpc/app-router";
import type { BrowserType } from "../../web-ui/node_modules/playwright-core";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import {
	type createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForRuntimeServerStartupBannerOrSigkillChild,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

export async function createTaskEditorPackagedRuntimeBrowserTestFixture(
	packagedCliPath: string,
	children: ReturnType<typeof createSpawnedChildProcessRegistrySigkilledAfterEachTest>,
) {
	const fixture = createIsolatedGitTestWorkspaceFixture();
	const evidenceDirectory =
		process.env.KANBAN_TASK_EDITOR_CREATION_BROWSER_EVIDENCE_DIRECTORY ??
		join(fixture.fixtureRootDirectoryPath, "browser-evidence");
	mkdirSync(evidenceDirectory, { recursive: true });
	const socket = createServer();
	await new Promise<void>((done) => socket.listen(0, "127.0.0.1", done));
	const address = socket.address();
	if (!address || typeof address === "string") throw new Error("隔离端口分配失败");
	const port = address.port;
	await new Promise<void>((done) => socket.close(() => done()));
	if (port === 3484) throw new Error("测试不能使用真实运行实例端口");
	const environment = fixture.createIsolatedChildProcessEnvironment();
	for (const key of Object.keys(environment))
		if (/^(KANBAN_|ANTHROPIC_|OPENAI_|CLAUDE_|CODEX_|CURSOR_|GEMINI_|GOOGLE_|KIMI_)/u.test(key))
			delete environment[key];
	const isolatedCodexHome = join(fixture.isolatedHomeDirectoryPath, "isolated-codex-configuration");
	mkdirSync(isolatedCodexHome, { recursive: true });
	// 默认设置可读，但隔离 PATH 不提供真实 Agent 可执行文件。
	writeFileSync(join(isolatedCodexHome, "config.toml"), 'model = "isolated-non-runnable-codex-model"\n');
	Object.assign(environment, {
		PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
		KANBAN_RUNTIME_PORT: String(port),
		CODEX_HOME: isolatedCodexHome,
		CODEX_SQLITE_HOME: join(fixture.isolatedHomeDirectoryPath, "isolated-codex-storage"),
	});
	const sourcePath = resolve(import.meta.dirname, "../..");
	const origin = `http://127.0.0.1:${port}`;
	let runtimeOutput = "";
	return {
		fixture,
		evidenceDirectory,
		environment,
		origin,
		async startRuntime(repositoryPath: string) {
			const runtime = children.register(
				spawn(
					process.execPath,
					[
						"--require",
						join(sourcePath, "test/integration/shutdown-ipc-hook.cjs"),
						packagedCliPath,
						"--port",
						String(port),
						"--no-open",
						"--no-passcode",
					],
					{ cwd: repositoryPath, env: environment, stdio: ["ignore", "pipe", "pipe", "ipc"] },
				),
			);
			runtime.stdout?.on("data", (chunk) => {
				runtimeOutput += String(chunk);
			});
			runtime.stderr?.on("data", (chunk) => {
				runtimeOutput += String(chunk);
			});
			await waitForRuntimeServerStartupBannerOrSigkillChild(runtime);
			return runtime;
		},
		client: (workspaceId?: string): TRPCClient<RuntimeAppRouter> =>
			createTRPCProxyClient<RuntimeAppRouter>({
				links: [
					httpLink({
						url: `${origin}/api/trpc`,
						headers: workspaceId ? { "x-kanban-workspace-id": workspaceId } : {},
					}),
				],
			}),
		async launchBrowser() {
			const { chromium } = createRequire(join(sourcePath, "web-ui/package.json"))("playwright-core") as {
				chromium: BrowserType;
			};
			return await chromium.launch({ headless: true });
		},
		writeRuntimeOutput: () => writeFileSync(join(evidenceDirectory, "isolated-runtime.log"), runtimeOutput),
	};
}
