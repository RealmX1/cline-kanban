import type * as ChildProcessModule from "node:child_process";
import { spawn } from "node:child_process";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
	loadRefreshedKimiManagedModelCatalog,
	resolveKimiLaunchDefaultModelId,
} from "../../src/terminal/kimi-latest-managed-stable-model-selection";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	hasChildProcessExited,
	waitForChildProcessExit,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const spawnedChildProcessRegistry = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
const independentRequesterShutdownCallbacks = new Set<() => Promise<void>>();
vi.mock("node:child_process", async (importOriginal) => {
	const original = await importOriginal<typeof ChildProcessModule>();
	return {
		...original,
		spawn: (...args: Parameters<typeof original.spawn>) =>
			spawnedChildProcessRegistry.register(original.spawn(...args)),
	};
});
afterEach(async () => {
	try {
		await Promise.all([...independentRequesterShutdownCallbacks].map((shutdown) => shutdown()));
	} finally {
		independentRequesterShutdownCallbacks.clear();
		await spawnedChildProcessRegistry.sigkillEveryStillRunningChildProcessAndWaitForExit();
	}
});

async function createKimiServerFixture(mode = "success") {
	const directory = await mkdtemp(join(tmpdir(), "kanban-kimi-loopback-test-"));
	const binary = join(directory, "kimi-test-server.cjs");
	const processRecordPath = join(directory, "service-process.json");
	await writeFile(
		binary,
		`#!${process.execPath}
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const home = process.env.KIMI_CODE_HOME;
const mode = process.env.KIMI_TEST_SERVER_MODE;
const serviceLabel = process.env.KIMI_TEST_SERVICE_LABEL || "service-process";
const token = "fixture-secret-token-" + process.pid;
const recordLifecycle = (event) => fs.appendFileSync(path.join(home,"service-lifecycle.jsonl"),JSON.stringify({serviceLabel,event})+"\\n");
recordLifecycle("started");
fs.writeFileSync(path.join(home, "service-process.json"), JSON.stringify({pid:process.pid,cwd:process.cwd(),args:process.argv.slice(2)}));
fs.writeFileSync(path.join(home,serviceLabel+".json"), JSON.stringify({pid:process.pid,cwd:process.cwd(),args:process.argv.slice(2)}));
if (mode !== "missing-token") fs.writeFileSync(path.join(home, "server.token"), token);
if (mode === "exit") { process.stderr.write("sensitive-startup-output"); process.exit(1); }
if (mode === "startup-timeout") { setInterval(() => {}, 1000); return; }
const server = http.createServer((request, response) => {
  fs.appendFileSync(path.join(home, "requests.jsonl"), JSON.stringify({method:request.method,path:request.url})+"\\n");
  if (request.headers.authorization !== "Bearer " + token) { response.writeHead(401); response.end(); return; }
  if (mode === "request-timeout") return;
  if (mode === "http-error") { response.writeHead(503); response.end("sensitive-response-output"); return; }
  if (mode === "bad-json") { response.end("sensitive-invalid-json"); return; }
  if (mode === "bad-envelope") { response.end(JSON.stringify({code:40113,msg:"sensitive-error",data:{}})); return; }
  const refresh = {changed: mode === "changed-object" ? [{provider_id:"managed:kimi-code"}] : [], unchanged:["managed:kimi-code"], failed:[]};
  if (mode === "refresh-failed") refresh.failed.push({provider:"managed:kimi-code",reason:"sensitive-provider-reason"});
  if (mode === "missing-provider") refresh.unchanged = [];
  if (mode === "changed-object") refresh.unchanged = [];
  let items = [{provider:"managed:kimi-code",model:"kimi-code/k3.1-pro",max_context_size:1048576,display_name:"K3.1 Pro"}];
  if (mode === "invalid-catalog") items[0].max_context_size = "1048576";
  if (mode === "duplicate-catalog") items.push(items[0]);
  const data = request.url.includes("refresh_oauth") ? refresh : {items};
  response.setHeader("Content-Type","application/json");
  response.end(JSON.stringify({code:0,data}));
});
server.listen(0,"127.0.0.1", () => {
  const publishBanner = () => {
  process.stdout.write("\\x1b[36mWelcome\\nLocal server:\\nhttp://127.");
  setTimeout(() => process.stdout.write("0.0.1:"+server.address().port+"/\\x1b[0m\\n"), 5);
  };
  const startupReleasePath = process.env.KIMI_TEST_STARTUP_RELEASE_PATH;
  if (!startupReleasePath) publishBanner();
  else {
    const startupGate = setInterval(() => {
      if (!fs.existsSync(startupReleasePath)) return;
      clearInterval(startupGate);
      publishBanner();
    }, 5);
  }
});
process.on("SIGTERM", () => { fs.writeFileSync(path.join(home,"terminated"), "yes"); server.close(() => { recordLifecycle("stopped"); process.exit(0); }); });
`,
	);
	await chmod(binary, 0o755);
	onTestFinished(async () => {
		// 共享 afterEach 先确认子进程退出，再清理隔离目录。
		await rm(directory, { recursive: true, force: true });
	});
	return {
		directory,
		processRecordPath,
		options: {
			binary,
			env: { HOME: directory, KIMI_CODE_HOME: directory, KIMI_TEST_SERVER_MODE: mode },
			timeoutMs: 5_000,
		},
	};
}

async function assertServiceWasReclaimed(processRecordPath: string) {
	const record = JSON.parse(await readFile(processRecordPath, "utf8")) as { pid: number; cwd: string; args: string[] };
	expect(() => process.kill(record.pid, 0)).toThrow();
	await expect(access(record.cwd)).rejects.toThrow();
	expect(record.args).toEqual(["web", "--host", "127.0.0.1", "--port", "0", "--no-open"]);
}

function observeDefaultModelRequest(options: Parameters<typeof resolveKimiLaunchDefaultModelId>[0]) {
	return resolveKimiLaunchDefaultModelId(options).then(
		(modelId) => ({ modelId }),
		(error: unknown) => ({ error: String(error) }),
	);
}

async function startIndependentCatalogRequester(fixture: Awaited<ReturnType<typeof createKimiServerFixture>>) {
	const sourceModuleUrl = new URL("../../src/terminal/kimi-latest-managed-stable-model-selection.ts", import.meta.url);
	// 独立 Node 进程复用同一份源码；其子服务在 IPC 断开或显式关停时先回收，避免失败留下孙进程。
	const script = `
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { resolveKimiLaunchDefaultModelId } from ${JSON.stringify(sourceModuleUrl.href)};
const children = new Set();
const originalSpawn = childProcess.spawn;
childProcess.spawn = (...args) => {
  const child = originalSpawn(...args);
  children.add(child);
  child.once("close", () => children.delete(child));
  return child;
};
syncBuiltinESMExports();
const shutdown = async () => {
  await Promise.all([...children].map((child) => new Promise((resolve) => {
    child.once("close", resolve);
    child.kill("SIGKILL");
  })));
  process.exit(0);
};
process.on("disconnect", shutdown);
process.on("message", async (message) => {
  if (message === "shutdown") { await shutdown(); return; }
  if (message !== "run") return;
  process.send({event:"started"});
  try {
    const modelId = await resolveKimiLaunchDefaultModelId({binary:process.env.KIMI_TEST_BINARY_PATH,timeoutMs:15000});
    process.send({event:"completed",modelId});
  } catch (error) { process.send({event:"completed",error:String(error)}); }
});
process.send({event:"ready"});
`;
	const child = spawn(
		process.execPath,
		["--import", createRequire(import.meta.url).resolve("tsx"), "--input-type=module", "--eval", script],
		{
			cwd: process.cwd(),
			env: {
				...fixture.options.env,
				KIMI_TEST_BINARY_PATH: fixture.options.binary,
				KIMI_TEST_SERVICE_LABEL: "second-service",
			},
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		},
	);
	child.stdout?.resume();
	child.stderr?.resume();
	independentRequesterShutdownCallbacks.add(async () => {
		if (hasChildProcessExited(child)) return;
		if (child.connected) child.send("shutdown");
		expect(await waitForChildProcessExit(child, 5_000)).toBe(true);
	});
	let ready = false;
	let started = false;
	let result: { modelId?: string; error?: string } | undefined;
	child.on("message", (message: { event: string; modelId?: string; error?: string }) => {
		if (message.event === "ready") ready = true;
		if (message.event === "started") started = true;
		if (message.event === "completed")
			result = { ...(message.modelId ? { modelId: message.modelId } : { error: message.error }) };
	});
	await vi.waitFor(() => expect(ready).toBe(true), { timeout: 10_000 });
	return {
		start: async () => {
			child.send("run");
			await vi.waitFor(() => expect(started).toBe(true), { timeout: 10_000 });
		},
		result: async () => {
			await vi.waitFor(() => expect(result).toBeDefined(), { timeout: 20_000 });
			return result;
		},
	};
}

describe("Kimi loopback 官方目录刷新协议", { timeout: 60_000 }, () => {
	it.each(["同一进程", "独立进程"])(
		"%s：同一 home 的并发刷新均成功，服务完整退出后再启动下一次",
		async (requesterKind) => {
			const fixture = await createKimiServerFixture();
			const independentRequester =
				requesterKind === "独立进程" ? await startIndependentCatalogRequester(fixture) : null;
			const startupReleasePath = join(fixture.directory, "release-first-service-startup");
			const firstRequest = observeDefaultModelRequest({
				...fixture.options,
				timeoutMs: 15_000,
				env: {
					...fixture.options.env,
					KIMI_TEST_SERVICE_LABEL: "first-service",
					KIMI_TEST_STARTUP_RELEASE_PATH: startupReleasePath,
				},
			});
			await vi.waitFor(async () => await access(join(fixture.directory, "first-service.json")), { timeout: 10_000 });
			if (independentRequester) await independentRequester.start();
			const secondRequest = independentRequester
				? independentRequester.result()
				: observeDefaultModelRequest({
						...fixture.options,
						env: { ...fixture.options.env, KIMI_TEST_SERVICE_LABEL: "second-service" },
					});
			// 观察屏障刻意保留：无互斥的实现会先启动第二个服务并覆盖首个服务仍要读取的 token。
			await new Promise((resolve) => setTimeout(resolve, 250));
			await writeFile(startupReleasePath, "release");
			expect(await Promise.all([firstRequest, secondRequest])).toEqual([
				{ modelId: "kimi-code/k3.1-pro" },
				{ modelId: "kimi-code/k3.1-pro" },
			]);
			const lifecycle = (await readFile(join(fixture.directory, "service-lifecycle.jsonl"), "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(lifecycle).toEqual([
				{ serviceLabel: "first-service", event: "started" },
				{ serviceLabel: "first-service", event: "stopped" },
				{ serviceLabel: "second-service", event: "started" },
				{ serviceLabel: "second-service", event: "stopped" },
			]);
			await assertServiceWasReclaimed(join(fixture.directory, "first-service.json"));
			await assertServiceWasReclaimed(join(fixture.directory, "second-service.json"));
		},
	);

	it("不同 home 的目录刷新独立，首个 home 未就绪时另一个仍能完成", async () => {
		const firstFixture = await createKimiServerFixture();
		const secondFixture = await createKimiServerFixture();
		const startupReleasePath = join(firstFixture.directory, "release-first-service-startup");
		const firstRequest = observeDefaultModelRequest({
			...firstFixture.options,
			env: { ...firstFixture.options.env, KIMI_TEST_STARTUP_RELEASE_PATH: startupReleasePath },
		});
		await vi.waitFor(async () => await access(firstFixture.processRecordPath), { timeout: 10_000 });
		expect(await resolveKimiLaunchDefaultModelId(secondFixture.options)).toBe("kimi-code/k3.1-pro");
		await expect(access(startupReleasePath)).rejects.toThrow();
		await writeFile(startupReleasePath, "release");
		expect(await firstRequest).toEqual({ modelId: "kimi-code/k3.1-pro" });
		await assertServiceWasReclaimed(firstFixture.processRecordPath);
		await assertServiceWasReclaimed(secondFixture.processRecordPath);
	});

	it("同一 home 的首个刷新失败后仍释放锁，等待者继续刷新并回收服务", async () => {
		const fixture = await createKimiServerFixture("refresh-failed");
		const startupReleasePath = join(fixture.directory, "release-failing-service-startup");
		const firstRequest = observeDefaultModelRequest({
			...fixture.options,
			env: { ...fixture.options.env, KIMI_TEST_STARTUP_RELEASE_PATH: startupReleasePath },
		});
		await vi.waitFor(async () => await access(fixture.processRecordPath), { timeout: 10_000 });
		const secondRequest = observeDefaultModelRequest({
			...fixture.options,
			env: { ...fixture.options.env, KIMI_TEST_SERVER_MODE: "success", KIMI_TEST_SERVICE_LABEL: "second-service" },
		});
		await new Promise((resolve) => setTimeout(resolve, 100));
		await writeFile(startupReleasePath, "release");
		expect(await firstRequest).toEqual({ error: expect.stringContaining("刷新失败") });
		expect(await secondRequest).toEqual({ modelId: "kimi-code/k3.1-pro" });
		await assertServiceWasReclaimed(join(fixture.directory, "second-service.json"));
	});

	it("等锁超时不启动子服务；持有者退出后同一 home 仍可再次刷新", async () => {
		const fixture = await createKimiServerFixture();
		const startupReleasePath = join(fixture.directory, "release-lock-holder-startup");
		const firstRequest = observeDefaultModelRequest({
			...fixture.options,
			env: { ...fixture.options.env, KIMI_TEST_STARTUP_RELEASE_PATH: startupReleasePath },
		});
		await vi.waitFor(async () => await access(fixture.processRecordPath), { timeout: 10_000 });
		const waitingRequest = observeDefaultModelRequest({
			...fixture.options,
			timeoutMs: 100,
			env: { ...fixture.options.env, KIMI_TEST_SERVICE_LABEL: "timed-out-waiter" },
		});
		expect(await waitingRequest).toEqual({ error: expect.stringContaining("超时") });
		await expect(access(join(fixture.directory, "timed-out-waiter.json"))).rejects.toThrow();
		await writeFile(startupReleasePath, "release");
		expect(await firstRequest).toEqual({ modelId: "kimi-code/k3.1-pro" });
		await assertServiceWasReclaimed(fixture.processRecordPath);
		expect(await resolveKimiLaunchDefaultModelId(fixture.options)).toBe("kimi-code/k3.1-pro");
		await assertServiceWasReclaimed(fixture.processRecordPath);
	});

	it.each(["success", "changed-object"])("%s：多行与分块 ANSI banner 后刷新目录，固定模型并回收服务", async (mode) => {
		const fixture = await createKimiServerFixture(mode);
		expect(await resolveKimiLaunchDefaultModelId(fixture.options)).toBe("kimi-code/k3.1-pro");
		const requests = (await readFile(join(fixture.directory, "requests.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(requests).toEqual([
			{ method: "POST", path: "/api/v1/providers:refresh_oauth" },
			{ method: "GET", path: "/api/v1/models" },
		]);
		await assertServiceWasReclaimed(fixture.processRecordPath);
	});

	it.each([
		"exit",
		"http-error",
		"bad-json",
		"bad-envelope",
		"refresh-failed",
		"missing-provider",
		"missing-token",
		"invalid-catalog",
		"duplicate-catalog",
	])("%s：失败可观察，诊断不带凭证或服务正文，服务被回收", async (mode) => {
		const fixture = await createKimiServerFixture(mode);
		const error = await loadRefreshedKimiManagedModelCatalog(fixture.options).then(
			() => null,
			(failure: unknown) => failure,
		);
		expect(error).toBeInstanceOf(Error);
		expect(String(error)).toContain("Kimi");
		expect(String(error)).not.toMatch(/fixture-secret-token|sensitive-/);
		await assertServiceWasReclaimed(fixture.processRecordPath);
	});

	it.each(["request-timeout", "startup-timeout"])("%s 后也回收服务", async (mode) => {
		const fixture = await createKimiServerFixture(mode);
		await expect(loadRefreshedKimiManagedModelCatalog({ ...fixture.options, timeoutMs: 2_000 })).rejects.toThrow(
			"超时",
		);
		await assertServiceWasReclaimed(fixture.processRecordPath);
	});
});
