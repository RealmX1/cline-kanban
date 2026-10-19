import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type WebSocketRoute } from "@playwright/test";
import { spawn } from "node-pty";

test.use({ hasTouch: true, viewport: { width: 390, height: 812 } });

test("真实 Codex：手机双 ESC 点一次进入历史预览，不请求模型、不确认回退", async ({ page }) => {
	const binary = process.env.KANBAN_NATIVE_CODEX_BINARY;
	test.skip(!binary, "设置 KANBAN_NATIVE_CODEX_BINARY 后运行本机原生 Codex 回归");
	test.setTimeout(60_000);
	const isolatedRoot = await mkdtemp(join(tmpdir(), "kanban-native-codex-rewind-"));
	const workspace = join(isolatedRoot, "workspace");
	const home = join(isolatedRoot, "home");
	const codexHome = join(home, ".codex");
	await mkdir(workspace, { recursive: true });
	const sessions = join(codexHome, "sessions", "2026", "10", "19");
	await mkdir(sessions, { recursive: true });
	let modelRequestCount = 0;
	const server = createServer((request, response) => {
		if (request.method === "POST") modelRequestCount += 1;
		response.writeHead(503, { "content-type": "application/json" });
		response.end(JSON.stringify({ error: "隔离 UI 测试禁止请求模型" }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("未取得隔离测试端口");
	const timestamp = new Date().toISOString();
	const threadId = randomUUID();
	const records: unknown[] = [];
	const add = (type: string, payload: unknown) => records.push({ timestamp, type, payload });
	add("session_meta", {
		id: threadId,
		timestamp,
		cwd: workspace,
		originator: "codex-tui",
		cli_version: "0.163.0",
		source: "cli",
		model_provider: "isolated_ui_test",
		base_instructions: { text: "隔离 UI 测试，无需请求模型" },
	});
	for (const text of ["FIRST_REWIND_TEST_PROMPT", "SECOND_REWIND_TEST_PROMPT"]) {
		const turnId = randomUUID();
		add("event_msg", { type: "task_started", turn_id: turnId, model_context_window: 128000 });
		add("turn_context", {
			turn_id: turnId,
			cwd: workspace,
			approval_policy: "never",
			sandbox_policy: { type: "read-only" },
			model: "gpt-5.4",
			effort: "low",
			summary: "none",
		});
		add("event_msg", { type: "user_message", message: text, images: [], local_images: [], text_elements: [] });
		add("response_item", { type: "message", role: "user", content: [{ type: "input_text", text }] });
		add("response_item", {
			type: "message",
			role: "assistant",
			phase: "final_answer",
			content: [{ type: "output_text", text: "COMPLETED_REWIND_TEST_REPLY" }],
		});
		add("event_msg", { type: "task_complete", turn_id: turnId, last_agent_message: "COMPLETED_REWIND_TEST_REPLY" });
	}
	const transcript = join(sessions, `rollout-2026-10-19T00-00-00-${threadId}.jsonl`);
	await writeFile(transcript, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
	const originalTranscript = await readFile(transcript, "utf8");
	const terminal = spawn(
		binary!,
		[
			"resume",
			threadId,
			"--no-daemon",
			"--no-alt-screen",
			"-C",
			workspace,
			"-c",
			'model_provider="isolated_ui_test"',
			"-c",
			'model="gpt-5.4"',
			"-c",
			'model_providers.isolated_ui_test.name="隔离 UI 测试"',
			"-c",
			`model_providers.isolated_ui_test.base_url="http://127.0.0.1:${address.port}/v1"`,
			"-c",
			'model_providers.isolated_ui_test.wire_api="responses"',
			"-c",
			"model_providers.isolated_ui_test.requires_openai_auth=false",
			"-c",
			`projects.${JSON.stringify(workspace)}.trust_level="trusted"`,
		],
		{
			name: "xterm-256color",
			cols: 44,
			rows: 30,
			cwd: workspace,
			env: {
				PATH: process.env.PATH ?? "",
				HOME: home,
				CODEX_HOME: codexHome,
				TERM: "xterm-256color",
				LANG: "en_US.UTF-8",
			},
		},
	);
	let terminalOutput = "";
	let terminalExited = false;
	const exitSubscription = terminal.onExit(() => {
		terminalExited = true;
	});
	const sockets = new Set<WebSocketRoute>();
	const inputSequences: string[] = [];
	const inputTimes: number[] = [];
	const outputSubscription = terminal.onData((output) => {
		terminalOutput += output;
		for (const socket of sockets) socket.send(output);
	});
	try {
		await page.route("**/api/**", (route) => route.abort());
		await page.routeWebSocket("**/*", (socket) => {
			const url = new URL(socket.url());
			if (url.pathname === "/api/terminal/io") {
				sockets.add(socket);
				socket.onMessage((message) => {
					inputSequences.push(String(message));
					inputTimes.push(Date.now());
					terminal.write(String(message));
				});
				socket.onClose(() => sockets.delete(socket));
			} else if (url.pathname === "/api/terminal/control") {
				socket.send(JSON.stringify({ type: "restore", cols: 44, rows: 30, snapshot: terminalOutput }));
			}
		});
		await page.route("**/isolated-native-codex-rewind", (route) =>
			route.fulfill({
				contentType: "text/html",
				body: "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body></body></html>",
			}),
		);
		await page.goto("/isolated-native-codex-rewind");
		await page.addScriptTag({
			type: "module",
			content: `import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;`,
		});
		await page.addScriptTag({
			type: "module",
			url: "/tests/mobile-focus-view-collapsible-controls-browser-harness.tsx",
		});
		const readScreen = () => page.evaluate(() => window.mobileFocusViewTerminalBrowserTest.readScreenText());
		await expect.poll(readScreen, { timeout: 20_000 }).toContain("SECOND_REWIND_TEST_PROMPT");
		await page.getByRole("button", { name: "展开下方按键栏", exact: true }).tap();
		const before = await readScreen();
		expect(before).not.toContain("Browsing");
		inputSequences.length = 0;
		inputTimes.length = 0;
		await page.getByRole("button", { name: "Open the rewind history view (double escape)", exact: true }).tap();
		await expect.poll(() => inputSequences.filter((input) => input === "\x1b")).toHaveLength(2);
		await expect.poll(readScreen).toContain("Browsing");
		const after = await readScreen();
		await writeFile(
			test.info().outputPath("native-codex-rewind-preview.json"),
			JSON.stringify({ before, after, inputSequences, inputTimes, modelRequestCount }, null, 2),
		);
		await test.info().attach("Codex 双 ESC 前后屏幕", {
			body: JSON.stringify({ before, after, inputSequences, inputTimes, modelRequestCount }, null, 2),
			contentType: "application/json",
		});
		await page.screenshot({ path: test.info().outputPath("native-codex-rewind-preview.png") });
		expect(after).toContain("rewind");
		expect(after).toContain("SECOND_REWIND_TEST_PROMPT");
		expect(inputSequences).not.toContain("\r");
		expect(modelRequestCount).toBe(0);
		expect(await readFile(transcript, "utf8")).toContain(originalTranscript.trim());
	} finally {
		await test.info().attach("Codex 隔离原生输出", { body: terminalOutput, contentType: "text/plain" });
		outputSubscription.dispose();
		if (!terminalExited) terminal.kill("SIGKILL");
		await expect.poll(() => terminalExited, { timeout: 10_000 }).toBe(true);
		exitSubscription.dispose();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(isolatedRoot, { recursive: true, force: true });
	}
});
