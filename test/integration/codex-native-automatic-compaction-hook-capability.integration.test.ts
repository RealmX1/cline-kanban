import { spawn } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { withRunningCodexAppServerControlSocketConnection } from "../../src/rvf-automatic-closeout/codex-app-server-control-socket-request-connection";
import {
	configureCodexHooks,
	supportsVerifiedCodexAutomaticCompactionPhaseHooks,
} from "../../src/terminal/codex-hook-config";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForChildProcessExit,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(async () => {
	await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
	vi.unstubAllEnvs();
});

describe("真实 Codex 自动压缩开始/结束能力", { timeout: 100_000 }, () => {
	it.skipIf(!process.env.KANBAN_CODEX_NATIVE_RVF_CLOSEOUT_SMOKE_BINARY || process.platform === "win32")(
		"隔离 HOME 和模型桩中，开始 hook 在压缩请求未完成时已经提供相同 session/turn 绑定",
		async () => {
			vi.stubEnv("TMPDIR", "/tmp");
			const fixture = createIsolatedGitTestWorkspaceFixture({ fixtureRootDirectoryNamePrefix: "native-compact-" });
			const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "compaction-probe" });
			await writeFile(join(repository.repositoryPath, "fixture.txt"), "隔离原生压缩探针\n");
			repository.commitAllRepositoryFilesAtDate({
				message: "初始化隔离探针",
				authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
			});
			const recorderPath = join(fixture.fixtureRootDirectoryPath, "native-hook-cli.cjs");
			await writeFile(
				recorderPath,
				`const fs=require("node:fs"),path=require("node:path"),root=${JSON.stringify(fixture.fixtureRootDirectoryPath)};let raw="";process.stdin.on("data",part=>raw+=part);process.stdin.on("end",()=>{const payload=JSON.parse(raw);fs.appendFileSync(path.join(root,"native-compaction-hook-observations.jsonl"),JSON.stringify({observed_at_ms:Date.now(),payload})+"\\n");if(payload.hook_event_name==="PreCompact"){fs.writeFileSync(path.join(root,"native-precompact-hook-blocked.json"),JSON.stringify(payload));const deadline=Date.now()+6000;const timer=setInterval(()=>{if(fs.existsSync(path.join(root,"native-precompact-hook-control-query-completed"))||Date.now()>=deadline)clearInterval(timer);},20);}});`,
			);
			expect(
				await supportsVerifiedCodexAutomaticCompactionPhaseHooks(
					process.env.KANBAN_CODEX_NATIVE_RVF_CLOSEOUT_SMOKE_BINARY ?? "codex",
					fixture.createIsolatedChildProcessEnvironment(),
				),
			).toBe(true);
			const nativeHookArguments: string[] = [];
			const originalEntrypoint = process.argv[1];
			try {
				// 仅替换这次生成的记录器命令；信任指纹与参数位置使用生产实现，原生侧不绕过审批。
				process.argv[1] = recorderPath;
				expect(configureCodexHooks(nativeHookArguments, true)).toBe(true);
			} finally {
				process.argv[1] = originalEntrypoint;
			}
			await writeFile(
				join(fixture.fixtureRootDirectoryPath, "native-validated-hook-arguments.json"),
				JSON.stringify(nativeHookArguments),
			);
			const child = children.register(
				spawn(
					"python3",
					[
						resolve("test/integration/fixtures/codex-native-automatic-compaction-hook-probe.py"),
						fixture.fixtureRootDirectoryPath,
						repository.repositoryPath,
						process.env.KANBAN_CODEX_NATIVE_RVF_CLOSEOUT_SMOKE_BINARY ?? "codex",
					],
					{ env: fixture.createIsolatedChildProcessEnvironment(), stdio: ["ignore", "pipe", "pipe"] },
				),
			);
			let output = "";
			child.stdout?.on("data", (chunk) => {
				output += String(chunk);
			});
			child.stderr?.on("data", (chunk) => {
				output += String(chunk);
			});
			try {
				const blockedPreHookPath = join(fixture.fixtureRootDirectoryPath, "native-precompact-hook-blocked.json");
				await vi.waitFor(async () => expect(await readFile(blockedPreHookPath, "utf8")).toBeTruthy(), {
					timeout: 40_000,
					interval: 20,
				});
				const preHook = z
					.object({ session_id: z.string(), turn_id: z.string() })
					.parse(JSON.parse(await readFile(blockedPreHookPath, "utf8")));
				const endpoint = z
					.object({ socket_path: z.string() })
					.parse(
						JSON.parse(
							await readFile(
								join(fixture.fixtureRootDirectoryPath, "native-compaction-control-endpoint.json"),
								"utf8",
							),
						),
					);
				const whileHookRunning = await withRunningCodexAppServerControlSocketConnection(
					async (port) =>
						z.object({ data: z.array(z.object({ id: z.string(), status: z.string() })) }).parse(
							await port.request("thread/turns/list", {
								threadId: preHook.session_id,
								cursor: null,
								limit: 2,
								sortDirection: "desc",
								itemsView: "full",
							}),
						),
					{ socketPath: endpoint.socket_path, requestTimeoutMs: 1_500 },
				);
				expect(whileHookRunning.data[0]).toMatchObject({ id: preHook.turn_id, status: "inProgress" });
				await writeFile(
					join(
						fixture.fixtureRootDirectoryPath,
						"native-compaction-control-observation-while-prehook-running.json",
					),
					JSON.stringify(whileHookRunning),
				);
				await writeFile(
					join(fixture.fixtureRootDirectoryPath, "native-precompact-hook-control-query-completed"),
					"已核验\n",
				);
				const readyPath = join(
					fixture.fixtureRootDirectoryPath,
					"native-compaction-control-observation-ready.json",
				);
				await vi.waitFor(async () => expect(await readFile(readyPath, "utf8")).toBeTruthy(), {
					timeout: 40_000,
					interval: 50,
				});
				const ready = z
					.object({
						socket_path: z.string(),
						pre_compact: z.object({ payload: z.object({ session_id: z.string(), turn_id: z.string() }) }),
					})
					.parse(JSON.parse(await readFile(readyPath, "utf8")));
				const page = await withRunningCodexAppServerControlSocketConnection(
					async (port) =>
						z.object({ data: z.array(z.object({ id: z.string(), status: z.string() })) }).parse(
							await port.request("thread/turns/list", {
								threadId: ready.pre_compact.payload.session_id,
								cursor: null,
								limit: 2,
								sortDirection: "desc",
								itemsView: "full",
							}),
						),
					{ socketPath: ready.socket_path, requestTimeoutMs: 1_500 },
				);
				expect(page.data[0]).toMatchObject({ id: ready.pre_compact.payload.turn_id, status: "inProgress" });
				await writeFile(
					join(fixture.fixtureRootDirectoryPath, "native-compaction-live-control-turn-observation.json"),
					JSON.stringify(page),
				);
				await writeFile(
					join(fixture.fixtureRootDirectoryPath, "native-compaction-control-observation-completed"),
					"已核验\n",
				);
				expect(await waitForChildProcessExit(child, 85_000), output).toBe(true);
				expect(child.exitCode, output).toBe(0);
				expect(output).toContain("NATIVE_AUTOMATIC_COMPACTION_HOOK_CAPABILITY_VERIFIED");
				const result = JSON.parse(
					await readFile(
						join(fixture.fixtureRootDirectoryPath, "native-compaction-hook-capability-result.json"),
						"utf8",
					),
				);
				expect(result.pre_compact.payload.trigger).toBe("auto");
				expect(result.post_compact.payload.turn_id).toBe(result.pre_compact.payload.turn_id);
			} finally {
				if (child.exitCode === null && child.signalCode === null) {
					child.kill("SIGTERM");
					if (!(await waitForChildProcessExit(child, 5_000))) child.kill("SIGKILL");
				}
				const evidenceDirectory = process.env.KANBAN_CODEX_NATIVE_COMPACTION_HOOK_EVIDENCE_DIRECTORY;
				if (evidenceDirectory) {
					await mkdir(evidenceDirectory, { recursive: true });
					await cp(fixture.fixtureRootDirectoryPath, join(evidenceDirectory, "isolated-native-probe"), {
						recursive: true,
					});
					await writeFile(join(evidenceDirectory, "probe-output.log"), output);
				}
			}
		},
	);
});
