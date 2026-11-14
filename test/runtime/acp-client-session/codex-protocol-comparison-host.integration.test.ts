import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as requestHttp } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startCodexConversationProtocolComparisonHost } from "../../../src/agent-conversation/codex-conversation-protocol-comparison-host";

const require = createRequire(import.meta.url);
const ownedHosts: Awaited<ReturnType<typeof startCodexConversationProtocolComparisonHost>>[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const host of ownedHosts.splice(0)) await host.close();
	vi.unstubAllEnvs();
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function fixture() {
	const directory = await mkdtemp("/tmp/kanban-comparison-host-test-");
	directories.push(directory);
	await mkdir(join(directory, "isolated-home"));
	await mkdir(join(directory, "isolated-codex-home"));
	vi.stubEnv("HOME", join(directory, "isolated-home"));
	vi.stubEnv("CODEX_HOME", join(directory, "isolated-codex-home"));
	vi.stubEnv("CODEX_SQLITE_HOME", join(directory, "isolated-codex-home"));
	vi.stubEnv("KANBAN_COMPARISON_TEST_WS_MODULE_PATH", require.resolve("ws"));
	const options = {
		comparisonDirectory: directory,
		workingDirectory: join(directory, "execution-workspace"),
		codexBinary: resolve("test/integration/fixtures/codex-protocol-comparison-fake-app-server.cjs"),
		acpBinary: "/unused-acp",
		codexBridgeBinary: "/unused-bridge",
		modelId: "fixture-model",
	};
	async function open() {
		const host = await startCodexConversationProtocolComparisonHost(options);
		ownedHosts.push(host);
		const address = host.server.address();
		if (!address || typeof address === "string") throw new Error("比较 fixture 未绑定本机端口。");
		const url = `http://127.0.0.1:${address.port}`;
		const command = async (operation: string, extra: Record<string, unknown> = {}) => {
			const response = await fetch(`${url}/codex-comparison-api/command`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-Kanban-Codex-Comparison": host.controlToken },
				body: JSON.stringify({ backend: "codex_native", operation, ...extra }),
			});
			return {
				status: response.status,
				body: (await response.json()) as { ok: boolean; error?: string; result?: unknown },
			};
		};
		return { host, command, url };
	}
	return { directory, open };
}
describe("隔离 Codex 比较宿主", () => {
	it("fork 结果暂不可见时持久等待证据；重启后自动采用唯一已验证候选，不重复 fork", async () => {
		vi.stubEnv("KANBAN_COMPARISON_TEST_FORK_PREFIX_VALID", "1");
		vi.stubEnv("KANBAN_COMPARISON_TEST_FORK_RESPONSE_LOST", "1");
		vi.stubEnv("KANBAN_COMPARISON_TEST_FORK_RESULT_WITHHELD", "1");
		const { directory, open } = await fixture();
		const first = await open();
		await first.command("start");
		await first.command("send", { text: "建立可恢复 fork 边界", idempotencyKey: "fork-recovery-withheld" });
		await vi.waitFor(() =>
			expect(first.host.snapshot().sessions.codex_native.summary?.reviewReason).toBe("completion"),
		);
		const failed = await first.command("rewind", {
			boundaryTurnId: "removed-boundary-turn",
			lastPreBoundaryTurnId: "historical-turn",
		});
		expect(failed.body.error).toContain("fork 结果仍未知");
		const blockedInput = await first.command("send", {
			text: "不能猜分支发新输入",
			idempotencyKey: "unknown-fork-blocked-input",
		});
		expect(blockedInput.body.ok).toBe(false);
		await first.host.close();
		ownedHosts.splice(ownedHosts.indexOf(first.host), 1);
		vi.stubEnv("KANBAN_COMPARISON_TEST_DISCOVER_EXISTING_FORK", "1");
		const resumed = await open();
		const resumeDiagnostics = (await readFile(join(directory, "comparison-protocol-events.jsonl"), "utf8"))
			.split("\n")
			.filter((line) => line.includes('"resume_failed_no_prompt_replayed"'))
			.join("\n");
		expect(
			resumed.host.snapshot().sessions.codex_native.summary?.agentNativeConversationSessionIdentity?.nativeSessionId,
			resumeDiagnostics,
		).toBe("forked-test-thread");
		const journal = await readFile(join(directory, "comparison-protocol-events.jsonl"), "utf8");
		expect(journal.split('"method":"thread/fork"')).toHaveLength(2);
	});
	it("旧实例 PID 仍存活时不并发启动第二个会话写入者", async () => {
		const { directory, open } = await fixture();
		await writeFile(
			join(directory, "comparison-session-snapshot.json"),
			JSON.stringify({
				sessions: {
					codex_acp: { stoppedByUser: true, hadSubmittedPrompt: false },
					codex_native: {
						nativeSessionId: "prior-native-thread",
						stoppedByUser: false,
						hadSubmittedPrompt: true,
						lastSummary: { pid: process.pid },
					},
				},
			}),
		);
		const { host, command } = await open();
		expect(host.snapshot().sessions.codex_native.summary).toBeNull();
		const result = await command("start");
		expect(result.body.ok).toBe(false);
		expect(result.body.error).toContain("旧执行实例仍存活");
	});
	it.each([false, true])("成功 Rewind 后可见消息只来自恢复分支，不混入被移除回合；丢回执=%s", async (responseLost) => {
		vi.stubEnv("KANBAN_COMPARISON_TEST_FORK_PREFIX_VALID", "1");
		if (responseLost) vi.stubEnv("KANBAN_COMPARISON_TEST_FORK_RESPONSE_LOST", "1");
		const { directory, open } = await fixture();
		const { host, command } = await open();
		await command("start");
		await command("send", { text: "边界后的输入必须从可见分支移除", idempotencyKey: "removed-turn" });
		await vi.waitFor(() => expect(host.snapshot().sessions.codex_native.summary?.reviewReason).toBe("completion"));
		const rewind = await command("rewind", {
			boundaryTurnId: "removed-boundary-turn",
			lastPreBoundaryTurnId: "historical-turn",
		});
		expect(rewind.body).toMatchObject({ ok: true });
		const restored = host.snapshot().sessions.codex_native;
		expect(restored.summary?.agentNativeConversationSessionIdentity?.nativeSessionId).toBe("forked-test-thread");
		expect(restored.messages.some((message) => message.content.includes("边界后的输入必须从可见分支移除"))).toBe(
			false,
		);
		expect(restored.messages.some((message) => message.content === "历史输入")).toBe(true);
		const journal = await readFile(join(directory, "comparison-protocol-events.jsonl"), "utf8");
		expect(journal.split('"method":"thread/fork"')).toHaveLength(2);
		if (responseLost) expect(journal).toContain("rewind_unknown_result_evidence_query");
	});
	it("继承其他 SQLite 目录时在启动后端和写入证据前拒绝", async () => {
		const { directory, open } = await fixture();
		vi.stubEnv("CODEX_SQLITE_HOME", "/unrelated-codex-sqlite-storage");
		await expect(open()).rejects.toThrow("CODEX_SQLITE_HOME");
		await expect(readFile(join(directory, "comparison-session-snapshot.json"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});
	it("分块 HTTP 正文保留中文，非法 UTF-8 在投递前拒绝", async () => {
		const { open } = await fixture();
		const { host, command, url } = await open();
		await command("start");
		const text = "跨分块的中文输入，正文不得被替换";
		const body = Buffer.from(
			JSON.stringify({ backend: "codex_native", operation: "send", text, idempotencyKey: "split-utf8" }),
		);
		const splitOffset = body.indexOf(Buffer.from("中")) + 1;
		const sendRaw = (first: Buffer, second: Buffer) =>
			new Promise<number | undefined>((accept, reject) => {
				const request = requestHttp(
					`${url}/codex-comparison-api/command`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json", "X-Kanban-Codex-Comparison": host.controlToken },
					},
					(response) => {
						response.resume();
						response.once("end", () => accept(response.statusCode));
					},
				);
				request.once("error", reject);
				request.write(first);
				setTimeout(() => request.end(second), 20);
			});
		expect(await sendRaw(body.subarray(0, splitOffset), body.subarray(splitOffset))).toBe(200);
		expect(host.snapshot().sessions.codex_native.messages.find((message) => message.role === "user")?.content).toBe(
			text,
		);
		const malformed = Buffer.concat([
			Buffer.from('{"backend":"codex_native","operation":"send","text":"'),
			Buffer.from([255]),
			Buffer.from('","idempotencyKey":"invalid-utf8"}'),
		]);
		expect(await sendRaw(malformed, Buffer.alloc(0))).toBe(400);
	});
	it("未通过前缀核验的 fork 在重启后仍不采用，也不重复创建", async () => {
		vi.stubEnv("KANBAN_COMPARISON_TEST_FORK_PREFIX_INVALID", "1");
		const { directory, open } = await fixture();
		const first = await open();
		await first.command("start");
		await first.command("send", { text: "为恢复测试建立持久会话", idempotencyKey: "rewind-recovery-original" });
		await vi.waitFor(() =>
			expect(first.host.snapshot().sessions.codex_native.summary?.reviewReason).toBe("completion"),
		);
		const result = await first.command("rewind", {
			boundaryTurnId: "removed-boundary-turn",
			lastPreBoundaryTurnId: "historical-turn",
		});
		expect(result.status).toBe(400);
		await first.host.close();
		ownedHosts.splice(ownedHosts.indexOf(first.host), 1);
		const resumed = await open();
		expect(
			resumed.host.snapshot().sessions.codex_native.summary?.agentNativeConversationSessionIdentity?.nativeSessionId,
		).toBe("native-test-thread");
		const snapshot = JSON.parse(await readFile(join(directory, "comparison-session-snapshot.json"), "utf8"));
		expect(snapshot.sessions.codex_native.pendingRewindNativeSessionId).toBe("forked-test-thread");
		expect(snapshot.sessions.codex_native.pendingRewindPrefixVerified).toBe(false);
		const journal = await readFile(join(directory, "comparison-protocol-events.jsonl"), "utf8");
		expect(journal.split('"method":"thread/fork"')).toHaveLength(2);
	});
	it("拒绝跨源控制请求；重复键冻结原文且不发送第二条", async () => {
		const { directory, open } = await fixture();
		const { command, host, url } = await open();
		const rejected = await fetch(`${url}/codex-comparison-api/command`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: "http://untrusted.example" },
			body: JSON.stringify({ backend: "codex_native", operation: "start" }),
		});
		expect(rejected.status).toBe(400);
		expect(host.snapshot().sessions.codex_native.summary).toBeNull();
		expect((await command("start")).body.ok).toBe(true);
		expect((await command("send", { text: "冻结原文", idempotencyKey: "same-key" })).body.ok).toBe(true);
		await vi.waitFor(() => expect(host.snapshot().sessions.codex_native.summary?.reviewReason).toBe("completion"));
		expect((await command("send", { text: "冻结原文", idempotencyKey: "same-key" })).body.result).toMatchObject({
			duplicate: true,
			delivery: { text: "冻结原文" },
		});
		const changed = await command("send", { text: "改变后的正文", idempotencyKey: "same-key" });
		expect(changed.status).toBe(400);
		expect(changed.body.error).toContain("投递标识已用于其他消息");
		const events = (await readFile(join(directory, "comparison-protocol-events.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { kind: string; event: { method?: string; direction?: string } });
		expect(
			events.filter((event) => event.event.method === "turn/start" && event.event.direction === "request"),
		).toHaveLength(1);
	});
	it("受控重启自动恢复同一原生会话，不重发输入；显式 Stop 保留", async () => {
		const { directory, open } = await fixture();
		const first = await open();
		await first.command("start");
		await first.command("send", { text: "唯一首发", idempotencyKey: "original-key" });
		await vi.waitFor(() =>
			expect(first.host.snapshot().sessions.codex_native.summary?.reviewReason).toBe("completion"),
		);
		await first.host.close();
		ownedHosts.splice(ownedHosts.indexOf(first.host), 1);
		const resumed = await open();
		expect(
			resumed.host.snapshot().sessions.codex_native.summary?.agentNativeConversationSessionIdentity?.nativeSessionId,
		).toBe("native-test-thread");
		const text = await readFile(join(directory, "comparison-protocol-events.jsonl"), "utf8");
		expect(text.split('"method":"turn/start"')).toHaveLength(2);
		await resumed.command("stop");
		await resumed.host.close();
		ownedHosts.splice(ownedHosts.indexOf(resumed.host), 1);
		const stopped = await open();
		expect(stopped.host.snapshot().sessions.codex_native.summary).toBeNull();
		expect(stopped.host.snapshot().sessions.codex_native.recovery.stoppedByUser).toBe(true);
	});
});
