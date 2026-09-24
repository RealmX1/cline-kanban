// 显式 opt-in：需要本机 Codex，使用隔离 HOME、空白配置及阻断 hook，绝不请求真实模型。
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { spawn as spawnPty } from "node-pty";
import { expect, it } from "vitest";
import type { RuntimeTaskSessionSummary, RuntimeWorkspaceStateResponse } from "../../src/core/api-contract";
import { quoteShellArg } from "../../src/core/shell";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

it.skipIf(!process.env.KANBAN_NATIVE_IDENTITY_CODEX_BINARY)(
	"真实 Codex TUI 经打包 CLI 保存主会话与两类侧问身份，强杀运行时后仍存在",
	async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "native-identity-probe" });
		const cliPath = resolve("dist/cli.js");
		const nativeBinary = process.env.KANBAN_NATIVE_IDENTITY_CODEX_BINARY ?? "codex";
		const portProbe = createServer();
		portProbe.listen(0, "127.0.0.1");
		await once(portProbe, "listening");
		const address = portProbe.address();
		if (!address || typeof address === "string") throw new Error("Expected TCP port");
		const port = address.port;
		await new Promise<void>((resolveClose) => portProbe.close(() => resolveClose()));
		const origin = `http://127.0.0.1:${port}`;
		const environment = fixture.createIsolatedChildProcessEnvironment({ KANBAN_RUNTIME_PORT: String(port) });
		for (const name of Object.keys(environment)) {
			if (/^(KANBAN_HOOK_|OPENAI_|RVF_|AGENT_CONVERSATION_EXPLORATION_|CODEX_)/u.test(name))
				delete environment[name];
		}
		let server: ChildProcess | null = null;
		let serverOutput = "";
		async function startServer() {
			server = spawn(process.execPath, [cliPath, "--no-open", "--port", String(port)], {
				cwd: repository.repositoryPath,
				env: environment,
				stdio: ["ignore", "pipe", "pipe"],
			});
			server.stdout?.on("data", (chunk) => {
				serverOutput += String(chunk);
			});
			server.stderr?.on("data", (chunk) => {
				serverOutput += String(chunk);
			});
			await expect
				.poll(
					async () => {
						if (server?.exitCode != null) throw new Error(serverOutput);
						return await fetch(`${origin}/api/trpc/runtime.getState`)
							.then((response) => response.status !== 503)
							.catch(() => false);
					},
					{ timeout: 15000 },
				)
				.toBe(true);
		}
		async function killServer() {
			if (server && server.exitCode === null && server.signalCode === null) {
				const exited = once(server, "exit");
				server.kill("SIGKILL");
				await exited;
			}
		}
		async function rpc<T>(procedure: string, workspaceId: string, input?: unknown): Promise<T> {
			const response = await fetch(`${origin}/api/trpc/${procedure}`, {
				method: input === undefined ? "GET" : "POST",
				headers: { "x-kanban-workspace-id": workspaceId, "Content-Type": "application/json" },
				body: input === undefined ? undefined : JSON.stringify(input),
			});
			const result = (await response.json()) as { result?: { data: T }; error?: unknown };
			if (!result.result) throw new Error(JSON.stringify(result));
			return result.result.data;
		}
		const codexHome = join(fixture.fixtureRootDirectoryPath, "codex-home");
		mkdirSync(codexHome);
		writeFileSync(
			join(codexHome, "config.toml"),
			`[projects.${JSON.stringify(repository.repositoryPath)}]\ntrust_level = "trusted"\n[tui]\nscreen_reader_detection_done = true\n`,
		);
		const hookScript = join(fixture.fixtureRootDirectoryPath, "capture-native-hook.cjs");
		const hookJournal = join(fixture.fixtureRootDirectoryPath, "native-hook-payloads.jsonl");
		writeFileSync(hookJournal, "");
		writeFileSync(
			hookScript,
			`const fs = require('node:fs'); const cp = require('node:child_process');
const payload = fs.readFileSync(0, 'utf8');
const delivered = cp.spawnSync(process.execPath, [${JSON.stringify(cliPath)}, 'hooks', 'codex-hook', '--event', 'to_in_progress', '--source', 'codex'], {input: payload, encoding:'utf8', timeout:10000});
fs.appendFileSync(${JSON.stringify(hookJournal)}, JSON.stringify({payload:JSON.parse(payload), exitCode:delivered.status, stderr:delivered.stderr})+'\\n');
process.stdout.write(JSON.stringify({continue:false, stopReason:'隔离身份测试，不请求模型'}));
`,
		);
		const command = [process.execPath, hookScript].map(quoteShellArg).join(" ");
		const hash = createHash("sha256")
			.update(
				JSON.stringify({
					event_name: "user_prompt_submit",
					hooks: [{ async: false, command, timeout: 15, type: "command" }],
				}),
			)
			.digest("hex");
		const configuration = [
			"features.hooks=true",
			`hooks.UserPromptSubmit=[{hooks=[{type="command",command=${JSON.stringify(command)},timeout=15}]}]`,
			`hooks.state={"/<session-flags>/config.toml:user_prompt_submit:0:0"={trusted_hash="sha256:${hash}"}}`,
			'model_provider="isolated_probe"',
			'model_providers.isolated_probe={name="isolated_probe",base_url="http://127.0.0.1:9/v1",wire_api="responses",requires_openai_auth=false,request_max_retries=0,stream_max_retries=0}',
		];
		const keys = ["native-main", "task-conversation-session-native-fork", "task-conversation-session-native-scratch"];
		const nativeIds: string[] = [];
		try {
			await startServer();
			const projects = await rpc<{ projects: Array<{ id: string; workspaceId?: string }> }>("projects.list", "");
			const workspaceId = projects.projects[0]?.workspaceId ?? projects.projects[0]?.id;
			if (!workspaceId) throw new Error(`Expected indexed workspace: ${JSON.stringify(projects)} ${serverOutput}`);
			const initial = await rpc<RuntimeWorkspaceStateResponse>("workspace.getState", workspaceId);
			const sessions = Object.fromEntries(
				keys.map((taskId, index): [string, RuntimeTaskSessionSummary] => [
					taskId,
					{
						taskId,
						state: "idle",
						agentId: "codex",
						workspacePath: repository.repositoryPath,
						pid: null,
						startedAt: null,
						updatedAt: Date.now(),
						lastOutputAt: null,
						reviewReason: null,
						exitCode: null,
						lastHookAt: null,
						latestHookActivity: null,
						...(index > 0
							? {
									taskConversationSessionMetadata: {
										workspaceTaskId: keys[0],
										taskConversationSessionRole: "by_the_way",
										taskConversationSessionContextSource:
											index === 1 ? "forked_from_main_current_turn" : "started_from_scratch",
										parentTaskConversationSessionId: index === 1 ? keys[0] : null,
										mainSessionOriginTurnNumber: null,
										mainSessionOriginUserMessagePreview: null,
										latestUserMessagePreview: null,
									},
								}
							: {}),
					},
				]),
			);
			await rpc("workspace.saveState", workspaceId, {
				board: initial.board,
				sessions,
				expectedRevision: initial.revision,
			});
			// 让新运行时从预置 fixture 水合；之后不再调用 workspace.saveState。
			await killServer();
			await startServer();
			for (const [index, key] of keys.entries()) {
				const args = configuration.flatMap((value) => ["-c", value]);
				args.push(
					"--sandbox",
					index === 0 ? "danger-full-access" : "read-only",
					"--ask-for-approval",
					"never",
					"-C",
					repository.repositoryPath,
				);
				if (index === 1) args.push("fork", nativeIds[0]);
				args.push(`isolated identity test ${key}`);
				const terminal = spawnPty(nativeBinary, args, {
					name: "xterm-256color",
					cols: 120,
					rows: 40,
					cwd: repository.repositoryPath,
					env: {
						...environment,
						CODEX_HOME: codexHome,
						TERM: "xterm-256color",
						KANBAN_RUNTIME_HOST: "127.0.0.1",
						KANBAN_RUNTIME_PORT: String(port),
						KANBAN_HOOK_WORKSPACE_ID: workspaceId,
						KANBAN_HOOK_TASK_ID: key,
					},
				});
				let output = "";
				const exited = new Promise<void>((resolveExit) => terminal.onExit(() => resolveExit()));
				terminal.onData((chunk) => {
					output += chunk;
					if (chunk.includes("\x1b[6n")) terminal.write("\x1b[1;1R");
					if (chunk.includes("\x1b[c")) terminal.write("\x1b[?1;2c");
				});
				try {
					await expect
						.poll(
							() => {
								const records = readFileSync(hookJournal, "utf8")
									.trim()
									.split("\n")
									.filter(Boolean)
									.map((line) => JSON.parse(line) as { payload: { session_id: string }; exitCode: number });
								if (records[index]) {
									expect(records[index].exitCode).toBe(0);
									nativeIds[index] = records[index].payload.session_id;
									return true;
								}
								return false;
							},
							{ timeout: 15000, message: `等待原生 hook: ${key}` },
						)
						.toBe(true);
					const persisted = JSON.parse(readFileSync(join(initial.statePath, "sessions.json"), "utf8")) as Record<
						string,
						RuntimeTaskSessionSummary
					>;
					expect(
						persisted[key]?.agentNativeConversationSessionIdentity?.nativeSessionId,
						stripVTControlCharacters(output),
					).toBe(nativeIds[index]);
					for (let other = 0; other < index; other++)
						expect(persisted[keys[other]].agentNativeConversationSessionIdentity?.nativeSessionId).toBe(
							nativeIds[other],
						);
				} finally {
					terminal.kill();
					await exited;
				}
			}
			expect(new Set(nativeIds).size).toBe(3);
			await killServer();
			await startServer();
			const restored = await rpc<RuntimeWorkspaceStateResponse>("workspace.getState", workspaceId);
			for (const [index, key] of keys.entries())
				expect(restored.sessions[key]?.agentNativeConversationSessionIdentity?.nativeSessionId).toBe(
					nativeIds[index],
				);
		} finally {
			await killServer();
			fixture.cleanup();
		}
	},
	90000,
);
