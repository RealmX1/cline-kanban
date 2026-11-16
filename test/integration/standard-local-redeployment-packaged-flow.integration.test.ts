import { spawn } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
	cancelOwnedCommandProcesses,
	inspectOwnedCommandSupervisor,
} from "../../src/task-command-execution/task-command-execution-supervisor";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { createIsolatedTestOwnedTmuxServer } from "../utilities/isolated-test-owned-tmux-server";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

describe("标准重部署打包入口全程隔离验收", { timeout: 180_000 }, () => {
	const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
	afterEach(() => children.sigkillEveryStillRunningChildProcessAndWaitForExit());
	it("从真实离线起点构建、保全、发布、启动及登记；同请求重复启动不重复副作用", async (testContext) => {
		const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
		const outputRoot = join(repositoryRoot, "test-results", "standard-redeployment");
		await mkdir(outputRoot, { recursive: true });
		const fixture = createIsolatedGitTestWorkspaceFixture({
			fixtureRootDirectoryNamePrefix: "rd-",
			fixtureRootParentDirectoryPath: outputRoot,
		});
		const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "source" });
		const executionDirectory = join(fixture.fixtureRootDirectoryPath, "persistent-redeployment-artifacts");
		let cleanupSupervisorReference: { workspaceId: string; executionId: string; launchNonce: string } | null = null;
		let cleanupSupervisorArtifactDirectory: string | null = null;
		await mkdir(executionDirectory);
		const socketDirectory = await mkdtemp("/tmp/kanban-redeployment-test-sockets-");
		const binaryDirectory = join(fixture.fixtureRootDirectoryPath, "bin");
		await mkdir(binaryDirectory);
		const node = join(binaryDirectory, "node");
		await copyFile(process.execPath, node);
		const npm = await realpath(join(dirname(process.execPath), "npm"));
		await symlink(npm, join(binaryDirectory, "npm"));
		const executable = join(executionDirectory, "compiled-deployment-executor.mjs");
		await build({
			entryPoints: [join(repositoryRoot, "src/deployment/local-deployment-execution-command-line.ts")],
			outfile: executable,
			bundle: true,
			platform: "node",
			format: "esm",
			target: "node22",
			external: ["better-sqlite3", "node-pty", "@napi-rs/keyring", "sharp"],
			banner: {
				js: 'import { createRequire as bundledRequire } from "node:module"; const require = bundledRequire(import.meta.url);',
			},
			logLevel: "silent",
		});
		const deploymentCli = join(repository.repositoryPath, "deployment-cli-for-fixture.mjs");
		await build({
			stdin: {
				contents: `import { Command } from 'commander';
import { registerDeploymentCommand } from './src/commands/deployment';
import { loadWorkspaceContext } from './src/state/workspace-state';
if (process.argv[2] === 'register-isolated-project') {
process.stdout.write(JSON.stringify(await loadWorkspaceContext(process.argv[3])));
} else {
const program = new Command(); registerDeploymentCommand(program); await program.parseAsync(process.argv);
}`,
				resolveDir: repositoryRoot,
				loader: "ts",
			},
			outfile: deploymentCli,
			bundle: true,
			platform: "node",
			format: "esm",
			target: "node22",
			external: ["better-sqlite3", "node-pty", "@napi-rs/keyring", "sharp"],
			banner: {
				js: 'import { createRequire as bundledRequire } from "node:module"; const require = bundledRequire(import.meta.url);',
			},
			logLevel: "silent",
		});
		for (const dependency of ["better-sqlite3", "bindings", "file-uri-to-path"])
			await cp(
				await realpath(join(repositoryRoot, "node_modules", dependency)),
				join(repository.repositoryPath, "node_modules", dependency),
				{ recursive: true, dereference: true },
			);
		await mkdir(join(repository.repositoryPath, "scripts"));
		await mkdir(join(repository.repositoryPath, "web-ui"));
		await mkdir(join(repository.repositoryPath, ".codex/skills/cline-kanban-local-deploy/scripts"), {
			recursive: true,
		});
		await copyFile(
			join(
				repositoryRoot,
				".codex/skills/cline-kanban-local-deploy/scripts/prepare-source-validation-with-evidence-reuse.mjs",
			),
			join(
				repository.repositoryPath,
				".codex/skills/cline-kanban-local-deploy/scripts/prepare-source-validation-with-evidence-reuse.mjs",
			),
		);
		await copyFile(
			join(repositoryRoot, "scripts/promote-staged-kanban-build-output-into-distribution-directory.mjs"),
			join(repository.repositoryPath, "scripts/promote-staged-kanban-build-output-into-distribution-directory.mjs"),
		);
		await copyFile(executable, join(repository.repositoryPath, "executor-for-fixture.mjs"));
		await writeFile(
			join(repository.repositoryPath, ".gitignore"),
			"node_modules/\nweb-ui/node_modules/\ndist/\nweb-ui/dist/\n",
		);
		const packageJson = {
			name: "kanban",
			version: "0.0.0",
			type: "module",
			bin: { kanban: "dist/cli.js" },
			scripts: {
				typecheck: "node --check fixture-cli.mjs",
				"web:typecheck": "node --check fixture-cli.mjs",
				test: "node --check fixture-cli.mjs",
				"web:test": "node --check fixture-cli.mjs",
				lint: "node --check fixture-cli.mjs",
				build: "node fixture-build.mjs",
			},
		};
		await writeFile(join(repository.repositoryPath, "package.json"), JSON.stringify(packageJson));
		await writeFile(
			join(repository.repositoryPath, "package-lock.json"),
			JSON.stringify({ name: "kanban", version: "0.0.0", lockfileVersion: 3, packages: { "": packageJson } }),
		);
		await writeFile(
			join(repository.repositoryPath, "web-ui/package.json"),
			JSON.stringify({ name: "fixture-web", version: "0.0.0" }),
		);
		await writeFile(
			join(repository.repositoryPath, "web-ui/package-lock.json"),
			JSON.stringify({
				name: "fixture-web",
				version: "0.0.0",
				lockfileVersion: 3,
				packages: { "": { name: "fixture-web", version: "0.0.0" } },
			}),
		);
		await writeFile(
			join(repository.repositoryPath, "fixture-build.mjs"),
			`import {mkdir,copyFile,writeFile} from 'node:fs/promises'; const destination=process.env.KANBAN_BUILD_DISTRIBUTION_OUTPUT_DIRECTORY; if(!destination)throw new Error('缺少隔离构建输出'); await mkdir(destination,{recursive:true}); await copyFile('fixture-cli.mjs',destination+'/cli.js'); await copyFile('deployment-cli-for-fixture.mjs',destination+'/deployment-cli-for-fixture.mjs'); await copyFile('executor-for-fixture.mjs',destination+'/local-deployment-execution.js'); await mkdir(destination+'/web-ui',{recursive:true}); await writeFile(destination+'/web-ui/index.html','<html>隔离候选</html>');`,
		);
		await writeFile(
			join(repository.repositoryPath, "scripts/verify-notification-archive-native-runtime.mjs"),
			"process.stdout.write('隔离 ABI 夹具通过\\n');",
		);
		await writeFile(
			join(repository.repositoryPath, "scripts/verify-agent-session-pty-host-runtime-readiness.mjs"),
			`const response=await fetch('http://127.0.0.1:'+process.env.KANBAN_RUNTIME_PORT+'/api/trpc/runtime.getAgentSessionPtyHostDiagnostics'); const data=(await response.json()).result.data; process.stdout.write(JSON.stringify({...data,ok:true,validatedHostedSessions:[],failures:[]}));`,
		);
		await writeFile(
			join(repository.repositoryPath, "fixture-cli.mjs"),
			`#!/usr/bin/env node
import {createServer} from 'node:http'; import {execFileSync} from 'node:child_process'; import {readFileSync,appendFileSync} from 'node:fs'; import {createHash} from 'node:crypto'; import {join} from 'node:path'; import {homedir} from 'node:os';
const runtimeHome=join(homedir(),'.cline/kanban'); const args=process.argv.slice(2);
if(args[0]==='serve') { const loaded=createHash('sha256').update(readFileSync(process.argv[1])).digest('hex'); const start=execFileSync('ps',['-p',String(process.pid),'-o','lstart='],{encoding:'utf8',env:{...process.env,LC_ALL:'C'}}).trim();
createServer((request,response)=>{response.setHeader('content-type','application/json'); const procedure=request.url.split('?')[0].split('/').pop(); let data;
if(procedure==='runtime.getAgentSessionPtyHostDiagnostics') data={runtimeIdentity:{runtimeHomeDirectoryPath:runtimeHome,runtimePort:Number(process.env.KANBAN_RUNTIME_PORT)},runtimeProcessId:process.pid,runtimeProcessStartTimeText:start,runtimeLoadedEntrypointSha256:loaded};
else if(procedure==='notificationIntelligence.listArchive') data={entries:[],totalCount:0,nextBeforeSequence:null}; else if(procedure==='runtime.getConfig')data={detectedCommands:['node']}; else {response.setHeader('content-type','text/html');response.end('<html>隔离服务</html>');return;}response.end(JSON.stringify({result:{data}}));}).listen(Number(process.env.KANBAN_RUNTIME_PORT),'127.0.0.1');
} else if(args[0]==='deployment'&&args[1]==='record') {const directory=args[args.indexOf('--execution-directory')+1];const receipt=execFileSync(process.execPath,[join(import.meta.dirname,'deployment-cli-for-fixture.mjs'),...args],{encoding:'utf8',env:process.env});appendFileSync(join(directory,'registration-invocations.txt'),'once');process.stdout.write(receipt);}
`,
		);
		const commit = repository.commitAllRepositoryFilesAtDate({
			message: "标准重部署隔离夹具",
			authorAndCommitterIsoDate: "2026-11-13T00:00:00Z",
		});
		await mkdir(join(repository.repositoryPath, "dist"));
		await writeFile(join(repository.repositoryPath, "dist/cli.js"), "旧版隔离入口");
		const runtimeHome = join(fixture.isolatedHomeDirectoryPath, ".cline/kanban");
		await mkdir(runtimeHome, { recursive: true });
		await writeFile(join(runtimeHome, "config.json"), JSON.stringify({ retained: true }));
		const server = createServer();
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("未取得隔离端口");
		const port = address.port;
		await new Promise<void>((resolve) => server.close(() => resolve()));
		const sessionName = `vrf-redeployment-${port}`;
		const runner = join(fixture.fixtureRootDirectoryPath, "service-runner.mjs");
		await writeFile(
			runner,
			`import {spawn} from 'node:child_process'; const child=spawn(process.env.KANBAN_3484_SERVICE_NODE_EXECUTABLE,[process.env.KANBAN_3484_SERVICE_CLI_ENTRYPOINT,'serve'],{stdio:'inherit',env:process.env});for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));child.on('exit',code=>{process.exitCode=code??1;});`,
		);
		const environment = fixture.createIsolatedChildProcessEnvironment({
			PATH: `${binaryDirectory}:${process.env.PATH}`,
			npm_config_prefix: fixture.fixtureRootDirectoryPath,
			CODEX_HOME: join(fixture.isolatedHomeDirectoryPath, ".codex"),
			CODEX_SQLITE_HOME: join(fixture.isolatedHomeDirectoryPath, ".codex"),
			TMUX_TMPDIR: socketDirectory,
			KANBAN_TASK_ID: "",
			KANBAN_TASK_CONVERSATION_SESSION_ID: "",
		});
		delete environment.TMUX;
		delete environment.TMUX_PANE;
		const isolatedTestOwnedTmuxServer = createIsolatedTestOwnedTmuxServer({
			...environment,
			KANBAN_3484_SERVICE_NODE_EXECUTABLE: node,
			KANBAN_3484_SERVICE_CLI_ENTRYPOINT: join(repository.repositoryPath, "dist/cli.js"),
			KANBAN_3484_SERVICE_REPOSITORY_DIRECTORY: repository.repositoryPath,
			KANBAN_3484_SERVICE_RUNTIME_PORT: String(port),
			KANBAN_RUNTIME_HOST: "127.0.0.1",
			KANBAN_RUNTIME_PORT: String(port),
		});
		onTestFinished(() => isolatedTestOwnedTmuxServer.cleanup());
		const defaultTmuxSocketDirectory = join(socketDirectory, `tmux-${process.getuid?.()}`);
		await mkdir(defaultTmuxSocketDirectory, { mode: 0o700 });
		// 生产入口的默认 socket 只指向 fixture 已核验归属的私有 server。
		await symlink(isolatedTestOwnedTmuxServer.socketPath, join(defaultTmuxSocketDirectory, "default"));
		async function invokePackagedCommand(entrypoint: string, commandArguments: string[]) {
			const child = children.register(
				spawn(node, [entrypoint, ...commandArguments], {
					cwd: repository.repositoryPath,
					env: environment,
					stdio: ["ignore", "pipe", "pipe"],
				}),
			);
			let stdout = "";
			let stderr = "";
			child.stdout?.on("data", (chunk) => {
				stdout += chunk.toString();
			});
			child.stderr?.on("data", (chunk) => {
				stderr += chunk.toString();
			});
			await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(testContext, child, {
				waitedForDescription: "等待标准重部署子进程退出",
				softDeadlineMsExpectedOnUncontendedHost: 45_000,
				hardDeadlineMsOnlyExplainedByRealHangOrRegression: 90_000,
			});
			return { code: child.exitCode, stdout, stderr };
		}
		async function invoke(command: string, additionalArguments: string[] = []) {
			return invokePackagedCommand(executable, [
				command,
				"--execution-directory",
				executionDirectory,
				...additionalArguments,
			]);
		}
		try {
			const registered = await invokePackagedCommand(deploymentCli, [
				"register-isolated-project",
				repository.repositoryPath,
			]);
			expect(registered.code, registered.stdout + registered.stderr).toBe(0);
			const workspaceId = (JSON.parse(registered.stdout) as { workspaceId: string }).workspaceId;
			const requestFile = join(executionDirectory, "request.json");
			await writeFile(
				requestFile,
				JSON.stringify({
					schemaVersion: 1,
					executionId: "032609d8-7508-4bdc-b202-1d7bd7da8a14",
					workspaceId,
					taskId: "external-caller",
					originatingTaskWorktreePath: repository.repositoryPath,
					sourceCheckoutPath: repository.repositoryPath,
					candidateSourceCommit: commit,
					deploymentNodeBinaryPath: node,
					distributionDirectoryPath: join(repository.repositoryPath, "dist"),
					runtimeIdentity: { runtimeHomeDirectoryPath: runtimeHome, runtimeHost: "127.0.0.1", runtimePort: port },
					serviceLaunch: { command: [node, runner], tmuxSessionName: sessionName },
					authorization: {
						sourceReference: "test:isolated-standard-flow",
						userRequestQuote: "只部署隔离夹具，不修改真实运行实例",
					},
				}),
			);
			const prepared = await invoke("prepare-redeployment", ["--request-file", requestFile]);
			expect(prepared.code, prepared.stdout + prepared.stderr).toBe(0);
			expect(await readFile(join(repository.repositoryPath, "dist/cli.js"), "utf8")).toBe("旧版隔离入口");
			const executed = await invoke("start-redeployment");
			expect(executed.code, executed.stdout + executed.stderr).toBe(0);
			await vi.waitFor(
				async () =>
					expect(
						JSON.parse(await readFile(join(executionDirectory, "owned-command-business-result.json"), "utf8"))
							.analysis?.deploymentOutcome,
					).toBe("succeeded"),
				{ timeout: 60_000, interval: 200 },
			);
			const sourceValidationPlan = JSON.parse(
				await readFile(join(executionDirectory, "frozen-source-validation-plan.json"), "utf8"),
			) as { commands: Array<{ name: string; argv: string[] }> };
			expect(sourceValidationPlan.commands.map((command) => command.argv.slice(-2))).toEqual([
				["run", "typecheck"],
				["run", "web:typecheck"],
				["run", "test"],
				["run", "web:test"],
				["run", "lint"],
			]);
			const reference = JSON.parse(
				await readFile(join(executionDirectory, "independent-redeployment-supervisor-reference.json"), "utf8"),
			);
			cleanupSupervisorReference = {
				workspaceId: "isolated",
				executionId: reference.executionId,
				launchNonce: reference.launchNonce,
			};
			cleanupSupervisorArtifactDirectory = join(
				runtimeHome,
				"workspaces/isolated/task-command-executions",
				reference.executionId,
				"post-process-exit-cleanup",
				reference.launchNonce,
				"dispatch-1",
			);
			await vi.waitFor(
				async () =>
					expect(
						JSON.parse(
							await readFile(
								join(
									runtimeHome,
									`workspaces/${workspaceId}/task-command-executions`,
									reference.executionId,
									`supervisor-progress-${reference.launchNonce}.json`,
								),
								"utf8",
							),
						).status,
					).toBe("exited"),
				{ timeout: 15_000 },
			);
			const repeated = await invoke("start-redeployment");
			expect(repeated.code, repeated.stdout + repeated.stderr).toBe(0);
			expect(await readFile(join(executionDirectory, "registration-invocations.txt"), "utf8")).toBe("once");
			const awaitedCleanupSupervisorReference = cleanupSupervisorReference;
			const awaitedCleanupSupervisorArtifactDirectory = cleanupSupervisorArtifactDirectory;
			await vi.waitFor(
				async () =>
					expect(
						await inspectOwnedCommandSupervisor(awaitedCleanupSupervisorReference, {
							artifactDirectory: awaitedCleanupSupervisorArtifactDirectory,
						}),
					).toBe("exited"),
				{ timeout: 15_000 },
			);
			const receiptPath = join(executionDirectory, "deployment-record-receipt.json");
			const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
			expect(receipt.workspaceId).toBe(workspaceId);
			expect(receipt.workspacePath).toBe(repository.repositoryPath);
			expect(receipt.sourceCheckoutPath).toBe(join(executionDirectory, "candidate-source-checkout"));
			const markerPath = join(runtimeHome, "last-deployed-source-commit.json");
			const marker = await readFile(markerPath, "utf8");
			const verificationStatePath = join(runtimeHome, "post-deploy-verification-state.json");
			const verificationState = await readFile(verificationStatePath, "utf8");
			const recovered = await invoke("recover-deployment-record");
			expect(recovered.code, recovered.stdout + recovered.stderr).toBe(0);
			expect(JSON.parse(await readFile(receiptPath, "utf8"))).toEqual(receipt);
			// 模拟正式建组已接受、回执原件尚未落盘的中断；恢复不能重算历史统计或另建组。
			await rm(receiptPath);
			const recoveredWithoutReceipt = await invoke("recover-deployment-record");
			expect(recoveredWithoutReceipt.code, recoveredWithoutReceipt.stdout + recoveredWithoutReceipt.stderr).toBe(0);
			expect(JSON.parse(await readFile(receiptPath, "utf8"))).toMatchObject({
				deploymentId: receipt.deploymentId,
				workspaceId,
				deployedSourceCommit: commit,
				registrationReceiptRecoveredFromPersistedGroup: true,
				originalRegistrationStatistics: null,
			});
			expect(await readFile(markerPath, "utf8")).toBe(marker);
			expect(await readFile(verificationStatePath, "utf8")).toBe(verificationState);
			expect(JSON.parse(verificationState).deploymentGroups).toHaveLength(1);
			const standardCommandOriginals = await readdir(join(executionDirectory, "standard-command-originals"));
			expect(standardCommandOriginals.filter((name) => name.startsWith("promote-bound-candidate-"))).toHaveLength(1);
			expect(
				standardCommandOriginals.filter((name) => name.startsWith("start-bound-service-in-new-tmux-window-")),
			).toHaveLength(1);
			expect(
				JSON.parse(await readFile(join(executionDirectory, "owned-command-business-result.json"), "utf8"))
					.disposition,
			).toBe("agent_review_ready");
			expect(await readFile(join(executionDirectory, "preserved-runtime-state/config.json"), "utf8")).toContain(
				"retained",
			);
		} catch (error) {
			const failureEvidenceDirectory = await mkdtemp(join(outputRoot, "retained-failure-evidence-"));
			try {
				await cp(executionDirectory, join(failureEvidenceDirectory, "redeployment-execution"), {
					recursive: true,
					filter: (source) => source !== join(executionDirectory, "candidate-source-checkout"),
				});
				await cp(join(runtimeHome, "workspaces"), join(failureEvidenceDirectory, "runtime-workspaces"), {
					recursive: true,
					filter: (source) => !source.endsWith(".pending"),
				});
			} catch (captureError) {
				await writeFile(join(failureEvidenceDirectory, "evidence-capture-error.txt"), String(captureError));
			}
			throw new Error(`标准重部署隔离验收失败，阶段与监督原件：${failureEvidenceDirectory}`, { cause: error });
		} finally {
			isolatedTestOwnedTmuxServer.cleanup();
			await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
			if (cleanupSupervisorReference && cleanupSupervisorArtifactDirectory) {
				const reference = cleanupSupervisorReference;
				const artifactDirectory = cleanupSupervisorArtifactDirectory;
				await cancelOwnedCommandProcesses(
					{
						...reference,
						previousLaunchNonces: [],
						revocationFile: join(artifactDirectory, "cleanup-revocation.json"),
						specification: { workingDirectory: executionDirectory, cancelCommand: undefined },
					},
					{ artifactDirectory, skipProducerCancelCommand: true },
				);
				await vi.waitFor(
					async () =>
						expect(["exited", "not_started"]).toContain(
							await inspectOwnedCommandSupervisor(reference, { artifactDirectory }),
						),
					{ timeout: 15_000 },
				);
			}
			await rm(executionDirectory, { recursive: true, force: true });
			fixture.cleanup();
			await rm(socketDirectory, { recursive: true, force: true });
		}
	});
});
