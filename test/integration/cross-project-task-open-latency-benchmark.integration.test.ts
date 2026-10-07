import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as waitForObservation } from "node:timers/promises";
import { createTRPCProxyClient, httpLink } from "@trpc/client";
import { expect, it } from "vitest";
import { WebSocket } from "ws";
import { addTaskToColumn } from "../../src/core/task-board-mutations";
import { loadWorkspaceContext, mutateWorkspaceState } from "../../src/state/workspace-state";
import type { RuntimeAppRouter } from "../../src/trpc/app-router";
import type { BrowserType } from "../../web-ui/node_modules/playwright-core";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";
import { waitForChildProcessExit } from "./runtime-integration-test-spawned-child-process-lifecycle";

// opt-in 墙钟测量，不作为 CI 性能阈值断言；原始样本必须输出到持久目录。
it.skipIf(process.env.KANBAN_RUN_ISOLATED_TASK_OPEN_LATENCY_BENCHMARK !== "1")(
	"隔离大项目：首份快照、详情首帧、终端恢复及后台争用",
	{ timeout: 900_000 },
	async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const checkout = resolve(process.env.KANBAN_LATENCY_BENCHMARK_SOURCE_CHECKOUT ?? process.cwd());
		const sourceCheckouts = process.env.KANBAN_LATENCY_BENCHMARK_BASELINE_CHECKOUT
			? [resolve(process.env.KANBAN_LATENCY_BENCHMARK_BASELINE_CHECKOUT), checkout]
			: [checkout];
		if (process.env.KANBAN_LATENCY_BENCHMARK_REVERSE_VARIANTS === "1") sourceCheckouts.reverse();
		const usesProductionBuild = process.env.KANBAN_LATENCY_BENCHMARK_USE_PRODUCTION_BUILD === "1";
		let activeCheckout = checkout;
		const output = process.env.KANBAN_LATENCY_BENCHMARK_EVIDENCE_DIRECTORY;
		if (!output) throw new Error("必须指定持久的 benchmark evidence directory");
		mkdirSync(output, { recursive: true });
		const sampleCount = Number(process.env.KANBAN_LATENCY_BENCHMARK_SAMPLE_COUNT ?? 20);
		const worktreeCount = Number(process.env.KANBAN_LATENCY_BENCHMARK_WORKTREE_COUNT ?? 224);
		const label = process.env.KANBAN_LATENCY_BENCHMARK_LABEL ?? "baseline";
		const requireFromCheckout = createRequire(join(checkout, "package.json"));
		const requireFromWebUi = createRequire(join(checkout, "web-ui/package.json"));
		const { chromium } = requireFromWebUi("playwright-core") as { chromium: BrowserType };
		const large = fixture.createNonBareRepository({ repositoryDirectoryName: "latency-large-project" });
		const small = fixture.createNonBareRepository({ repositoryDirectoryName: "latency-small-project" });
		for (const repository of [large, small]) {
			writeFileSync(join(repository.repositoryPath, "tracked.txt"), "initial\n");
			repository.commitAllRepositoryFilesAtDate({
				message: "初始化延迟夹具",
				authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
			});
		}
		const originalHome = process.env.HOME;
		const originalUserProfile = process.env.USERPROFILE;
		let largeId = "";
		let smallId = "";
		try {
			process.env.HOME = fixture.isolatedHomeDirectoryPath;
			process.env.USERPROFILE = fixture.isolatedHomeDirectoryPath;
			for (const [repository, count] of [
				[large, worktreeCount],
				[small, 1],
			] as const) {
				const workspaceId = (await loadWorkspaceContext(repository.repositoryPath)).workspaceId;
				if (repository === large) largeId = workspaceId;
				else smallId = workspaceId;
				await mutateWorkspaceState(repository.repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => {
					let board = state.board;
					for (let index = 0; index < count; index++) {
						const taskId = `latency-${index}`;
						board = addTaskToColumn(
							board,
							index === 0 ? "review" : "trash",
							{
								taskId,
								title: index === 0 ? "唯一延迟目标" : `历史任务 ${index}`,
								prompt: index === 0 ? "唯一延迟目标" : `历史任务 ${index}`,
								baseRef: "main",
								agentId: "claude",
							},
							() => taskId,
						).board;
					}
					const target = board.columns.find((column) => column.id === "review")?.cards[0];
					if (!target) throw new Error("缺少延迟目标卡片");
					target.pinnedToTaskPinboardAt = Date.now();
					return { board, value: null };
				});
				for (let index = 0; index < count; index++) {
					const taskId = `latency-${index}`;
					const { worktreePath } = repository.createLinkedWorktree({
						worktreeDirectoryName: `${basename(repository.repositoryPath)}-${index}`,
						branchName: `latency-task-${index}`,
					});
					const parent = join(fixture.isolatedHomeDirectoryPath, ".cline/worktrees", taskId);
					mkdirSync(parent, { recursive: true });
					symlinkSync(worktreePath, join(parent, basename(repository.repositoryPath)));
				}
			}
		} finally {
			if (originalHome === undefined) delete process.env.HOME;
			else process.env.HOME = originalHome;
			if (originalUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = originalUserProfile;
		}
		const reservePort = async () => {
			const server = createServer();
			await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("无隔离端口");
			await new Promise<void>((done) => server.close(() => done()));
			expect([3484, 3485]).not.toContain(address.port);
			return address.port;
		};
		const runtimePort = await reservePort();
		let webPort = await reservePort();
		while (webPort === runtimePort) webPort = await reservePort();
		const runtimeOrigin = `http://127.0.0.1:${runtimePort}`;
		const webOrigin = usesProductionBuild ? runtimeOrigin : `http://127.0.0.1:${webPort}`;
		const environment = fixture.createIsolatedChildProcessEnvironment();
		for (const key of Object.keys(environment)) {
			if (/^(KANBAN_|ANTHROPIC_|OPENAI_|CLAUDE_|CODEX_|CURSOR_|GEMINI_|GOOGLE_|KIMI_)/.test(key))
				delete environment[key];
		}
		Object.assign(environment, {
			PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
			NODE_ENV: "development",
			KANBAN_RUNTIME_PORT: String(runtimePort),
			DO_NOT_TRACK: "1",
		});
		const ownedProcesses = new Set<ChildProcess>();
		const startProcess = (role: string, arguments_: string[], cwd: string) => {
			const child = spawn(process.execPath, arguments_, {
				cwd,
				env: environment,
				stdio: ["ignore", "pipe", "pipe", "ipc"],
			});
			ownedProcesses.add(child);
			let log = "";
			child.stdout?.on("data", (bytes) => {
				log += String(bytes);
			});
			child.stderr?.on("data", (bytes) => {
				log += String(bytes);
			});
			child.on("exit", () => writeFileSync(join(output, `${label}-${role}-${child.pid}.log`), log));
			return child;
		};
		const stopProcess = async (child: ChildProcess) => {
			if (child.exitCode !== null || child.signalCode !== null) return;
			child.send({ type: "kanban.shutdown" });
			if (!(await waitForChildProcessExit(child, 15_000))) {
				child.kill("SIGKILL");
				await waitForChildProcessExit(child, 5_000);
			}
		};
		const observeUntil = async (predicate: () => Promise<boolean>, description: string, child: ChildProcess) => {
			const deadline = Date.now() + 45_000;
			while (Date.now() < deadline) {
				if (child.exitCode !== null || child.signalCode !== null)
					throw new Error(`${description}：目标子进程已退出（${child.exitCode ?? child.signalCode}）`);
				const ready = await predicate();
				if (ready && child.exitCode === null && child.signalCode === null) return;
				await waitForObservation(50);
			}
			throw new Error(`观察超时：${description}`);
		};
		const hook = join(checkout, "test/integration/shutdown-ipc-hook.cjs");
		const startRuntime = async () => {
			const child = startProcess(
				"runtime",
				[
					"--require",
					hook,
					"--import",
					requireFromCheckout.resolve("tsx"),
					join(activeCheckout, usesProductionBuild ? "dist/cli.js" : "src/cli.ts"),
					"--port",
					String(runtimePort),
					"--no-open",
					"--no-passcode",
				],
				small.repositoryPath,
			);
			await observeUntil(
				() =>
					client()
						.projects.list.query()
						.then(({ projects }) => projects.some((project) => project.id === smallId))
						.catch(() => false),
				"runtime 启动",
				child,
			);
			return child;
		};
		const client = (workspaceId?: string) =>
			createTRPCProxyClient<RuntimeAppRouter>({
				links: [
					httpLink({
						url: `${runtimeOrigin}/api/trpc`,
						headers: workspaceId ? { "x-kanban-workspace-id": workspaceId } : {},
					}),
				],
			});
		const sockets = new Set<WebSocket>();
		const measureSnapshot = async (workspaceId: string, focused: boolean) => {
			const url = new URL(`${runtimeOrigin.replace("http:", "ws:")}/api/runtime/ws`);
			url.searchParams.set("workspaceId", workspaceId);
			if (focused)
				url.searchParams.set(
					"workspaceMetadataProbeScope",
					JSON.stringify({
						workspaceMetadataProbeScopeKind: "focused_task_worktrees_plus_auto_review_tasks_in_review_column",
						focusedTaskIds: ["latency-0"],
					}),
				);
			const started = performance.now();
			const socket = new WebSocket(url, { origin: runtimeOrigin });
			sockets.add(socket);
			let finishMetadata!: () => void;
			const metadataComplete = new Promise<void>((done, reject) => {
				finishMetadata = done;
				socket.on("close", () => reject(new Error("元数据补齐前连接关闭")));
			});
			void metadataComplete.catch(() => undefined);
			const expectedCount = focused ? 1 : workspaceId === largeId ? worktreeCount : 1;
			const duration = await new Promise<number>((done, reject) => {
				const timer = setTimeout(() => reject(new Error("snapshot 超时")), 45_000);
				socket.on("error", reject);
				socket.on("message", (bytes) => {
					const message = JSON.parse(String(bytes));
					if ((message.workspaceMetadata?.taskWorkspaces?.length ?? 0) >= expectedCount) finishMetadata();
					if (message.type !== "snapshot") return;
					clearTimeout(timer);
					done(performance.now() - started);
				});
			});
			return { duration, socket, metadataComplete };
		};
		const rawSamples: Array<Record<string, number | string | null>> = [];
		let browser: Awaited<ReturnType<BrowserType["launch"]>> | null = null;
		let runtime: ChildProcess | null = null;
		try {
			const verificationScript = process.env.KANBAN_LATENCY_BENCHMARK_VERIFICATION_SCRIPT;
			if (verificationScript) {
				runtime = await startRuntime();
				const verification = spawnSync(process.execPath, [verificationScript], {
					cwd: small.repositoryPath,
					env: { ...environment, KANBAN_LATENCY_VERIFICATION_TARGET_WORKSPACE_ID: largeId },
					encoding: "utf8",
					timeout: 25_000,
				});
				writeFileSync(
					join(output, `${label}-verification-script-dry-run.json`),
					JSON.stringify(
						{
							exitCode: verification.status,
							signal: verification.signal,
							stdout: verification.stdout,
							stderr: verification.stderr,
						},
						null,
						2,
					),
				);
				expect(verification.signal).toBeNull();
				expect(verification.status).toBe(
					Number(process.env.KANBAN_LATENCY_BENCHMARK_VERIFICATION_EXPECTED_EXIT_CODE ?? "1"),
				);
				await stopProcess(runtime);
				runtime = null;
			}
			for (
				let index = 0;
				index < (process.env.KANBAN_LATENCY_BENCHMARK_SKIP_SNAPSHOTS === "1" ? 0 : sampleCount);
				index++
			) {
				for (const source of index % 2 === 0 ? sourceCheckouts : [...sourceCheckouts].reverse()) {
					activeCheckout = source;
					runtime = await startRuntime();
					const uncontended = await measureSnapshot(smallId, true);
					uncontended.socket.close();
					const coldPending = measureSnapshot(largeId, false);
					await waitForObservation(100);
					const contended = await measureSnapshot(smallId, true);
					contended.socket.close();
					const cold = await coldPending;
					const metadataTimeout = setTimeout(() => cold.socket.terminate(), 45_000);
					try {
						await cold.metadataComplete;
					} finally {
						clearTimeout(metadataTimeout);
					}
					cold.socket.close();
					const warm = await measureSnapshot(largeId, false);
					warm.socket.close();
					const focused = await measureSnapshot(largeId, true);
					focused.socket.close();
					rawSamples.push({
						scenario: "snapshot",
						variant: source === checkout ? "candidate" : "baseline",
						index,
						coldMs: cold.duration,
						contendedMs: contended.duration,
						uncontendedMs: uncontended.duration,
						warmMs: warm.duration,
						focusedMs: focused.duration,
					});
					writeFileSync(join(output, `${label}-samples.json`), JSON.stringify(rawSamples, null, 2));
					console.log(
						`${label} snapshot ${index + 1}/${sampleCount}: ${Math.round(cold.duration)}ms / ${Math.round(warm.duration)}ms`,
					);
					await stopProcess(runtime);
					runtime = null;
				}
			}
			if (process.env.KANBAN_LATENCY_BENCHMARK_SKIP_BROWSER !== "1") {
				for (const source of sourceCheckouts) {
					activeCheckout = source;
					runtime = await startRuntime();
					await client().projects.recordTaskOpenedByUser.mutate({ workspaceId: largeId, taskId: "latency-0" });
					await client(largeId).runtime.startShellSession.mutate({ taskId: "latency-0", baseRef: "main" });
					const webReadinessMarker = randomUUID();
					const viteConfig = join(fixture.fixtureRootDirectoryPath, "isolated-latency-benchmark-vite.config.mts");
					writeFileSync(
						viteConfig,
						`import base from ${JSON.stringify(join(activeCheckout, "web-ui/vite.config.ts"))};\nexport default {...base, plugins: [...(base.plugins ?? []), {name: "isolated-latency-benchmark-readiness", transformIndexHtml: () => [{tag: "meta", attrs: {"data-isolated-latency-benchmark-readiness": ${JSON.stringify(webReadinessMarker)}}}]}], root: ${JSON.stringify(join(activeCheckout, "web-ui"))}, cacheDir: ${JSON.stringify(join(fixture.fixtureRootDirectoryPath, "isolated-vite-dependency-cache"))}, server: ${JSON.stringify({ host: "127.0.0.1", port: webPort, strictPort: true, proxy: { "/api": { target: runtimeOrigin, changeOrigin: true, ws: true, headers: { origin: runtimeOrigin } } } })}};\n`,
					);
					const viteProcess = usesProductionBuild
						? null
						: startProcess(
								"vite",
								[
									"--require",
									hook,
									join(checkout, "web-ui/node_modules/vite/bin/vite.js"),
									"--config",
									viteConfig,
								],
								join(activeCheckout, "web-ui"),
							);
					await observeUntil(
						() =>
							fetch(webOrigin)
								.then(async (response) => {
									if (!response.ok) return false;
									const html = await response.text();
									return usesProductionBuild
										? html.includes('<div id="root">')
										: html.includes(webReadinessMarker);
								})
								.catch(() => false),
						usesProductionBuild ? "打包态 Web UI 启动" : "Vite 启动",
						viteProcess ?? runtime,
					);
					browser = await chromium.launch({ channel: "chrome", headless: true });
					const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
					context.setDefaultTimeout(45_000);
					const page = await context.newPage();
					const forbiddenRequests: string[] = [];
					page.on("request", (request) => {
						if (["3484", "3485"].includes(new URL(request.url()).port)) forbiddenRequests.push(request.url());
					});
					await page.addInitScript({
						content: `
localStorage.setItem("kanban.onboarding.dialog.shown","true");
const observedTerminalEvents=[];
window.latencyMeasurementTargetWorkspaceId=null;
window.firstTargetTaskContentPaintAt=null;
window.firstTargetFullDetailPaintAt=null;
const observeTargetTaskPaint=()=>{
 const workspaceId=window.latencyMeasurementTargetWorkspaceId;
 if(!workspaceId)return;
 const preview=document.querySelector('[data-preview-workspace-id="'+workspaceId+'"]');
 const snapshotArrived=observedTerminalEvents.some(event=>event.type==="snapshot" && event.url.includes(workspaceId));
 const fullDetail=snapshotArrived && !document.querySelector('[data-testid="focus-view-cross-project-task-open-in-transit-shell"]') && document.querySelector('[data-verification-anchor="task-detail:latency-0"]');
 if((preview || fullDetail) && window.firstTargetTaskContentPaintAt===null)window.firstTargetTaskContentPaintAt=performance.now();
 if(fullDetail && window.firstTargetFullDetailPaintAt===null)window.firstTargetFullDetailPaintAt=performance.now();
};
new MutationObserver(()=>requestAnimationFrame(observeTargetTaskPaint)).observe(document,{subtree:true,childList:true,attributes:true});
window.observedTerminalEvents=observedTerminalEvents;
const NativeWebSocket=WebSocket;
window.WebSocket=class extends NativeWebSocket {
 constructor(url,protocols){
  super(url,protocols);
  observedTerminalEvents.push({url:this.url,type:"created",at:performance.now()});
  this.addEventListener("message",event=>{
   if(typeof event.data!=="string")return;
   try{if(JSON.parse(event.data).type==="snapshot")observedTerminalEvents.push({url:this.url,type:"snapshot",at:performance.now()});}catch{}
  });
 }
 send(payload){
  if(typeof payload==="string" && payload.includes("restore_complete"))observedTerminalEvents.push({url:this.url,type:"restore_complete",at:performance.now()});
  return super.send(payload);
 }
};
sessionStorage.setItem("kanban.selected-board-or-single-project-scope.v1","board_scope_all_projects");
`,
					});
					for (let index = 0; index < sampleCount; index++) {
						await page.mouse.move(1500, 900);
						await page.goto(`${webOrigin}/${smallId}?task=latency-0`);
						await page.locator('[data-verification-anchor="task-detail:latency-0"]').waitFor();
						const dialog = page.getByRole("dialog").filter({ hasText: "Get started" });
						if (await dialog.isVisible())
							await dialog.getByRole("button", { name: "Close", exact: true }).click();
						const row = page
							.getByRole("button")
							.filter({ hasText: "唯一延迟目标" })
							.filter({ hasText: "latency-large-project" })
							.first();
						let requests = 0;
						const countStateRequests = (request: { url: () => string }) => {
							if (request.url().includes("workspace.getState")) requests++;
						};
						page.on("request", countStateRequests);
						const started = performance.now();
						await page.evaluate(
							`window.observedTerminalEvents.splice(0);window.latencyMeasurementTargetWorkspaceId=${JSON.stringify(largeId)};window.firstTargetTaskContentPaintAt=null;window.firstTargetFullDetailPaintAt=null;window.latencyMeasurementClickAt=performance.now();`,
						);
						await row.dispatchEvent("click");
						await page.waitForURL(`**/${largeId}**`);
						await page.waitForFunction(
							(workspaceId) =>
								(
									globalThis as unknown as { observedTerminalEvents: Array<{ url: string; type: string }> }
								).observedTerminalEvents.some(
									(event) => event.type === "snapshot" && event.url.includes(workspaceId),
								),
							largeId,
						);
						await page.locator('[data-verification-anchor="task-detail:latency-0"]').waitFor();
						await page.evaluate("new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))");
						const detailMs = performance.now() - started;
						await page.locator(".xterm-screen").first().waitFor();
						await page.waitForFunction(
							(workspaceId) =>
								(
									globalThis as unknown as { observedTerminalEvents: Array<{ url: string; type: string }> }
								).observedTerminalEvents.some(
									(event) => event.type === "restore_complete" && event.url.includes(workspaceId),
								),
							largeId,
						);
						const terminalMs = performance.now() - started;
						const terminalConnectionRestoreMs = await page.evaluate<number | null, void>(
							`(() => {
const events=window.observedTerminalEvents.filter(event=>event.url.includes(${JSON.stringify(largeId)}));
const restored=events.find(event=>event.type==="restore_complete");
const created=events.find(event=>event.type==="created" && event.url===restored?.url);
return restored && created ? restored.at-created.at : null;
})()`,
							undefined,
						);
						const firstTaskContentMs = await page.evaluate<number | null, void>(
							"window.firstTargetTaskContentPaintAt===null ? null : window.firstTargetTaskContentPaintAt-window.latencyMeasurementClickAt",
							undefined,
						);
						const fullDetailPaintMs = await page.evaluate<number | null, void>(
							"window.firstTargetFullDetailPaintAt===null ? null : window.firstTargetFullDetailPaintAt-window.latencyMeasurementClickAt",
							undefined,
						);
						await waitForObservation(300);
						page.off("request", countStateRequests);
						rawSamples.push({
							scenario: "browser",
							variant: source === checkout ? "candidate" : "baseline",
							index,
							detailMs,
							terminalMs,
							terminalConnectionRestoreMs,
							firstTaskContentMs,
							fullDetailPaintMs,
							stateHttpRequests: requests,
						});
						writeFileSync(join(output, `${label}-samples.json`), JSON.stringify(rawSamples, null, 2));
						console.log(
							`${label} browser ${index + 1}/${sampleCount}: ${Math.round(detailMs)}ms / ${Math.round(terminalMs)}ms; HTTP=${requests}`,
						);
					}
					expect(forbiddenRequests).toEqual([]);
					await context.close();
					await browser.close();
					browser = null;
					if (viteProcess) await stopProcess(viteProcess);
					await stopProcess(runtime);
				}
			}
		} finally {
			for (const context of browser?.contexts() ?? []) {
				for (const page of context.pages()) {
					await page.screenshot({ path: join(output, `${label}-last-page.png`) }).catch(() => undefined);
					writeFileSync(
						join(output, `${label}-last-page.txt`),
						await page
							.locator("body")
							.innerText()
							.catch(() => "页面已关闭"),
					);
				}
			}
			for (const socket of sockets) socket.terminate();
			await browser?.close();
			for (const child of ownedProcesses) await stopProcess(child);
		}
	},
);
