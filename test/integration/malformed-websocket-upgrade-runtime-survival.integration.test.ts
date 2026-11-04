import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import {
	computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts,
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	hasChildProcessExited,
	waitForRuntimeServerStartupBannerOrSigkillChild,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const requireFromThisTest = createRequire(import.meta.url);
const runtimeChildProcesses = createSpawnedChildProcessRegistrySigkilledAfterEachTest();

afterEach(async () => {
	await runtimeChildProcesses.sigkillEveryStillRunningChildProcessAndWaitForExit();
});

describe(
	"非法 WebSocket 升级路径的运行时隔离",
	{
		timeout: computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts({
			runtimeColdStartCount: 1,
			testBodyTimeoutBudgetMs: 90_000,
		}),
	},
	() => {
		it("非法百分号编码只拒绝连接，真实运行时随后仍响应 API", async () => {
			const fixture = createIsolatedGitTestWorkspaceFixture();
			const packagedRuntimeCliPath = process.env.KANBAN_MALFORMED_WEBSOCKET_UPGRADE_PACKAGED_RUNTIME_CLI_PATH;
			const runtimeEntrypointArguments = packagedRuntimeCliPath
				? [resolve(packagedRuntimeCliPath)]
				: ["--import", pathToFileURL(requireFromThisTest.resolve("tsx")).href, resolve("src/cli.ts")];
			const repository = fixture.createNonBareRepository({
				repositoryDirectoryName: "malformed-upgrade-isolated-project",
			});
			const runtimeProcess = runtimeChildProcesses.register(
				spawn(
					process.execPath,
					[
						"--require",
						resolve("test/integration/shutdown-ipc-hook.cjs"),
						...runtimeEntrypointArguments,
						"--port",
						"auto",
						"--no-open",
						"--no-passcode",
					],
					{
						cwd: repository.repositoryPath,
						env: fixture.createIsolatedChildProcessEnvironment({
							CODEX_HOME: resolve(fixture.isolatedHomeDirectoryPath, ".codex"),
							CODEX_SQLITE_HOME: resolve(fixture.isolatedHomeDirectoryPath, ".codex"),
						}),
						stdio: ["ignore", "pipe", "pipe", "ipc"],
					},
				),
			);
			const { runtimeUrl } = await waitForRuntimeServerStartupBannerOrSigkillChild(runtimeProcess);
			const origin = new URL(runtimeUrl).origin;
			const endpoint = new URL(origin);
			for (const malformedPath of ["/api/runtime/%", "/api/runtime/%E0%A4%A", "/api/terminal/%FF"]) {
				const socket = connect({ host: endpoint.hostname, port: Number(endpoint.port) });
				socket.on("error", () => {});
				socket.setTimeout(10_000, () => socket.destroy(new Error("非法升级连接未收口")));
				try {
					await once(socket, "connect");
					const disconnected = once(socket, "close");
					socket.write(
						`GET ${malformedPath} HTTP/1.1\r\nHost: ${endpoint.host}\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
					);
					await disconnected;
				} finally {
					socket.destroy();
				}
				const response = await fetch(`${origin}/api/trpc/projects.list`, {
					signal: AbortSignal.timeout(15_000),
				});
				expect(response.status).toBe(200);
				expect(hasChildProcessExited(runtimeProcess)).toBe(false);
			}
		});
	},
);
