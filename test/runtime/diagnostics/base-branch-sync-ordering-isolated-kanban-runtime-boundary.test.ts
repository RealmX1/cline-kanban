import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { userInfo } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { fingerprint } from "../../../scripts/base-branch-sync-ordering-experiment/experiment-contract";
import {
	createIsolatedKanbanRuntimeEnvironment,
	createIsolatedKanbanRuntimeSandboxProfile,
	prepareIsolatedKanbanRuntimeBoundary,
} from "../../../scripts/base-branch-sync-ordering-experiment/isolated-kanban-runtime-boundary";
import { runIsolatedCommand } from "../../../scripts/base-branch-sync-ordering-experiment/macos-experiment-process-isolation";
import { createOwnedExperimentRoot } from "../../../scripts/base-branch-sync-ordering-experiment/persistent-experiment-storage";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

async function reserveLoopbackPort() {
	const server = createServer((socket) => socket.destroy());
	await new Promise<void>((resolveListening, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolveListening);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("未取得探针端口");
	return { port: address.port, close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())) };
}

describe("独立 Kanban runtime 的设置、进程和网络边界", () => {
	it.skipIf(process.platform !== "darwin")(
		"原生 daemon 仅可访问本实例的精确 socket，拒绝同目录的另一实例",
		async () => {
			const fixture = createIsolatedGitTestWorkspaceFixture();
			const instance = join(fixture.ownedIntegrationProjectsDirectoryPath, "private-native-control");
			mkdirSync(instance, { recursive: true });
			const ownRendezvous = join(instance, "own-rpc.sock");
			const daemon = join("/private/tmp", `codex-daemon-${userInfo().uid}`);
			mkdirSync(daemon, { recursive: true, mode: 0o700 });
			const ownSocket = join(daemon, fingerprint(ownRendezvous));
			const foreignSocket = join(daemon, fingerprint(join(fixture.fixtureRootDirectoryPath, "foreign-rpc.sock")));
			const foreign = createServer((socket) => socket.end("foreign"));
			await new Promise<void>((resolveListening, reject) => {
				foreign.once("error", reject);
				foreign.listen(foreignSocket, resolveListening);
			});
			const profilePath = join(instance, "precise-native-control.sb");
			writeFileSync(
				profilePath,
				createIsolatedKanbanRuntimeSandboxProfile({
					instanceDirectory: instance,
					runtimePort: 43121,
					protectedRuntimePort: 3484,
					executablePaths: [process.execPath],
					privateNativeControlRendezvousPaths: [ownRendezvous],
				}),
			);
			try {
				const script = `const net=require('node:net'),fs=require('node:fs');const r={};const server=net.createServer(s=>s.end('own'));server.listen(${JSON.stringify(ownSocket)},()=>{const own=net.connect(${JSON.stringify(ownSocket)});own.on('data',b=>{r.own=b.toString();own.destroy();try{fs.readdirSync(${JSON.stringify(daemon)});r.directoryRead='allowed'}catch{r.directoryRead='denied'}const foreign=net.connect(${JSON.stringify(foreignSocket)});foreign.on('connect',()=>{r.foreign='allowed';foreign.destroy();finish()});foreign.on('error',()=>{r.foreign='denied';finish()});function finish(){server.close(()=>process.stdout.write(JSON.stringify(r)));}});});`;
				const result = await runIsolatedCommand({
					argv: [process.execPath, "-e", script],
					cwd: instance,
					environment: createIsolatedKanbanRuntimeEnvironment(instance, 43121, 3484),
					profilePath,
					timeoutMs: 10_000,
				});
				expect(result.exitCode).toBe(0);
				expect(result.stderr).toBe("");
				expect(JSON.parse(result.stdout)).toEqual({ own: "own", foreign: "denied", directoryRead: "denied" });
				expect(() =>
					createIsolatedKanbanRuntimeSandboxProfile({
						instanceDirectory: instance,
						runtimePort: 43121,
						protectedRuntimePort: 3484,
						executablePaths: [],
						privateNativeControlRendezvousPaths: ["/outside/rpc.sock"],
					}),
				).toThrow("真实目录");
			} finally {
				await new Promise<void>((resolveClose) => foreign.close(() => resolveClose()));
				rmSync(ownSocket, { force: true });
				rmSync(foreignSocket, { force: true });
			}
		},
	);

	it.skipIf(process.platform !== "darwin")("真实终端工具能够分配 PTY 并读取子进程输出", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const root = join(fixture.ownedIntegrationProjectsDirectoryPath, "private-pty-runtime-controller");
		await createOwnedExperimentRoot(root, join(fixture.ownedIntegrationProjectsDirectoryPath, "source.git"));
		const instanceDirectory = join(root, "private-runtime");
		const boundary = await prepareIsolatedKanbanRuntimeBoundary({
			ownedRootDirectory: root,
			instanceDirectory,
			runtimePort: 43121,
			protectedRuntimePort: 3484,
			executablePaths: [],
		});
		const result = await runIsolatedCommand({
			argv: ["/usr/bin/script", "-q", "/dev/null", "/bin/echo", "private-pty-working"],
			cwd: instanceDirectory,
			environment: boundary.environment,
			profilePath: boundary.profilePath,
			timeoutMs: 10_000,
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("private-pty-working");
		expect(result.stderr).toBe("");
	});

	it.skipIf(process.platform !== "darwin")("只允许本实例的 Unix socket，包括私有路径的短别名", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const root = join(fixture.ownedIntegrationProjectsDirectoryPath, "private-unix-runtime-controller");
		await createOwnedExperimentRoot(root, join(fixture.ownedIntegrationProjectsDirectoryPath, "source.git"));
		const instanceDirectory = join(root, "private-runtime");
		mkdirSync(instanceDirectory);
		const aliases = mkdtempSync("/private/tmp/kanban-runtime-socket-test-");
		onTestFinished(() => rmSync(aliases, { recursive: true, force: true }));
		const ownAlias = join(aliases, "owned");
		symlinkSync(instanceDirectory, ownAlias);
		const homeAlias = join(aliases, "private-home");
		symlinkSync(join(instanceDirectory, "runtime-home"), homeAlias);
		const protectedSocket = join(aliases, "protected.sock");
		const protectedServer = createServer((socket) => socket.destroy());
		await new Promise<void>((resolveListening, reject) => {
			protectedServer.once("error", reject);
			protectedServer.listen(protectedSocket, resolveListening);
		});
		try {
			const boundary = await prepareIsolatedKanbanRuntimeBoundary({
				ownedRootDirectory: root,
				instanceDirectory,
				runtimePort: 43121,
				protectedRuntimePort: 3484,
				executablePaths: [process.execPath],
				privateHomeDirectoryPathAlias: homeAlias,
			});
			expect(boundary.environment.HOME).toBe(homeAlias);
			const foreignHomeAlias = join(aliases, "foreign-home");
			symlinkSync(fixture.isolatedHomeDirectoryPath, foreignHomeAlias);
			await expect(
				prepareIsolatedKanbanRuntimeBoundary({
					ownedRootDirectory: root,
					instanceDirectory,
					runtimePort: 43121,
					protectedRuntimePort: 3484,
					executablePaths: [process.execPath],
					privateHomeDirectoryPathAlias: foreignHomeAlias,
				}),
			).rejects.toThrow("私有 HOME");
			const script = `
const net=require('node:net');const result={};const server=net.createServer(socket=>socket.end('private-unix'));
server.listen(${JSON.stringify(join(ownAlias, "own.sock"))},()=>{const own=net.connect(${JSON.stringify(join(ownAlias, "own.sock"))});own.on('data',data=>{result.ownUnix=data.toString();own.destroy();const foreign=net.connect(${JSON.stringify(protectedSocket)});foreign.on('connect',()=>{result.foreignUnix='allowed';foreign.destroy();finish()});foreign.on('error',()=>{result.foreignUnix='denied';finish()});function finish(){process.stdout.write(JSON.stringify(result));server.close();}});});
`;
			const result = await runIsolatedCommand({
				argv: [process.execPath, "-e", script],
				cwd: instanceDirectory,
				environment: boundary.environment,
				profilePath: boundary.profilePath,
				timeoutMs: 20_000,
			});
			expect(result.stderr).toBe("");
			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.stdout)).toEqual({ ownUnix: "private-unix", foreignUnix: "denied" });
		} finally {
			await new Promise<void>((resolveClose) => protectedServer.close(() => resolveClose()));
		}
	});

	it("不继承生产身份、注入配置或禁用普通 Git hooks 的环境", () => {
		const environment = createIsolatedKanbanRuntimeEnvironment("/private/runtime-one", 43121, 3484);
		expect(environment.HOME).toBe("/private/runtime-one/runtime-home");
		expect(environment.CODEX_HOME).toBe(environment.CODEX_SQLITE_HOME);
		expect(environment.GIT_CONFIG_GLOBAL).toBe("/private/runtime-one/runtime-home/.gitconfig");
		expect(environment.KANBAN_RUNTIME_PORT).toBe("43121");
		for (const key of [
			"KANBAN_TASK_ID",
			"KANBAN_WORKSPACE_ID",
			"GIT_CONFIG_COUNT",
			"GIT_CONFIG_VALUE_0",
			"GIT_AUTHOR_NAME",
			"NODE_OPTIONS",
			"NODE_PATH",
			"HTTP_PROXY",
		])
			expect(environment).not.toHaveProperty(key);
		expect(() => createIsolatedKanbanRuntimeEnvironment("/private/runtime-one", 3484, 3484)).toThrow("日常");
		expect(() => createIsolatedKanbanRuntimeEnvironment("relative", 43121, 3484)).toThrow("绝对");
	});

	it.skipIf(process.platform !== "darwin")(
		"实际子进程可写私有设置及调用自身端口，拒绝另一实例的文件、端口和信号",
		async () => {
			const fixture = createIsolatedGitTestWorkspaceFixture();
			const root = join(fixture.ownedIntegrationProjectsDirectoryPath, "runtime-boundary-controller");
			await createOwnedExperimentRoot(root, join(fixture.ownedIntegrationProjectsDirectoryPath, "source.git"));
			const instanceDirectory = join(root, "private-runtime");
			const protectedDirectory = join(root, "other-runtime");
			mkdirSync(protectedDirectory);
			const protectedFile = join(protectedDirectory, "settings.json");
			writeFileSync(protectedFile, "原实例设置");
			const ownPort = await reserveLoopbackPort();
			const otherPort = await reserveLoopbackPort();
			await ownPort.close();
			try {
				const boundary = await prepareIsolatedKanbanRuntimeBoundary({
					ownedRootDirectory: root,
					instanceDirectory,
					runtimePort: ownPort.port,
					protectedRuntimePort: otherPort.port,
					executablePaths: [process.execPath],
				});
				const script = `
const fs=require('node:fs'); const http=require('node:http'); const net=require('node:net'); const cp=require('node:child_process');
const result={}; const protectedFile=${JSON.stringify(protectedFile)};
fs.writeFileSync(process.env.HOME+'/private-settings.json','私有设置'); result.privateWrite=true;
for(const [name,action] of Object.entries({outsideRead:()=>fs.readFileSync(protectedFile),outsideWrite:()=>fs.writeFileSync(protectedFile,'污染'),outsideSignal:()=>process.kill(${process.pid},0)})) {
 try { action();result[name]='allowed'; } catch { result[name]='denied'; }
}
const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
child.on('spawn',()=>{ result.childSignal=child.kill('SIGTERM'); });
const server=http.createServer((req,res)=>res.end('private-runtime'));
server.listen(${ownPort.port},'127.0.0.1',async()=>{
 try {
  result.ownHttp=await (await fetch('http://127.0.0.1:${ownPort.port}')).text();
  result.outsideNetwork=await new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port:${otherPort.port}});socket.on('connect',()=>{socket.destroy();resolve('allowed')});socket.on('error',()=>resolve('denied'));});
  result.childSettings=JSON.parse(cp.execFileSync(process.execPath,['-e',"process.stdout.write(JSON.stringify({home:process.env.HOME,port:process.env.KANBAN_RUNTIME_PORT}))"],{encoding:'utf8'}));
  process.stdout.write(JSON.stringify(result));
 } catch(error) { process.stderr.write(String(error));process.exitCode=1; }
 finally {server.close();}
});
`;
				const result = await runIsolatedCommand({
					argv: [process.execPath, "-e", script],
					cwd: instanceDirectory,
					environment: boundary.environment,
					profilePath: boundary.profilePath,
					timeoutMs: 20_000,
				});
				expect(result.stderr).toBe("");
				expect(result.exitCode).toBe(0);
				expect(JSON.parse(result.stdout)).toEqual({
					privateWrite: true,
					outsideRead: "denied",
					outsideWrite: "denied",
					outsideSignal: "denied",
					childSignal: true,
					ownHttp: "private-runtime",
					outsideNetwork: "denied",
					childSettings: { home: boundary.environment.HOME, port: String(ownPort.port) },
				});
				expect(readFileSync(protectedFile, "utf8")).toBe("原实例设置");
				expect(readFileSync(join(boundary.environment.HOME ?? "", "private-settings.json"), "utf8")).toBe(
					"私有设置",
				);
				expect(boundary.browserOrigin).toMatch(
					new RegExp(`^http://workspace-[a-f0-9]{24}\\.localhost:${ownPort.port}$`),
				);
				expect(
					await prepareIsolatedKanbanRuntimeBoundary({
						ownedRootDirectory: root,
						instanceDirectory,
						runtimePort: ownPort.port,
						protectedRuntimePort: otherPort.port,
						executablePaths: [process.execPath],
					}),
				).toEqual(boundary);
				writeFileSync(boundary.profilePath, "边界已被修改");
				await expect(
					prepareIsolatedKanbanRuntimeBoundary({
						ownedRootDirectory: root,
						instanceDirectory,
						runtimePort: ownPort.port,
						protectedRuntimePort: otherPort.port,
						executablePaths: [process.execPath],
					}),
				).rejects.toThrow("漂移");
			} finally {
				await otherPort.close();
			}
		},
	);
});
