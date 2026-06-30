import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

const requireFromHere = createRequire(import.meta.url);

function resolveShutdownIpcHookPath(): string {
	return resolve(process.cwd(), "test/integration/shutdown-ipc-hook.cjs");
}

function resolveTsxLoaderImportSpecifier(): string {
	return pathToFileURL(requireFromHere.resolve("tsx")).href;
}

function initGitRepository(path: string): void {
	const init = spawnSync("git", ["init"], {
		cwd: path,
		stdio: "ignore",
		env: createGitTestEnv(),
	});
	if (init.status !== 0) {
		throw new Error(`Failed to initialize git repository at ${path}`);
	}
	const checkout = spawnSync("git", ["checkout", "-B", "main"], {
		cwd: path,
		stdio: "ignore",
		env: createGitTestEnv(),
	});
	if (checkout.status !== 0) {
		throw new Error(`Failed to create main branch at ${path}`);
	}
}

function runGit(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: createGitTestEnv(),
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
	}
	return result.stdout.trim();
}

function commitAll(cwd: string, message: string): string {
	runGit(cwd, ["add", "."]);
	runGit(cwd, ["commit", "-qm", message]);
	return runGit(cwd, ["rev-parse", "HEAD"]);
}

async function getAvailablePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(0, "127.0.0.1", () => {
			resolveListen();
		});
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : null;
	await new Promise<void>((resolveClose, rejectClose) => {
		server.close((error) => {
			if (error) {
				rejectClose(error);
				return;
			}
			resolveClose();
		});
	});
	if (!port) {
		throw new Error("Could not allocate a test port.");
	}
	return port;
}

async function waitForServerStart(process: ChildProcess, timeoutMs = 10_000): Promise<void> {
	await new Promise<void>((resolveStart, rejectStart) => {
		if (!process.stdout || !process.stderr) {
			rejectStart(new Error("Expected child process stdout/stderr pipes to be available."));
			return;
		}
		let settled = false;
		let stdout = "";
		let stderr = "";
		const timeoutId = setTimeout(() => {
			if (settled) {
				return;
			}
			settled = true;
			rejectStart(new Error(`Timed out waiting for server start.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
		}, timeoutMs);
		const handleOutput = (chunk: Buffer, source: "stdout" | "stderr") => {
			const text = chunk.toString();
			if (source === "stdout") {
				stdout += text;
			} else {
				stderr += text;
			}
			if (!stdout.includes("Cline Kanban running at ") || settled) {
				return;
			}
			settled = true;
			clearTimeout(timeoutId);
			resolveStart();
		};
		process.stdout.on("data", (chunk: Buffer) => {
			handleOutput(chunk, "stdout");
		});
		process.stderr.on("data", (chunk: Buffer) => {
			handleOutput(chunk, "stderr");
		});
		process.once("exit", (code, signal) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeoutId);
			rejectStart(
				new Error(
					`Server process exited before startup (code=${String(code)} signal=${String(signal)}).\nstdout:\n${stdout}\nstderr:\n${stderr}`,
				),
			);
		});
	});
}

function installBrowserOpenStub(binDir: string, logPath: string): void {
	mkdirSync(binDir, { recursive: true });
	const script = `#!/usr/bin/env sh
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
`;
	const commandNames = process.platform === "darwin" ? ["open"] : ["xdg-open"];
	for (const commandName of commandNames) {
		const scriptPath = join(binDir, commandName);
		writeFileSync(scriptPath, script, "utf8");
		chmodSync(scriptPath, 0o755);
	}
}

function readBrowserOpenLog(logPath: string): string[] {
	if (!existsSync(logPath)) {
		return [];
	}
	return readFileSync(logPath, "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

async function waitForBrowserOpenCount(logPath: string, expectedCount: number, timeoutMs = 2_000): Promise<void> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (readBrowserOpenLog(logPath).length >= expectedCount) {
			return;
		}
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 25);
		});
	}
	throw new Error(
		`Timed out waiting for browser open count ${expectedCount}. Current log: ${readBrowserOpenLog(logPath).join(", ")}`,
	);
}

async function waitForExit(process: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (process.exitCode !== null) {
		return true;
	}

	return await new Promise<boolean>((resolveExit) => {
		const handleExit = () => {
			clearTimeout(timeoutId);
			resolveExit(true);
		};
		const timeoutId = setTimeout(() => {
			process.removeListener("exit", handleExit);
			resolveExit(false);
		}, timeoutMs);
		process.once("exit", handleExit);
	});
}

async function requestGracefulShutdown(process: ChildProcess): Promise<void> {
	if (typeof process.send !== "function" || !process.connected) {
		process.kill("SIGINT");
		return;
	}

	await new Promise<void>((resolveSend) => {
		process.send?.({ type: "kanban.shutdown" }, () => {
			resolveSend();
		});
	});
}

function spawnSourceCli(
	args: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv; stdio?: ChildProcess["stdio"] },
) {
	const cliEntrypoint = resolve(process.cwd(), "src/cli.ts");
	return spawn(process.execPath, ["--import", resolveTsxLoaderImportSpecifier(), cliEntrypoint, ...args], {
		cwd: options.cwd,
		env: options.env,
		stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
	});
}

async function runCliCommandAndCollectOutput(options: {
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	timeoutMs?: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number | null; didExit: boolean }> {
	const process = spawnSourceCli(options.args, {
		cwd: options.cwd,
		env: options.env,
	});

	let stdout = "";
	let stderr = "";
	process.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	process.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});

	const didExit = await waitForExit(process, options.timeoutMs ?? 8_000);
	if (!didExit) {
		process.kill("SIGKILL");
	}

	return {
		stdout,
		stderr,
		exitCode: process.exitCode,
		didExit,
	};
}

const CLI_GUARD_TRPC_TIMEOUT_MS = 800;
const CLI_GUARD_HARD_TIMEOUT_MS = 5_000;
const CLI_GUARD_HOOK_INGEST_TIMEOUT_MS = 500;
const CLI_GUARD_MAX_RSS_KB = 512 * 1024;
const CLI_GUARD_MAX_RSS_GROWTH_KB = 256 * 1024;

function withCliGuardTimeouts(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return {
		...env,
		KANBAN_CLI_TRPC_TIMEOUT_MS: String(CLI_GUARD_TRPC_TIMEOUT_MS),
		KANBAN_CLI_HARD_TIMEOUT_MS: String(CLI_GUARD_HARD_TIMEOUT_MS),
		KANBAN_HOOK_INGEST_TIMEOUT_MS: String(CLI_GUARD_HOOK_INGEST_TIMEOUT_MS),
	};
}

async function startHangingHttpServer(): Promise<{ port: number; server: Server }> {
	const server = createServer(() => {
		// Accept connections but never complete a tRPC response.
	});
	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(0, "127.0.0.1", () => {
			resolveListen();
		});
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : null;
	if (!port) {
		server.close();
		throw new Error("Could not start hanging HTTP server.");
	}
	return { port, server };
}

async function closeHttpServer(server: Server): Promise<void> {
	await new Promise<void>((resolveClose, rejectClose) => {
		server.close((error) => {
			if (error) {
				rejectClose(error);
				return;
			}
			resolveClose();
		});
	});
}

function readProcessRssKb(pid: number): number | null {
	const result = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], {
		encoding: "utf8",
	});
	if (result.status !== 0) {
		return null;
	}
	const parsed = Number.parseInt(result.stdout.trim(), 10);
	return Number.isFinite(parsed) ? parsed : null;
}

async function bootstrapWorkspaceOnDisk(options: { projectPath: string; homeDir: string }): Promise<string> {
	const port = String(await getAvailablePort());
	const serverProcess = await startRuntimeServerForProject({
		projectPath: options.projectPath,
		homeDir: options.homeDir,
		port,
	});
	await stopRuntimeServer(serverProcess);
	return port;
}

async function waitForExitWhileTrackingRss(options: {
	process: ChildProcess;
	timeoutMs: number;
	warmupMs?: number;
	pollIntervalMs?: number;
}): Promise<{ didExit: boolean; baselineRssKb: number; maxRssKb: number }> {
	const pollIntervalMs = options.pollIntervalMs ?? 100;
	const warmupMs = options.warmupMs ?? 500;
	const startedAt = Date.now();
	let baselineRssKb: number | null = null;
	let maxRssKb = 0;

	while (Date.now() - startedAt < options.timeoutMs) {
		if (typeof options.process.pid === "number") {
			const rssKb = readProcessRssKb(options.process.pid);
			if (rssKb !== null) {
				maxRssKb = Math.max(maxRssKb, rssKb);
				if (baselineRssKb === null && Date.now() - startedAt >= warmupMs) {
					baselineRssKb = rssKb;
				}
			}
		}
		if (options.process.exitCode !== null) {
			return { didExit: true, baselineRssKb: baselineRssKb ?? maxRssKb, maxRssKb };
		}
		await new Promise<void>((resolve) => {
			setTimeout(resolve, pollIntervalMs);
		});
	}

	options.process.kill("SIGKILL");
	return { didExit: false, baselineRssKb: baselineRssKb ?? maxRssKb, maxRssKb };
}

async function startRuntimeServerForProject(options: {
	projectPath: string;
	homeDir: string;
	port: string;
}): Promise<ChildProcess> {
	const env = createGitTestEnv({
		HOME: options.homeDir,
		USERPROFILE: options.homeDir,
		KANBAN_RUNTIME_PORT: options.port,
	});
	const serverProcess = spawn(
		process.execPath,
		[
			"--require",
			resolveShutdownIpcHookPath(),
			"--import",
			resolveTsxLoaderImportSpecifier(),
			resolve(process.cwd(), "src/cli.ts"),
			"--no-open",
		],
		{
			cwd: options.projectPath,
			env,
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		},
	);
	await waitForServerStart(serverProcess);
	return serverProcess;
}

async function stopRuntimeServer(serverProcess: ChildProcess): Promise<void> {
	await requestGracefulShutdown(serverProcess);
	const stopped = await waitForExit(serverProcess, 5_000);
	if (!stopped) {
		serverProcess.kill("SIGKILL");
		await waitForExit(serverProcess, 5_000);
	}
}

describe("source task commands", () => {
	it("exits after creating a task when the runtime server is already running", { timeout: 60_000 }, async () => {
		const { path: homeDir, cleanup: cleanupHome } = createTempDir("kanban-home-task-exit-");
		const { path: projectPath, cleanup: cleanupProject } = createTempDir("kanban-project-task-exit-");

		try {
			initGitRepository(projectPath);
			writeFileSync(join(projectPath, "README.md"), "# Task Exit Test\n", "utf8");
			commitAll(projectPath, "init");

			const port = String(await getAvailablePort());
			const env = createGitTestEnv({
				HOME: homeDir,
				USERPROFILE: homeDir,
				KANBAN_RUNTIME_PORT: port,
			});

			const serverProcess = spawn(
				process.execPath,
				[
					"--require",
					resolveShutdownIpcHookPath(),
					"--import",
					resolveTsxLoaderImportSpecifier(),
					resolve(process.cwd(), "src/cli.ts"),
					"--no-open",
				],
				{
					cwd: projectPath,
					env,
					stdio: ["ignore", "pipe", "pipe", "ipc"],
				},
			);

			try {
				await waitForServerStart(serverProcess);

				const commandProcess = spawnSourceCli(
					[
						"task",
						"create",
						"--prompt",
						"Add a demo banner component to the homepage that displays a welcome message and current weather summary",
						"--project-path",
						projectPath,
					],
					{
						cwd: projectPath,
						env,
					},
				);

				let stdout = "";
				let stderr = "";
				commandProcess.stdout?.on("data", (chunk: Buffer) => {
					stdout += chunk.toString();
				});
				commandProcess.stderr?.on("data", (chunk: Buffer) => {
					stderr += chunk.toString();
				});

				const didExit = await waitForExit(commandProcess, 8_000);
				if (!didExit) {
					commandProcess.kill("SIGKILL");
				}

				expect(didExit, `task create did not exit in time.\nstdout:\n${stdout}\nstderr:\n${stderr}`).toBe(true);
				expect(commandProcess.exitCode).toBe(0);
				expect(stdout).toContain('"ok": true');
			} finally {
				await requestGracefulShutdown(serverProcess);
				const stopped = await waitForExit(serverProcess, 5_000);
				if (!stopped) {
					serverProcess.kill("SIGKILL");
					await waitForExit(serverProcess, 5_000);
				}
			}
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("opens only for launch invocations", { timeout: 60_000 }, async () => {
		if (process.platform === "win32") {
			return;
		}

		const { path: homeDir, cleanup: cleanupHome } = createTempDir("kanban-home-root-launch-open-");
		const { path: projectPath, cleanup: cleanupProject } = createTempDir("kanban-project-root-launch-open-");

		try {
			initGitRepository(projectPath);
			writeFileSync(join(projectPath, "README.md"), "# Root Launch Browser Open Test\n", "utf8");
			commitAll(projectPath, "init");

			const port = String(await getAvailablePort());
			const browserStubBinDir = join(homeDir, "browser-bin");
			const browserOpenLogPath = join(homeDir, "browser-open.log");
			installBrowserOpenStub(browserStubBinDir, browserOpenLogPath);
			const env = createGitTestEnv({
				HOME: homeDir,
				USERPROFILE: homeDir,
				KANBAN_RUNTIME_PORT: port,
				PATH: `${browserStubBinDir}:${process.env.PATH ?? ""}`,
			});

			const serverProcess = spawn(
				process.execPath,
				[
					"--require",
					resolveShutdownIpcHookPath(),
					"--import",
					resolveTsxLoaderImportSpecifier(),
					resolve(process.cwd(), "src/cli.ts"),
					"--no-open",
				],
				{
					cwd: projectPath,
					env,
					stdio: ["ignore", "pipe", "pipe", "ipc"],
				},
			);

			try {
				await waitForServerStart(serverProcess);

				for (const [args, expectedOpenCount] of [
					[[], 1],
					[["task", "list", "--project-path", projectPath], 1],
					[["--agent", "codex"], 2],
					[["--port", port], 3],
				] as const) {
					const result = await runCliCommandAndCollectOutput({
						args: [...args],
						cwd: projectPath,
						env,
					});
					expect(result.didExit).toBe(true);
					expect(result.exitCode).toBe(0);
					await waitForBrowserOpenCount(browserOpenLogPath, expectedOpenCount);
					expect(readBrowserOpenLog(browserOpenLogPath)).toHaveLength(expectedOpenCount);
				}
			} finally {
				await requestGracefulShutdown(serverProcess);
				const stopped = await waitForExit(serverProcess, 5_000);
				if (!stopped) {
					serverProcess.kill("SIGKILL");
					await waitForExit(serverProcess, 5_000);
				}
			}
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("supports done and trash aliases when moving and deleting tasks", { timeout: 60_000 }, async () => {
		const { path: homeDir, cleanup: cleanupHome } = createTempDir("kanban-home-task-done-delete-");
		const { path: projectPath, cleanup: cleanupProject } = createTempDir("kanban-project-task-done-delete-");

		try {
			initGitRepository(projectPath);
			writeFileSync(join(projectPath, "README.md"), "# Task Done Delete Test\n", "utf8");
			commitAll(projectPath, "init");

			const port = String(await getAvailablePort());
			const env = createGitTestEnv({
				HOME: homeDir,
				USERPROFILE: homeDir,
				KANBAN_RUNTIME_PORT: port,
			});

			const serverProcess = spawn(
				process.execPath,
				[
					"--require",
					resolveShutdownIpcHookPath(),
					"--import",
					resolveTsxLoaderImportSpecifier(),
					resolve(process.cwd(), "src/cli.ts"),
					"--no-open",
				],
				{
					cwd: projectPath,
					env,
					stdio: ["ignore", "pipe", "pipe", "ipc"],
				},
			);

			try {
				await waitForServerStart(serverProcess);

				const taskIds: string[] = [];
				for (const prompt of [
					"Create a temporary task for done and delete",
					"Create another temporary task for done and delete",
					"Create a legacy trash command task for done and delete",
				]) {
					const created = await runCliCommandAndCollectOutput({
						args: ["task", "create", "--prompt", prompt, "--project-path", projectPath],
						cwd: projectPath,
						env,
					});
					expect(
						created.didExit,
						`task create did not exit in time.\nstdout:\n${created.stdout}\nstderr:\n${created.stderr}`,
					).toBe(true);
					expect(created.exitCode).toBe(0);

					const createdPayload = JSON.parse(created.stdout) as {
						ok?: boolean;
						task?: { id?: string };
					};
					expect(createdPayload.ok).toBe(true);
					expect(typeof createdPayload.task?.id).toBe("string");
					if (createdPayload.task?.id) {
						taskIds.push(createdPayload.task.id);
					}
				}
				expect(taskIds).toHaveLength(3);

				const movedByDoneAlias = await runCliCommandAndCollectOutput({
					args: ["task", "done", "--task-id", taskIds[0] ?? "", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(
					movedByDoneAlias.didExit,
					`task done did not exit in time.\nstdout:\n${movedByDoneAlias.stdout}\nstderr:\n${movedByDoneAlias.stderr}`,
				).toBe(true);
				expect(movedByDoneAlias.exitCode).toBe(0);
				expect(movedByDoneAlias.stdout).toContain('"ok": true');

				const movedByTrashCommand = await runCliCommandAndCollectOutput({
					args: ["task", "trash", "--column", "backlog", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(
					movedByTrashCommand.didExit,
					`task trash did not exit in time.\nstdout:\n${movedByTrashCommand.stdout}\nstderr:\n${movedByTrashCommand.stderr}`,
				).toBe(true);
				expect(movedByTrashCommand.exitCode).toBe(0);
				expect(movedByTrashCommand.stdout).toContain('"ok": true');
				expect(movedByTrashCommand.stdout).toContain('"column": "backlog"');
				expect(movedByTrashCommand.stdout).toContain('"count": 2');

				const listedDoneBeforeDelete = await runCliCommandAndCollectOutput({
					args: ["task", "list", "--column", "done", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(
					listedDoneBeforeDelete.didExit,
					`task list --column done did not exit in time.\nstdout:\n${listedDoneBeforeDelete.stdout}\nstderr:\n${listedDoneBeforeDelete.stderr}`,
				).toBe(true);
				expect(listedDoneBeforeDelete.exitCode).toBe(0);
				expect(listedDoneBeforeDelete.stdout).toContain('"count": 3');

				const listedTrashBeforeDelete = await runCliCommandAndCollectOutput({
					args: ["task", "list", "--column", "trash", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(
					listedTrashBeforeDelete.didExit,
					`task list --column trash did not exit in time.\nstdout:\n${listedTrashBeforeDelete.stdout}\nstderr:\n${listedTrashBeforeDelete.stderr}`,
				).toBe(true);
				expect(listedTrashBeforeDelete.exitCode).toBe(0);
				expect(listedTrashBeforeDelete.stdout).toContain('"count": 3');

				const deletedDone = await runCliCommandAndCollectOutput({
					args: ["task", "delete", "--column", "done", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(
					deletedDone.didExit,
					`task delete --column done did not exit in time.\nstdout:\n${deletedDone.stdout}\nstderr:\n${deletedDone.stderr}`,
				).toBe(true);
				expect(deletedDone.exitCode).toBe(0);
				expect(deletedDone.stdout).toContain('"ok": true');
				expect(deletedDone.stdout).toContain('"column": "trash"');
				expect(deletedDone.stdout).toContain('"count": 3');

				const listedTrash = await runCliCommandAndCollectOutput({
					args: ["task", "list", "--column", "trash", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(
					listedTrash.didExit,
					`task list --column trash did not exit in time.\nstdout:\n${listedTrash.stdout}\nstderr:\n${listedTrash.stderr}`,
				).toBe(true);
				expect(listedTrash.exitCode).toBe(0);
				expect(listedTrash.stdout).toContain('"count": 0');
			} finally {
				await requestGracefulShutdown(serverProcess);
				const stopped = await waitForExit(serverProcess, 5_000);
				if (!stopped) {
					serverProcess.kill("SIGKILL");
					await waitForExit(serverProcess, 5_000);
				}
			}
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("treats create-time reasoning inherit as no explicit override", { timeout: 60_000 }, async () => {
		const { path: homeDir, cleanup: cleanupHome } = createTempDir("kanban-home-task-cline-reasoning-");
		const { path: projectPath, cleanup: cleanupProject } = createTempDir("kanban-project-task-cline-reasoning-");

		try {
			initGitRepository(projectPath);
			writeFileSync(join(projectPath, "README.md"), "# Task Cline Reasoning Test\n", "utf8");
			commitAll(projectPath, "init");

			const port = String(await getAvailablePort());
			const env = createGitTestEnv({
				HOME: homeDir,
				USERPROFILE: homeDir,
				KANBAN_RUNTIME_PORT: port,
			});

			const serverProcess = spawn(
				process.execPath,
				[
					"--require",
					resolveShutdownIpcHookPath(),
					"--import",
					resolveTsxLoaderImportSpecifier(),
					resolve(process.cwd(), "src/cli.ts"),
					"--no-open",
				],
				{
					cwd: projectPath,
					env,
					stdio: ["ignore", "pipe", "pipe", "ipc"],
				},
			);

			try {
				await waitForServerStart(serverProcess);

				const inheritedCreate = await runCliCommandAndCollectOutput({
					args: [
						"task",
						"create",
						"--prompt",
						"Create a task that inherits workspace reasoning",
						"--project-path",
						projectPath,
						"--cline-reasoning-effort",
						"inherit",
					],
					cwd: projectPath,
					env,
				});
				expect(inheritedCreate.didExit).toBe(true);
				expect(inheritedCreate.exitCode).toBe(0);

				const inheritedPayload = JSON.parse(inheritedCreate.stdout) as {
					ok?: boolean;
					task?: { clineSettings?: Record<string, unknown> };
				};
				expect(inheritedPayload.ok).toBe(true);
				expect(inheritedPayload.task?.clineSettings).toBeUndefined();

				const defaultCreate = await runCliCommandAndCollectOutput({
					args: [
						"task",
						"create",
						"--prompt",
						"Create a task that uses model default reasoning",
						"--project-path",
						projectPath,
						"--cline-reasoning-effort",
						"default",
					],
					cwd: projectPath,
					env,
				});
				expect(defaultCreate.didExit).toBe(true);
				expect(defaultCreate.exitCode).toBe(0);

				const defaultPayload = JSON.parse(defaultCreate.stdout) as {
					ok?: boolean;
					task?: { clineSettings?: Record<string, unknown> };
				};
				expect(defaultPayload.ok).toBe(true);
				expect(defaultPayload.task?.clineSettings).toEqual({});
			} finally {
				await requestGracefulShutdown(serverProcess);
				const stopped = await waitForExit(serverProcess, 5_000);
				if (!stopped) {
					serverProcess.kill("SIGKILL");
					await waitForExit(serverProcess, 5_000);
				}
			}
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});
});

describe("CLI subprocess exit guarantees", () => {
	it("exits after task list without --column on a multi-task workspace", { timeout: 120_000 }, async () => {
		const { path: homeDir, cleanup: cleanupHome } = createTempDir("kanban-home-cli-list-all-");
		const { path: projectPath, cleanup: cleanupProject } = createTempDir("kanban-project-cli-list-all-");

		try {
			initGitRepository(projectPath);
			writeFileSync(join(projectPath, "README.md"), "# CLI List All Tasks Test\n", "utf8");
			commitAll(projectPath, "init");

			const port = String(await getAvailablePort());
			const env = createGitTestEnv({
				HOME: homeDir,
				USERPROFILE: homeDir,
				KANBAN_RUNTIME_PORT: port,
			});
			const serverProcess = await startRuntimeServerForProject({
				projectPath,
				homeDir,
				port,
			});

			try {
				for (let index = 0; index < 12; index += 1) {
					const created = await runCliCommandAndCollectOutput({
						args: [
							"task",
							"create",
							"--prompt",
							`Create CLI list-all fixture task ${index + 1}`,
							"--project-path",
							projectPath,
						],
						cwd: projectPath,
						env,
					});
					expect(created.didExit, `task create ${index + 1} did not exit in time`).toBe(true);
					expect(created.exitCode).toBe(0);
				}

				const listed = await runCliCommandAndCollectOutput({
					args: ["task", "list", "--project-path", projectPath],
					cwd: projectPath,
					env,
					timeoutMs: 15_000,
				});
				expect(
					listed.didExit,
					`task list without --column did not exit in time.\nstdout:\n${listed.stdout}\nstderr:\n${listed.stderr}`,
				).toBe(true);
				expect(listed.exitCode).toBe(0);

				const payload = JSON.parse(listed.stdout) as { ok?: boolean; count?: number; column?: string | null };
				expect(payload.ok).toBe(true);
				expect(payload.column).toBeNull();
				expect(payload.count).toBe(12);
			} finally {
				await stopRuntimeServer(serverProcess);
			}
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("exits when the runtime server is unreachable", { timeout: 30_000 }, async () => {
		const { path: homeDir, cleanup: cleanupHome } = createTempDir("kanban-home-cli-unreachable-");
		const { path: projectPath, cleanup: cleanupProject } = createTempDir("kanban-project-cli-unreachable-");

		try {
			initGitRepository(projectPath);
			writeFileSync(join(projectPath, "README.md"), "# CLI Unreachable Runtime Test\n", "utf8");
			commitAll(projectPath, "init");

			const deadPort = String(await getAvailablePort());
			const env = withCliGuardTimeouts(
				createGitTestEnv({
					HOME: homeDir,
					USERPROFILE: homeDir,
					KANBAN_RUNTIME_PORT: deadPort,
				}),
			);

			const result = await runCliCommandAndCollectOutput({
				args: ["task", "list", "--project-path", projectPath],
				cwd: projectPath,
				env,
				timeoutMs: CLI_GUARD_HARD_TIMEOUT_MS + 2_000,
			});

			expect(
				result.didExit,
				`task list against unreachable runtime did not exit.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
			).toBe(true);
			expect(result.exitCode).toBe(1);
			expect(result.stdout).toContain('"ok": false');
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("exits when the runtime hangs instead of responding to tRPC", { timeout: 30_000 }, async () => {
		const { path: homeDir, cleanup: cleanupHome } = createTempDir("kanban-home-cli-hanging-");
		const { path: projectPath, cleanup: cleanupProject } = createTempDir("kanban-project-cli-hanging-");

		let hangingServer: Server | null = null;
		try {
			initGitRepository(projectPath);
			writeFileSync(join(projectPath, "README.md"), "# CLI Hanging Runtime Test\n", "utf8");
			commitAll(projectPath, "init");

			const started = await startHangingHttpServer();
			hangingServer = started.server;
			const env = withCliGuardTimeouts(
				createGitTestEnv({
					HOME: homeDir,
					USERPROFILE: homeDir,
					KANBAN_RUNTIME_PORT: String(started.port),
				}),
			);

			const result = await runCliCommandAndCollectOutput({
				args: ["task", "list", "--project-path", projectPath],
				cwd: projectPath,
				env,
				timeoutMs: CLI_GUARD_HARD_TIMEOUT_MS + 2_000,
			});

			expect(
				result.didExit,
				`task list against hanging runtime did not exit.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
			).toBe(true);
			expect(result.exitCode).toBe(1);
			expect(result.stdout).toContain('"ok": false');
		} finally {
			if (hangingServer) {
				await closeHttpServer(hangingServer);
			}
			cleanupProject();
			cleanupHome();
		}
	});

	it(
		"exits with code 1 (not 124) when tRPC times out under production-like timeout margin",
		{ timeout: 30_000 },
		async () => {
			const { path: homeDir, cleanup: cleanupHome } = createTempDir("kanban-home-cli-trpc-margin-");
			const { path: projectPath, cleanup: cleanupProject } = createTempDir("kanban-project-cli-trpc-margin-");

			let hangingServer: Server | null = null;
			try {
				initGitRepository(projectPath);
				writeFileSync(join(projectPath, "README.md"), "# CLI TRPC Margin Test\n", "utf8");
				commitAll(projectPath, "init");
				await bootstrapWorkspaceOnDisk({ projectPath, homeDir });

				const started = await startHangingHttpServer();
				hangingServer = started.server;
				const env = createGitTestEnv({
					HOME: homeDir,
					USERPROFILE: homeDir,
					KANBAN_RUNTIME_PORT: String(started.port),
					KANBAN_CLI_TRPC_TIMEOUT_MS: "2000",
					KANBAN_CLI_HARD_TIMEOUT_MS: "7000",
				});

				const result = await runCliCommandAndCollectOutput({
					args: ["task", "list", "--project-path", projectPath],
					cwd: projectPath,
					env,
					timeoutMs: 10_000,
				});

				expect(
					result.didExit,
					`task list did not exit after tRPC timeout.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
				).toBe(true);
				expect(result.exitCode).toBe(1);
				expect(result.stdout).toContain('"ok": false');
			} finally {
				if (hangingServer) {
					await closeHttpServer(hangingServer);
				}
				cleanupProject();
				cleanupHome();
			}
		},
	);

	it("enforces the CLI hard timeout with exit code 124", { timeout: 30_000 }, async () => {
		const { path: homeDir, cleanup: cleanupHome } = createTempDir("kanban-home-cli-hard-timeout-");
		const { path: projectPath, cleanup: cleanupProject } = createTempDir("kanban-project-cli-hard-timeout-");

		let hangingServer: Server | null = null;
		try {
			initGitRepository(projectPath);
			writeFileSync(join(projectPath, "README.md"), "# CLI Hard Timeout Test\n", "utf8");
			commitAll(projectPath, "init");
			await bootstrapWorkspaceOnDisk({ projectPath, homeDir });

			const started = await startHangingHttpServer();
			hangingServer = started.server;
			const env = createGitTestEnv({
				HOME: homeDir,
				USERPROFILE: homeDir,
				KANBAN_RUNTIME_PORT: String(started.port),
				KANBAN_CLI_HARD_TIMEOUT_MS: "1500",
				KANBAN_CLI_TRPC_TIMEOUT_MS: "60000",
			});

			const result = await runCliCommandAndCollectOutput({
				args: ["task", "list", "--project-path", projectPath],
				cwd: projectPath,
				env,
				timeoutMs: 5_000,
			});

			expect(
				result.didExit,
				`task list did not hit hard timeout.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
			).toBe(true);
			expect(result.exitCode).toBe(124);
			expect(result.stderr).toContain("command timed out after 1500ms");
		} finally {
			if (hangingServer) {
				await closeHttpServer(hangingServer);
			}
			cleanupProject();
			cleanupHome();
		}
	});

	it("does not grow RSS while waiting for a hanging runtime response", { timeout: 30_000 }, async () => {
		const { path: homeDir, cleanup: cleanupHome } = createTempDir("kanban-home-cli-rss-");
		const { path: projectPath, cleanup: cleanupProject } = createTempDir("kanban-project-cli-rss-");

		let hangingServer: Server | null = null;
		try {
			initGitRepository(projectPath);
			writeFileSync(join(projectPath, "README.md"), "# CLI RSS Guard Test\n", "utf8");
			commitAll(projectPath, "init");
			await bootstrapWorkspaceOnDisk({ projectPath, homeDir });

			const started = await startHangingHttpServer();
			hangingServer = started.server;
			const env = withCliGuardTimeouts(
				createGitTestEnv({
					HOME: homeDir,
					USERPROFILE: homeDir,
					KANBAN_RUNTIME_PORT: String(started.port),
				}),
			);

			const commandProcess = spawnSourceCli(["task", "list", "--project-path", projectPath], {
				cwd: projectPath,
				env,
			});
			const rssResult = await waitForExitWhileTrackingRss({
				process: commandProcess,
				timeoutMs: CLI_GUARD_HARD_TIMEOUT_MS + 2_000,
			});

			expect(
				rssResult.didExit,
				`task list against hanging runtime did not exit (baseline=${rssResult.baselineRssKb}kb max=${rssResult.maxRssKb}kb).`,
			).toBe(true);
			expect(rssResult.maxRssKb).toBeLessThan(CLI_GUARD_MAX_RSS_KB);
			expect(rssResult.maxRssKb).toBeLessThanOrEqual(rssResult.baselineRssKb + CLI_GUARD_MAX_RSS_GROWTH_KB);
			expect(commandProcess.exitCode).toBe(1);
		} finally {
			if (hangingServer) {
				await closeHttpServer(hangingServer);
			}
			cleanupProject();
			cleanupHome();
		}
	});

	it("exits hooks ingest when the runtime is unreachable", { timeout: 30_000 }, async () => {
		const { path: homeDir, cleanup: cleanupHome } = createTempDir("kanban-home-cli-hooks-exit-");
		const { path: projectPath, cleanup: cleanupProject } = createTempDir("kanban-project-cli-hooks-exit-");

		try {
			initGitRepository(projectPath);
			writeFileSync(join(projectPath, "README.md"), "# CLI Hooks Exit Test\n", "utf8");
			commitAll(projectPath, "init");

			const deadPort = String(await getAvailablePort());
			const env = withCliGuardTimeouts(
				createGitTestEnv({
					HOME: homeDir,
					USERPROFILE: homeDir,
					KANBAN_RUNTIME_PORT: deadPort,
					KANBAN_HOOK_TASK_ID: "task-hooks-exit",
					KANBAN_HOOK_WORKSPACE_ID: "workspace-hooks-exit",
				}),
			);

			const result = await runCliCommandAndCollectOutput({
				args: ["hooks", "ingest", "--event", "activity", "--source", "claude"],
				cwd: projectPath,
				env,
				timeoutMs: CLI_GUARD_HARD_TIMEOUT_MS + 2_000,
			});

			expect(
				result.didExit,
				`hooks ingest against unreachable runtime did not exit.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
			).toBe(true);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("kanban hooks ingest:");
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});
});
