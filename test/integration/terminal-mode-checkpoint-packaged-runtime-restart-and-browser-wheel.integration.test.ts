import { spawn } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { AgentSessionPtyHostControllerConnection } from "../../src/agent-session-pty-host/runtime-client/agent-session-pty-host-controller-connection";
import {
	type AgentSessionPtyHostRuntimeIdentity,
	listAgentSessionPtyHostGenerationSocketPaths,
} from "../../src/agent-session-pty-host/runtime-client/agent-session-pty-host-socket-path-for-runtime-identity";
import { addTaskToColumn } from "../../src/core/task-board-mutations";
import { loadWorkspaceContext, mutateWorkspaceState } from "../../src/state/workspace-state";
import type { RuntimeAppRouter } from "../../src/trpc/app-router";
import type { BrowserType, Page } from "../../web-ui/node_modules/playwright-core";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { waitForConditionWithinLoadSensitiveTwoTierDeadline } from "../utilities/load-sensitive-wall-clock-two-tier-deadline";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";
import {
	computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts,
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	sigkillChildProcessAndWaitForExit,
	waitForRuntimeServerStartupBannerOrSigkillChild,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
const runtimeIdentitiesToTerminateAfterEachTest: AgentSessionPtyHostRuntimeIdentity[] = [];
afterEach(async (test) => {
	await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
	for (const identity of runtimeIdentitiesToTerminateAfterEachTest.splice(0)) {
		for (const socketPath of listAgentSessionPtyHostGenerationSocketPaths(identity)) {
			const connection = await AgentSessionPtyHostControllerConnection.connectAsController(socketPath);
			connection.sendControlMessage({ type: "terminate_all_hosted_sessions_and_exit" });
			await connection.closeAfterFlushingPendingFrames();
			await waitForConditionWithinLoadSensitiveTwoTierDeadline(
				test,
				{
					waitedForDescription: "本用例的独立 host 完成进程组清理后退出",
					softDeadlineMsExpectedOnUncontendedHost: 8_000,
					hardDeadlineMsOnlyExplainedByRealHangOrRegression: 20_000,
				},
				() => {
					try {
						process.kill(connection.hostHello.hostProcessId, 0);
						return false;
					} catch {
						return true;
					}
				},
			);
		}
	}
	vi.unstubAllEnvs();
}, 30_000);

// 这是具有原生鼠标协议的确定性 TUI fixture，不访问真实模型或用户会话。
const TERMINAL_PROCESS_FIXTURE = `
import { writeFileSync } from 'node:fs';
const [mode, readyPath, invalidInputPath] = process.argv.slice(2);
process.stdin.setRawMode(true);
process.stdin.resume();
let page = 0;
let pendingInput = '';
const render = () => process.stdout.write('\\x1b[2J\\x1b[H会话页面 ' + page + '\\r\\ncomposer: 未修改');
if (mode === 'fullscreen') {
  process.stdout.write('\\x1b[?1049;1002;1006;2004;1004h');
  process.stdout.write('x'.repeat(3 * 1024 * 1024));
  render();
} else {
  process.stdout.write('覆盖输出\\r\\n'.repeat(300000));
  process.stdout.write(Array.from({length:120}, (_, i) => 'shell-history-' + i).join('\\r\\n'));
}
process.stdout.write('', () => writeFileSync(readyPath, 'ready'));
writeFileSync(invalidInputPath, '');
process.stdin.on('data', bytes => {
  pendingInput += bytes.toString('utf8');
  while (pendingInput) {
    const report = /^\\x1b\\[<(64|65);\\d+;\\d+M/.exec(pendingInput);
    if (report) { pendingInput = pendingInput.slice(report[0].length); page++; render(); continue; }
    const focus = /^\\x1b\\[[IO]/.exec(pendingInput);
    if (focus) { pendingInput = pendingInput.slice(focus[0].length); continue; }
    if (/^\\x1b(?:\\[(?:<(?:6[45]?(?:;\\d*){0,2})?)?)?$/.test(pendingInput)) return;
    writeFileSync(invalidInputPath, pendingInput);
    pendingInput = '';
  }
});
`;

interface BrowserTerminalProbe {
	write: (snapshot: string) => Promise<void>;
	read: () => { text: string; bufferType: string; viewportY: number; baseY: number; outbound: string[] };
}
// 根项目没有 DOM lib；只声明传入真实浏览器的回调会访问的结构。
declare const window: { terminalModeCheckpointProbe: BrowserTerminalProbe; innerHeight: number };
declare const document: {
	getElementById: (id: string) => { scrollHeight: number } | null;
	documentElement: { scrollHeight: number };
};

async function mountRealXterm(page: Page, snapshot: string, onInput: (input: string) => Promise<void>) {
	await page.exposeFunction("deliverTerminalModeCheckpointInput", onInput);
	await page.setContent(
		`<style>html,body{margin:0;overflow:hidden}#terminal{width:800px;height:450px;overflow:hidden}</style><div id="terminal"></div><textarea id="unrelated-input">未修改</textarea>`,
	);
	await page.addStyleTag({ path: resolve("web-ui/node_modules/@xterm/xterm/css/xterm.css") });
	await page.addScriptTag({ path: resolve("web-ui/node_modules/@xterm/xterm/lib/xterm.js") });
	await page.evaluate(() => {
		const browserWindow = window as unknown as {
			Terminal: new (
				options: object,
			) => {
				open: (element: object) => void;
				onData: (listener: (text: string) => void) => void;
				write: (text: string, callback: () => void) => void;
				reset: () => void;
				buffer: {
					active: {
						type: string;
						viewportY: number;
						baseY: number;
						getLine: (index: number) => { translateToString: (trim: boolean) => string } | undefined;
					};
				};
			};
			deliverTerminalModeCheckpointInput: (input: string) => Promise<void>;
		};
		const terminal = new browserWindow.Terminal({ cols: 80, rows: 24, scrollback: 20000, allowProposedApi: true });
		const container = document.getElementById("terminal");
		if (!container) throw new Error("缺少真实终端容器");
		terminal.open(container);
		const outbound: string[] = [];
		terminal.onData((text) => {
			outbound.push(text);
			void browserWindow.deliverTerminalModeCheckpointInput(text);
		});
		window.terminalModeCheckpointProbe = {
			write: (text) =>
				new Promise<void>((complete) => {
					terminal.reset();
					terminal.write(text, complete);
				}),
			read: () => ({
				text: Array.from(
					{ length: 24 },
					(_, row) =>
						terminal.buffer.active.getLine(terminal.buffer.active.viewportY + row)?.translateToString(true) ?? "",
				).join("\n"),
				bufferType: terminal.buffer.active.type,
				viewportY: terminal.buffer.active.viewportY,
				baseY: terminal.buffer.active.baseY,
				outbound,
			}),
		};
	});
	await page.evaluate((text) => window.terminalModeCheckpointProbe.write(text), snapshot);
}

function readRestoreSnapshot(origin: string, workspaceId: string, taskId: string): Promise<string> {
	return new Promise((resolveSnapshot, reject) => {
		const url = new URL("/api/terminal/control", origin.replace("http:", "ws:"));
		url.searchParams.set("workspaceId", workspaceId);
		url.searchParams.set("taskId", taskId);
		url.searchParams.set("clientId", "terminal-mode-checkpoint-browser-check");
		const socket = new WebSocket(url);
		const timeout = setTimeout(() => {
			socket.terminate();
			reject(new Error("未收到真实 runtime 恢复快照"));
		}, 15_000);
		socket.on("error", (error) => {
			clearTimeout(timeout);
			socket.terminate();
			reject(error);
		});
		socket.on("close", () => {
			clearTimeout(timeout);
			reject(new Error("真实 runtime 在发送快照前关闭连接"));
		});
		socket.on("message", (data) => {
			const message = JSON.parse(data.toString());
			if (message.type !== "restore") return;
			clearTimeout(timeout);
			socket.send(JSON.stringify({ type: "restore_complete" }));
			socket.close();
			resolveSnapshot(message.snapshot);
		});
	});
}

describe.skipIf(!process.env.KANBAN_TERMINAL_MODE_CHECKPOINT_PACKAGED_RUNTIME_CLI_PATH || process.platform === "win32")(
	"打包 runtime 重启后的模式检查点与真实浏览器滚轮",
	{
		timeout: computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts({
			runtimeColdStartCount: 2,
			testBodyTimeoutBudgetMs: 150_000,
		}),
	},
	() => {
		it("覆盖 2 MiB 后 SIGKILL runtime 保留原 PTY，全屏滚轮仍到达会话，普通 shell 仍滚历史", async (test) => {
			const fixture = createIsolatedGitTestWorkspaceFixture({
				fixtureRootDirectoryNamePrefix: "terminal-mode-checkpoint-",
			});
			const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "terminal-mode-restart" });
			await writeFile(join(repository.repositoryPath, "initial.txt"), "终端模式隔离验证\n");
			repository.commitAllRepositoryFilesAtDate({
				message: "终端模式隔离测试",
				authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
			});
			vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
			const workspaceId = (await loadWorkspaceContext(repository.repositoryPath)).workspaceId;
			await mutateWorkspaceState(repository.repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => ({
				board: addTaskToColumn(
					state.board,
					"review",
					{
						taskId: "mode-checkpoint-fullscreen",
						prompt: "隔离终端模式检查，不访问模型",
						startInPlanMode: false,
						baseRef: "main",
						worktreeMode: "inplace",
					},
					() => "mode-checkpoint-fullscreen",
				).board,
				value: null,
			}));
			vi.unstubAllEnvs();
			const reservation = createServer();
			await new Promise<void>((complete) => reservation.listen(0, "127.0.0.1", complete));
			const address = reservation.address();
			if (!address || typeof address === "string") throw new Error("无法取得隔离端口");
			const runtimePort = address.port;
			await new Promise<void>((complete) => reservation.close(() => complete()));
			const runtimeIdentity = {
				runtimeHomeDirectoryPath: join(fixture.isolatedHomeDirectoryPath, ".cline", "kanban"),
				runtimePort,
			};
			runtimeIdentitiesToTerminateAfterEachTest.push(runtimeIdentity);
			const environment = fixture.createIsolatedChildProcessEnvironment({
				PATH: `${fixture.fixtureRootDirectoryPath}:${dirname(process.execPath)}:/usr/bin:/bin`,
				SHELL: "/bin/sh",
				CODEX_HOME: join(fixture.fixtureRootDirectoryPath, "codex-home"),
				CODEX_SQLITE_HOME: join(fixture.fixtureRootDirectoryPath, "codex-sqlite-home"),
				KANBAN_RUNTIME_HOST: "127.0.0.1",
				KANBAN_RUNTIME_PORT: String(runtimePort),
				KANBAN_AGENT_SESSION_PTY_HOST_MODE: "enabled",
				KANBAN_DESKTOP: undefined,
				DO_NOT_TRACK: "1",
			});
			const wait = (condition: () => boolean | Promise<boolean>) =>
				waitForConditionWithinLoadSensitiveTwoTierDeadline(
					test,
					{
						waitedForDescription: "真实 runtime、PTY 输出或原生鼠标报告生效",
						softDeadlineMsExpectedOnUncontendedHost: 5_000,
						hardDeadlineMsOnlyExplainedByRealHangOrRegression: 30_000,
					},
					condition,
				);
			const startRuntime = async () => {
				const child = children.register(
					spawn(
						process.execPath,
						[
							resolve(process.env.KANBAN_TERMINAL_MODE_CHECKPOINT_PACKAGED_RUNTIME_CLI_PATH ?? ""),
							"--port",
							String(runtimePort),
							"--no-open",
							"--skip-shutdown-cleanup",
						],
						{
							cwd: repository.repositoryPath,
							env: environment,
							stdio: ["ignore", "pipe", "pipe"],
						},
					),
				);
				const origin = new URL((await waitForRuntimeServerStartupBannerOrSigkillChild(child)).runtimeUrl).origin;
				const client = createTRPCProxyClient<RuntimeAppRouter>({
					links: [httpBatchLink({ url: `${origin}/api/trpc`, headers: { "x-kanban-workspace-id": workspaceId } })],
				});
				return { child, client, origin };
			};
			const fixturePath = join(fixture.fixtureRootDirectoryPath, "native-terminal-mouse-protocol-fixture.mjs");
			await writeFile(fixturePath, TERMINAL_PROCESS_FIXTURE);
			const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
			const agentFixtureExecutablePath = join(fixture.fixtureRootDirectoryPath, "claude");
			const fullscreenCommand = [
				process.execPath,
				fixturePath,
				"fullscreen",
				join(fixture.fixtureRootDirectoryPath, "fullscreen-ready.txt"),
				join(fixture.fixtureRootDirectoryPath, "fullscreen-invalid-input.txt"),
			]
				.map(quote)
				.join(" ");
			await writeFile(
				agentFixtureExecutablePath,
				`#!/bin/sh\nif [ "$1" = "--version" ]; then printf '1.0.0 Claude Code\\n'; exit 0; fi\nexec ${fullscreenCommand}\n`,
			);
			await chmod(agentFixtureExecutablePath, 0o755);
			const first = await startRuntime();
			const originalPids = new Map<string, number>();
			for (const mode of ["fullscreen", "shell"] as const) {
				const taskId = `mode-checkpoint-${mode}`;
				const started =
					mode === "fullscreen"
						? await first.client.runtime.startTaskSession.mutate({
								taskId,
								agentId: "claude",
								prompt: "",
								baseRef: "main",
								worktreeMode: "inplace",
								startInPlanMode: false,
							})
						: await first.client.runtime.startShellSession.mutate({
								taskId,
								baseRef: "main",
								worktreeMode: "inplace",
							});
				expect(started.ok, started.error).toBe(true);
				if (!started.summary?.pid) throw new Error("原会话缺少 PID");
				originalPids.set(taskId, started.summary.pid);
				const readyPath = join(fixture.fixtureRootDirectoryPath, `${mode}-ready.txt`);
				const invalidInputPath = join(fixture.fixtureRootDirectoryPath, `${mode}-invalid-input.txt`);
				const input = ["exec", process.execPath, fixturePath, mode, readyPath, invalidInputPath]
					.map(quote)
					.join(" ");
				if (mode === "shell")
					expect(
						(await first.client.runtime.sendTaskSessionInput.mutate({ taskId, text: input, appendNewline: true }))
							.ok,
					).toBe(true);
				await wait(() =>
					readFile(readyPath, "utf8").then(
						(text) => text === "ready",
						() => false,
					),
				);
				await wait(async () =>
					(await readRestoreSnapshot(first.origin, workspaceId, taskId)).includes(
						mode === "fullscreen" ? "会话页面 0" : "shell-history-119",
					),
				);
			}
			await sigkillChildProcessAndWaitForExit(first.child);
			for (const pid of originalPids.values()) expect(() => process.kill(pid, 0)).not.toThrow();
			const second = await startRuntime();
			const diagnostics = await second.client.runtime.getAgentSessionPtyHostDiagnostics.query();
			for (const [taskId, pid] of originalPids)
				expect(diagnostics.runtimePtySessions).toContainEqual(
					expect.objectContaining({
						conversationSessionId: taskId,
						processId: pid,
						ownership: "independent_host",
					}),
				);
			const requireFromWebUi = createRequire(resolve("web-ui/package.json"));
			const { chromium } = requireFromWebUi("playwright-core") as { chromium: BrowserType };
			const browser = await chromium.launch({ headless: true });
			try {
				const fullscreenSnapshot = await readRestoreSnapshot(
					second.origin,
					workspaceId,
					"mode-checkpoint-fullscreen",
				);
				expect(fullscreenSnapshot).toContain("\u001b[?1049h");
				expect(fullscreenSnapshot).toContain("\u001b[?1002h");
				expect(fullscreenSnapshot).toContain("\u001b[?1006h");
				const fullscreenPage = await browser.newPage({ viewport: { width: 1000, height: 700 } });
				await mountRealXterm(fullscreenPage, fullscreenSnapshot, async (text) => {
					expect(
						(
							await second.client.runtime.sendTaskSessionInput.mutate({
								taskId: "mode-checkpoint-fullscreen",
								text,
								appendNewline: false,
							})
						).ok,
					).toBe(true);
				});
				expect((await fullscreenPage.evaluate(() => window.terminalModeCheckpointProbe.read())).bufferType).toBe(
					"alternate",
				);
				await fullscreenPage.locator(".xterm-screen").hover();
				await fullscreenPage.mouse.wheel(0, 100);
				let afterWheelSnapshot = "";
				await wait(async () => {
					afterWheelSnapshot = await readRestoreSnapshot(second.origin, workspaceId, "mode-checkpoint-fullscreen");
					return /会话页面 [1-9]/.test(afterWheelSnapshot);
				});
				await fullscreenPage.evaluate(
					(snapshot) => window.terminalModeCheckpointProbe.write(snapshot),
					afterWheelSnapshot,
				);
				const fullscreenProbe = await fullscreenPage.evaluate(() => window.terminalModeCheckpointProbe.read());
				expect(fullscreenProbe.text).toMatch(/会话页面 [1-9]/);
				expect(
					fullscreenProbe.outbound.some(
						(text) => text.startsWith("\u001b") && /^\[<65;\d+;\d+M$/.test(text.slice(1)),
					),
				).toBe(true);
				expect(fullscreenProbe.baseY).toBe(0);
				expect(await fullscreenPage.locator("#unrelated-input").inputValue()).toBe("未修改");
				expect(await readFile(join(fixture.fixtureRootDirectoryPath, "fullscreen-invalid-input.txt"), "utf8")).toBe(
					"",
				);
				expect(
					await fullscreenPage.evaluate(
						() =>
							document.documentElement.scrollHeight <= window.innerHeight &&
							document.getElementById("terminal")?.scrollHeight === 450,
					),
				).toBe(true);
				const shellPage = await browser.newPage({ viewport: { width: 1000, height: 700 } });
				await mountRealXterm(
					shellPage,
					await readRestoreSnapshot(second.origin, workspaceId, "mode-checkpoint-shell"),
					async () => {
						throw new Error("普通 shell 滚轮不应向 PTY 写入");
					},
				);
				const beforeScroll = await shellPage.evaluate(() => window.terminalModeCheckpointProbe.read());
				expect(beforeScroll.bufferType).toBe("normal");
				expect(beforeScroll.baseY).toBeGreaterThan(24);
				await shellPage.locator(".xterm-screen").hover();
				await shellPage.mouse.wheel(0, -160);
				await wait(
					async () =>
						(await shellPage.evaluate(() => window.terminalModeCheckpointProbe.read())).viewportY <
						beforeScroll.viewportY,
				);
				expect((await shellPage.evaluate(() => window.terminalModeCheckpointProbe.read())).outbound).toEqual([]);
			} finally {
				await browser.close();
			}
		});
	},
);
