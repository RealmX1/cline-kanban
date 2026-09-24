// 显式启用的本机 harness smoke：隔离 HOME / CODEX_HOME，不读取用户凭据，不发送模型请求。
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node-pty";
import { expect, it } from "vitest";
import { prepareAgentLaunch } from "../../../src/terminal/agent-session-adapters";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

it.skipIf(!process.env.KANBAN_CODEX_NATIVE_DIRECTORY_SMOKE_BINARY)(
	"真实 Codex：两 worktree 的 resume / fork 只选本目录，显式 ID 仍可跨目录",
	async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		try {
			const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "native-resume-repository" });
			writeFileSync(join(repository.repositoryPath, "README.md"), "isolated native smoke\n");
			repository.commitAllRepositoryFilesAtDate({
				message: "测试初始提交",
				authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
			});
			const taskA = repository.createLinkedWorktree({
				worktreeDirectoryName: "task-a",
				branchName: "task-a",
			}).worktreePath;
			const taskB = repository.createLinkedWorktree({
				worktreeDirectoryName: "task-b",
				branchName: "task-b",
			}).worktreePath;
			for (const operation of ["resume", "fork", "explicit-fork"] as const) {
				const codexHome = join(fixture.isolatedHomeDirectoryPath, operation);
				const sessionsDirectory = join(codexHome, "sessions", "2026", "09", "23");
				mkdirSync(sessionsDirectory, { recursive: true });
				const sessionA = "11111111-1111-7111-8111-111111111111";
				const sessionB = "22222222-2222-7222-8222-222222222222";
				for (const [index, [sessionId, cwd]] of [
					[sessionA, taskA],
					[sessionB, taskB],
				].entries()) {
					const timestamp = `2026-09-23T0${index + 1}:00:00.000Z`;
					writeFileSync(
						join(sessionsDirectory, `rollout-2026-09-23T0${index + 1}-00-00-${sessionId}.jsonl`),
						`${[
							{
								timestamp,
								type: "session_meta",
								payload: {
									id: sessionId,
									session_id: sessionId,
									timestamp,
									cwd,
									originator: "codex_cli_rs",
									cli_version: "0.156.1",
									source: "cli",
									thread_source: "user",
									model_provider: "isolated-smoke",
								},
							},
							{
								timestamp,
								type: "response_item",
								payload: {
									type: "message",
									role: "user",
									content: [{ type: "input_text", text: `isolated-history-${sessionId}` }],
								},
							},
							{
								timestamp,
								type: "event_msg",
								payload: {
									type: "user_message",
									message: `isolated-history-${sessionId}`,
									images: [],
									local_images: [],
								},
							},
						]
							.map((item) => JSON.stringify(item))
							.join("\n")}\n`,
					);
				}
				writeFileSync(
					join(codexHome, "config.toml"),
					`check_for_update_on_startup = false\nmodel = "gpt-6"\nmodel_provider = "isolated-smoke"\n[model_providers.isolated-smoke]\nname = "Isolated smoke"\nbase_url = "http://127.0.0.1:1"\nwire_api = "responses"\nrequires_openai_auth = false\n[projects.${JSON.stringify(taskA)}]\ntrust_level = "trusted"\n[projects.${JSON.stringify(taskB)}]\ntrust_level = "trusted"\n`,
				);
				writeFileSync(
					join(codexHome, "auth.json"),
					JSON.stringify({ OPENAI_API_KEY: "isolated-smoke-not-a-real-key" }),
				);
				const launch = await prepareAgentLaunch({
					taskId: "native-directory-smoke",
					agentId: "codex",
					args: ["--no-alt-screen"],
					cwd: taskA,
					prompt: "",
					resumeFromTrash: operation === "resume",
					forkLatestWorkingDirectorySession: operation === "fork",
					parentSessionId: operation === "explicit-fork" ? sessionB : undefined,
				});
				const childEnvironment = fixture.createIsolatedChildProcessEnvironment();
				const environment: Record<string, string> = {};
				for (const key of ["HOME", "USERPROFILE", "PATH", "TMPDIR", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]) {
					if (childEnvironment[key]) environment[key] = childEnvironment[key];
				}
				Object.assign(environment, {
					CODEX_HOME: codexHome,
					TERM: "xterm-256color",
					OPENAI_API_KEY: "isolated-smoke-not-a-real-key",
				});
				const terminal = spawn(process.env.KANBAN_CODEX_NATIVE_DIRECTORY_SMOKE_BINARY ?? "codex", launch.args, {
					cwd: taskA,
					env: environment,
					cols: 150,
					rows: 40,
				});
				let output = "";
				try {
					await new Promise<void>((resolve, reject) => {
						const timeout = setTimeout(
							() => reject(new Error(`${operation} 启动未就绪: ${output.slice(-6000)}`)),
							20000,
						);
						terminal.onData((chunk) => {
							output += chunk;
							if (chunk.includes("\u001b[6n")) terminal.write("\u001b[1;1R");
							if (output.includes("isolated-history-")) {
								clearTimeout(timeout);
								resolve();
							}
						});
						terminal.onExit(({ exitCode }) => {
							clearTimeout(timeout);
							reject(new Error(`${operation} 提前退出 ${exitCode}: ${output.slice(-6000)}`));
						});
					});
					expect(output, JSON.stringify(launch.args)).toContain(
						`isolated-history-${operation === "explicit-fork" ? sessionB : sessionA}`,
					);
					expect(output).not.toContain(`isolated-history-${operation === "explicit-fork" ? sessionA : sessionB}`);
				} finally {
					terminal.kill();
					await new Promise((resolve) => setTimeout(resolve, 200));
				}
				// transcript 内容携带源 ID；fork 的持久化元数据进一步核对父会话身份。
				if (operation !== "resume") {
					const rollouts = readdirSync(join(codexHome, "sessions"), { recursive: true }).filter((file) =>
						String(file).endsWith(".jsonl"),
					);
					const metadata = rollouts.map((file) =>
						JSON.parse(readFileSync(join(codexHome, "sessions", String(file)), "utf8").split("\n")[0]),
					);
					expect(
						metadata.some(
							(item) => item.payload.forked_from_id === (operation === "explicit-fork" ? sessionB : sessionA),
						),
					).toBe(true);
				}
			}
		} finally {
			fixture.cleanup();
		}
	},
	90000,
);
