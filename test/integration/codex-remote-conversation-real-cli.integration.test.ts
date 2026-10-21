import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { type IPty, spawn as spawnPty } from "node-pty";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareCodexNativeSessionControlHostLaunch } from "../../src/codex-native-session-control-host/prepare-codex-native-session-control-host-launch";
import { withRunningCodexAppServerControlSocketConnection } from "../../src/rvf-automatic-closeout/codex-app-server-request-connection";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { waitForConditionWithinLoadSensitiveTwoTierDeadline } from "../utilities/load-sensitive-wall-clock-two-tier-deadline";

const nativeHosts: { pty: IPty; exited: Promise<void>; output: () => string }[] = [];
const modelServers: Server[] = [];
async function stopHost(host: (typeof nativeHosts)[number]) {
	host.pty.kill("SIGTERM");
	const escalation = setTimeout(() => host.pty.kill("SIGKILL"), 3_000);
	try {
		await host.exited;
	} finally {
		clearTimeout(escalation);
	}
}
afterEach(async () => {
	for (const host of nativeHosts.splice(0)) await stopHost(host);
	for (const server of modelServers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
	vi.unstubAllEnvs();
});

describe.skipIf(!process.env.KANBAN_CODEX_NATIVE_RVF_CLOSEOUT_SMOKE_BINARY || process.platform === "win32")(
	"真实 Codex 的远程恢复、只读 fork 与工具归属",
	{ timeout: 180_000 },
	() => {
		it("受管恢复可继续对话，fork 在投递正文前确认只读，所有调用仅使用回环模拟模型", async (test) => {
			vi.stubEnv("TMPDIR", "/tmp");
			const fixture = createIsolatedGitTestWorkspaceFixture({ fixtureRootDirectoryNamePrefix: "kcr-native-" });
			const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "native-resume" });
			await writeFile(join(repository.repositoryPath, "fixture.txt"), "隔离初始文件\n");
			repository.commitAllRepositoryFilesAtDate({
				message: "隔离初始提交",
				authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
			});
			vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
			const codexHome = join(fixture.fixtureRootDirectoryPath, "codex-home");
			await mkdir(codexHome);
			const hookObservationsPath = join(fixture.fixtureRootDirectoryPath, "native-hook-observations.jsonl");
			const hook = join(fixture.fixtureRootDirectoryPath, "record-native-hook.cjs");
			await writeFile(
				hook,
				`const fs=require("node:fs");let raw="";process.stdin.on("data",s=>raw+=s);process.stdin.on("end",()=>{const e=JSON.parse(raw);fs.appendFileSync(${JSON.stringify(hookObservationsPath)},JSON.stringify({taskId:process.env.KANBAN_TASK_ID,nativeSessionId:e.session_id,event:e.hook_event_name})+"\\n");});`,
			);
			await writeFile(
				join(codexHome, "hooks.json"),
				JSON.stringify({
					hooks: {
						SessionStart: [
							{
								hooks: [
									{ type: "command", command: `${JSON.stringify(process.execPath)} ${JSON.stringify(hook)}` },
								],
							},
						],
						Stop: [
							{
								hooks: [
									{ type: "command", command: `${JSON.stringify(process.execPath)} ${JSON.stringify(hook)}` },
								],
							},
						],
					},
				}),
			);
			await writeFile(
				join(codexHome, "auth.json"),
				JSON.stringify({ OPENAI_API_KEY: "sk-isolated-no-external-inference" }),
				{ mode: 0o600 },
			);
			let requestCount = 0;
			const modelRequests: Record<string, unknown>[] = [];
			const server = createServer(async (request, response) => {
				let body = "";
				for await (const chunk of request) body += String(chunk);
				const parsed = JSON.parse(body) as Record<string, unknown>;
				modelRequests.push(parsed);
				const count = ++requestCount;
				const input = Array.isArray(parsed.input)
					? (parsed.input as {
							type: string;
							role?: string;
							content?: { text?: string }[];
							call_id?: string;
							output?: unknown;
						}[])
					: [];
				const lastUserText =
					input
						.filter((item) => item.role === "user")
						.at(-1)
						?.content?.map((part) => part.text ?? "")
						.join("") ?? "";
				const stage =
					lastUserText === "NATIVE_RESUMED_PROMPT"
						? "RESUMED"
						: lastUserText === "NATIVE_FORK_PROMPT"
							? "FORK"
							: lastUserText === "NATIVE_ORIGINAL_PROMPT"
								? "ORIGINAL"
								: "BACKGROUND";
				const toolCallId = `native_tool_${stage}`;
				const shouldCallTool =
					["RESUMED", "FORK"].includes(stage) &&
					!input.some((item) => item.type === "function_call_output" && item.call_id === toolCallId);
				const text = `NATIVE_RESPONSE_${stage}`;
				const message = {
					id: `message_${count}`,
					type: "message",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text, annotations: [] }],
				};
				const item = shouldCallTool
					? {
							id: `tool_${count}`,
							type: "function_call",
							name: "exec_command",
							call_id: toolCallId,
							arguments: JSON.stringify({
								cmd:
									stage === "RESUMED"
										? "printf NATIVE_TOOL_SUCCESS > resumed-tool.txt; cat resumed-tool.txt"
										: "printf FORBIDDEN_WRITE > forbidden-read-only.txt",
								max_output_tokens: 100,
							}),
							status: "completed",
						}
					: message;
				const result = {
					id: `response_${count}`,
					object: "response",
					created_at: Math.floor(Date.now() / 1000),
					status: "completed",
					model: "gpt-5.4",
					output: [item],
					usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
				};
				response.writeHead(200, { "Content-Type": "text/event-stream" });
				const events = shouldCallTool
					? [
							["response.created", { response: { ...result, status: "in_progress", output: [] } }],
							["response.output_item.done", { output_index: 0, item }],
							["response.completed", { response: result }],
						]
					: [
							["response.created", { response: { ...result, status: "in_progress", output: [] } }],
							[
								"response.output_item.added",
								{ output_index: 0, item: { ...item, status: "in_progress", content: [] } },
							],
							[
								"response.content_part.added",
								{
									item_id: item.id,
									output_index: 0,
									content_index: 0,
									part: { type: "output_text", text: "", annotations: [] },
								},
							],
							[
								"response.output_text.delta",
								{ item_id: item.id, output_index: 0, content_index: 0, delta: text },
							],
							["response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text }],
							["response.output_item.done", { output_index: 0, item }],
							["response.completed", { response: result }],
						];
				for (const [type, fields] of events as [string, Record<string, unknown>][])
					response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
				response.end();
			});
			modelServers.push(server);
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("隔离模型端口分配失败");
			await writeFile(
				join(codexHome, "config.toml"),
				`model="gpt-5.4"\nmodel_provider="isolated_loopback"\ncheck_for_update_on_startup=false\n[features]\nhooks=true\n[model_providers.isolated_loopback]\nname="隔离回环模型"\nbase_url="http://127.0.0.1:${address.port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n[projects.${JSON.stringify(repository.repositoryPath)}]\ntrust_level="trusted"\n`,
			);
			const start = async (taskId: string, arguments_: string[]) => {
				const environment = fixture.createIsolatedChildProcessEnvironment({
					CODEX_HOME: codexHome,
					TERM: "xterm-256color",
					KANBAN_TASK_ID: taskId,
				});
				const launch = await prepareCodexNativeSessionControlHostLaunch({
					binary: process.env.KANBAN_CODEX_NATIVE_RVF_CLOSEOUT_SMOKE_BINARY ?? "codex",
					arguments: [
						"--dangerously-bypass-hook-trust",
						"--no-alt-screen",
						"-C",
						repository.repositoryPath,
						...arguments_,
					],
					workingDirectoryPath: repository.repositoryPath,
					environment,
					workspaceId: "isolated-native-resume",
					conversationSessionId: taskId,
					runtimeSessionIncarnationId: randomUUID(),
				});
				if (!launch) throw new Error("真实原生 CLI 未提供受管宿主能力");
				const pty = spawnPty(launch.binary, launch.args, {
					cwd: repository.repositoryPath,
					env: environment as Record<string, string>,
					cols: 120,
					rows: 36,
				});
				let output = "";
				let trustedIsolatedHooks = false;
				const exited = new Promise<void>((resolve) => pty.onExit(() => resolve()));
				pty.onData((text) => {
					output += text;
					if (text.includes("\x1b[6n")) pty.write("\x1b[1;1R");
					if (text.includes("\x1b[c")) pty.write("\x1b[?1;2c");
					// 只信任本用例隔离 HOME 中自己生成的两个记录 hook。
					if (!trustedIsolatedHooks && output.includes("Trust") && output.includes("Hooks need review")) {
						trustedIsolatedHooks = true;
						setTimeout(() => pty.write("\x1b[B\r"), 150);
					}
				});
				const host = { pty, exited, output: () => output, launch };
				nativeHosts.push(host);
				return host;
			};
			const wait = (host: Awaited<ReturnType<typeof start>>, condition: () => Promise<boolean>) =>
				waitForConditionWithinLoadSensitiveTwoTierDeadline(
					test,
					{
						waitedForDescription: "真实 Codex 完成隔离恢复或回合",
						softDeadlineMsExpectedOnUncontendedHost: 8_000,
						hardDeadlineMsOnlyExplainedByRealHangOrRegression: 35_000,
					},
					condition,
					{ describeLastObservedStateForFailureMessage: () => host.output().slice(-3000) },
				);
			const hookEvents = async () =>
				(await readFile(hookObservationsPath, "utf8").catch(() => ""))
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as { taskId: string; nativeSessionId: string; event: string });
			const original = await start("native-original", [
				"--dangerously-bypass-approvals-and-sandbox",
				"NATIVE_ORIGINAL_PROMPT",
			]);
			await wait(original, async () =>
				(await hookEvents()).some((event) => event.taskId === "native-original" && event.event === "Stop"),
			);
			const sourceId = (await hookEvents()).find((event) => event.taskId === "native-original")?.nativeSessionId;
			if (!sourceId) throw new Error("原生 hook 未记录源会话身份");
			await stopHost(original);
			nativeHosts.splice(nativeHosts.indexOf(original), 1);
			const additionalWritableDirectory = join(fixture.fixtureRootDirectoryPath, "additional-writable-directory");
			await mkdir(additionalWritableDirectory);
			for (const [approvalPolicy, sandbox, effectiveSandboxType] of [
				["untrusted", "read-only", "readOnly"],
				["on-request", "workspace-write", "workspaceWrite"],
			] as const) {
				const restricted = await start(`native-${approvalPolicy}`, [
					"-a",
					approvalPolicy,
					"-s",
					sandbox,
					...(sandbox === "workspace-write" ? ["--add-dir", additionalWritableDirectory] : []),
					"resume",
					"--last",
				]);
				await wait(restricted, async () => restricted.output().includes("NATIVE_RESPONSE_ORIGINAL"));
				const receipt = JSON.parse(
					await readFile(
						join(dirname(restricted.launch.args.at(-1) ?? ""), "remote-conversation-bootstrap-receipt.json"),
						"utf8",
					),
				);
				expect(receipt).toMatchObject({
					nativeSessionId: sourceId,
					effectiveApprovalPolicy: approvalPolicy,
					effectiveSandbox: { type: effectiveSandboxType },
				});
				if (sandbox === "workspace-write")
					expect(receipt.effectiveSandbox.writableRoots).toContain(additionalWritableDirectory);
				await stopHost(restricted);
				nativeHosts.splice(nativeHosts.indexOf(restricted), 1);
			}
			const resumed = await start("native-resumed", [
				"--dangerously-bypass-approvals-and-sandbox",
				"resume",
				sourceId,
			]);
			const receiptPath = join(
				dirname(resumed.launch.args.at(-1) ?? ""),
				"remote-conversation-bootstrap-receipt.json",
			);
			await wait(
				resumed,
				async () =>
					!!(await stat(receiptPath).catch(() => null)) && resumed.output().includes("NATIVE_RESPONSE_ORIGINAL"),
			);
			expect(JSON.parse(await readFile(receiptPath, "utf8"))).toMatchObject({
				nativeSessionId: sourceId,
				effectiveApprovalPolicy: "never",
				effectiveSandbox: { type: "dangerFullAccess" },
			});
			resumed.pty.write("\x1b[200~NATIVE_RESUMED_PROMPT\x1b[201~\r");
			await wait(resumed, async () =>
				(await hookEvents()).some((event) => event.taskId === "native-resumed" && event.event === "Stop"),
			);
			expect(await readFile(join(repository.repositoryPath, "resumed-tool.txt"), "utf8")).toBe(
				"NATIVE_TOOL_SUCCESS",
			);
			const forked = await start("native-read-only-fork", [
				"--sandbox",
				"read-only",
				"--ask-for-approval",
				"never",
				"fork",
				sourceId,
				"NATIVE_FORK_PROMPT",
			]);
			await wait(forked, async () =>
				(await hookEvents()).some((event) => event.taskId === "native-read-only-fork" && event.event === "Stop"),
			);
			const forkReceipt = JSON.parse(
				await readFile(
					join(dirname(forked.launch.args.at(-1) ?? ""), "remote-conversation-bootstrap-receipt.json"),
					"utf8",
				),
			);
			expect(forkReceipt).toMatchObject({
				effectiveApprovalPolicy: "never",
				effectiveSandbox: { type: "readOnly" },
			});
			expect(forkReceipt.nativeSessionId).not.toBe(sourceId);
			await withRunningCodexAppServerControlSocketConnection(
				async (port) => {
					const loaded = (await port.request("thread/loaded/list", {})) as { data: string[] };
					expect(loaded.data).toContain(forkReceipt.nativeSessionId);
					const read = (await port.request("thread/read", {
						threadId: forkReceipt.nativeSessionId,
						includeTurns: false,
					})) as { thread: { source: string } };
					// 原生 remote 会话也可记为 vscode；两者都必须能进入默认的交互会话 --last 范围。
					expect(["cli", "vscode"]).toContain(read.thread.source);
				},
				{ socketPath: forked.launch.endpoint.socketPath },
			);
			expect(await stat(join(repository.repositoryPath, "forbidden-read-only.txt")).catch(() => null)).toBeNull();
			const toolOutputs = modelRequests
				.flatMap((request) =>
					Array.isArray(request.input)
						? (request.input as { type: string; call_id?: string; output?: unknown }[])
						: [],
				)
				.filter((item) => item.type === "function_call_output");
			expect(
				toolOutputs.some(
					(item) =>
						item.call_id === "native_tool_RESUMED" && JSON.stringify(item.output).includes("NATIVE_TOOL_SUCCESS"),
				),
			).toBe(true);
			expect(
				toolOutputs.some(
					(item) =>
						item.call_id === "native_tool_FORK" &&
						/[Pp]ermission denied|[Rr]ead.only|[Oo]peration not permitted/.test(JSON.stringify(item.output)),
				),
			).toBe(true);
			expect(
				(await hookEvents())
					.filter((event) => event.taskId === "native-read-only-fork")
					.every((event) => event.nativeSessionId === forkReceipt.nativeSessionId),
			).toBe(true);
			console.log(
				"NATIVE_REMOTE_RESUME_VERIFIED",
				JSON.stringify({
					sourceId,
					forkId: forkReceipt.nativeSessionId,
					requests: requestCount,
				}),
			);
		});
	},
);
