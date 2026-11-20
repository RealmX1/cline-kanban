import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	chmod,
	copyFile,
	cp,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { LOCAL_REDEPLOYMENT_SOURCE_VALIDATION_PREPARER_FILENAME } from "../../src/deployment/local-redeployment-preparation";
import {
	cancelOwnedCommandProcesses,
	hasSameProcessGeneration,
	inspectOwnedCommandSupervisor,
	readProcessIdentity,
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
	it.for([false, true])("隔离部署与分支修复接续=%s", async (repairAfterQualityFailure, testContext) => {
		const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
		const outputRoot = join(repositoryRoot, "test-results", "standard-redeployment");
		await mkdir(outputRoot, { recursive: true });
		const fixture = createIsolatedGitTestWorkspaceFixture({
			fixtureRootDirectoryNamePrefix: "rd-",
			fixtureRootParentDirectoryPath: outputRoot,
		});
		const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "source" });
		let executionDirectory = join(fixture.fixtureRootDirectoryPath, "persistent-redeployment-artifacts");
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
		await copyFile(
			join(
				repositoryRoot,
				".codex/skills/cline-kanban-local-deploy/scripts/prepare-source-validation-with-evidence-reuse.mjs",
			),
			join(executionDirectory, LOCAL_REDEPLOYMENT_SOURCE_VALIDATION_PREPARER_FILENAME),
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
				test: repairAfterQualityFailure ? "node fixture-source-validation.mjs" : "node --check fixture-cli.mjs",
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
			`const response=await fetch('http://127.0.0.1:'+process.env.KANBAN_RUNTIME_PORT+'/api/trpc/runtime.getAgentSessionPtyHostDiagnostics'); const data=(await response.json()).result.data; const blocked=process.argv.includes('--before-runtime-restart')&&data.fixtureContinuityBlocked; process.stdout.write(JSON.stringify({...data,ok:!blocked,validatedHostedSessions:[],blockingSessions:blocked?[{conversationSessionId:'active-fixture-session'}]:[],failures:blocked?['等待隔离会话自然退出']:[]})); process.exitCode=blocked?2:0;`,
		);
		await writeFile(
			join(repository.repositoryPath, "fixture-cli.mjs"),
			`#!/usr/bin/env node
import {createServer} from 'node:http'; import {execFileSync} from 'node:child_process'; import {readFileSync,appendFileSync,existsSync,unlinkSync} from 'node:fs'; import {createHash} from 'node:crypto'; import {join} from 'node:path'; import {homedir} from 'node:os';
const runtimeHome=join(homedir(),'.cline/kanban'); const args=process.argv.slice(2);
if(args[0]==='serve') { const loaded=createHash('sha256').update(readFileSync(process.argv[1])).digest('hex'); const start=execFileSync('ps',['-p',String(process.pid),'-o','lstart='],{encoding:'utf8',env:{...process.env,LC_ALL:'C'}}).trim();
const server=createServer((request,response)=>{response.setHeader('content-type','application/json'); const procedure=request.url.split('?')[0].split('/').pop(); let data;
if(procedure==='fixture-shutdown'&&request.method==='POST'){response.end(JSON.stringify({ok:true})); server.close(); server.closeAllConnections();return;}
if(procedure==='runtime.getAgentSessionPtyHostDiagnostics') data={runtimeIdentity:{runtimeHomeDirectoryPath:runtimeHome,runtimePort:Number(process.env.KANBAN_RUNTIME_PORT)},runtimeProcessId:process.pid,runtimeProcessStartTimeText:start,runtimeLoadedEntrypointSha256:loaded,fixtureContinuityBlocked:existsSync(join(runtimeHome,'fixture-blocking-session'))};
else if(procedure==='notificationIntelligence.listArchive') data={entries:[],totalCount:0,nextBeforeSequence:null}; else if(procedure==='runtime.getConfig')data={detectedCommands:['node']}; else {response.setHeader('content-type','text/html');response.end('<html>隔离服务</html>');return;}response.end(JSON.stringify({result:{data}}));}).listen(Number(process.env.KANBAN_RUNTIME_PORT),'127.0.0.1');
} else if(args[0]==='runtime'&&args[1]==='handover-restart') {
const response=await fetch('http://127.0.0.1:'+process.env.KANBAN_RUNTIME_PORT+'/fixture-shutdown',{method:'POST'});
if(!(await response.json()).ok) throw new Error('隔离服务未接受交接');
} else if(args[0]==='deployment'&&args[1]==='record') {
const directory=args[args.indexOf('--execution-directory')+1];
const receipt=execFileSync(process.execPath,[join(import.meta.dirname,'deployment-cli-for-fixture.mjs'),...args],{encoding:'utf8',env:process.env});
const interruptAfterRegistration=join(directory,'fixture-interrupt-after-registration');
if(existsSync(interruptAfterRegistration)){unlinkSync(interruptAfterRegistration);unlinkSync(join(directory,'deployment-record-receipt.json'));process.exitCode=75;}
else {appendFileSync(join(directory,'registration-invocations.txt'),'once');process.stdout.write(receipt);}
}
`,
		);
		if (repairAfterQualityFailure)
			await writeFile(join(repository.repositoryPath, "fixture-source-validation.mjs"), "process.exitCode = 1;\n");
		let commit = repository.commitAllRepositoryFilesAtDate({
			message: "标准重部署隔离夹具",
			authorAndCommitterIsoDate: "2026-11-13T00:00:00Z",
		});
		await mkdir(join(repository.repositoryPath, "dist"));
		await writeFile(join(repository.repositoryPath, "dist/cli.js"), "旧版隔离入口");
		const runtimeHome = join(fixture.isolatedHomeDirectoryPath, ".cline/kanban");
		await mkdir(runtimeHome, { recursive: true });
		await writeFile(join(runtimeHome, "config.json"), JSON.stringify({ retained: true }));
		const blockingSessionPath = join(runtimeHome, "fixture-blocking-session");
		const unavailableBackupEntry = join(runtimeHome, "a-temporarily-unreadable.json");
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
					runtimeIdentity: {
						runtimeHomeDirectoryPath: runtimeHome,
						runtimeHost: "127.0.0.1",
						runtimePort: port,
					},
					serviceLaunch: { command: [node, runner], tmuxSessionName: sessionName },
					authorization: {
						sourceReference: "test:isolated-standard-flow",
						userRequestQuote: "只部署隔离夹具，不修改真实运行实例",
					},
				}),
			);
			const prepared = await invoke("prepare-redeployment", ["--request-file", requestFile]);
			expect(prepared.code, prepared.stdout + prepared.stderr).toBe(0);
			const preparedAnalysis = await invokePackagedCommand(deploymentCli, [
				"deployment",
				"analyze",
				"--execution-directory",
				executionDirectory,
			]);
			expect(JSON.parse(preparedAnalysis.stdout).executions[0].deploymentOutcome).toBe("prepared");
			expect(await readFile(join(repository.repositoryPath, "dist/cli.js"), "utf8")).toBe("旧版隔离入口");
			if (repairAfterQualityFailure) {
				const failedDirectory = executionDirectory;
				const startedFailure = await invoke("start-redeployment");
				expect(startedFailure.code, startedFailure.stdout + startedFailure.stderr).toBe(0);
				await vi.waitFor(
					async () =>
						expect(
							JSON.parse(await readFile(join(failedDirectory, "owned-command-business-result.json"), "utf8"))
								.disposition,
						).toBe("agent_review_ready"),
					{ timeout: 60_000 },
				);
				const failedResult = await readFile(join(failedDirectory, "owned-command-business-result.json"), "utf8");
				expect(JSON.parse(failedResult).error).toContain("源码验证真实失败");
				expect(await readFile(join(repository.repositoryPath, "dist/cli.js"), "utf8")).toBe("旧版隔离入口");
				const failedReference = JSON.parse(
					await readFile(join(failedDirectory, "independent-redeployment-supervisor-reference.json"), "utf8"),
				);
				await vi.waitFor(
					async () =>
						expect(
							await inspectOwnedCommandSupervisor(
								{
									workspaceId,
									executionId: failedReference.executionId,
									launchNonce: failedReference.launchNonce,
								},
								{
									artifactDirectory: join(
										runtimeHome,
										"workspaces",
										workspaceId,
										"task-command-executions",
										failedReference.executionId,
									),
								},
							),
						).toBe("exited"),
					{ timeout: 15_000 },
				);
				const repairBranch = "deployment-repair/external-caller-fixture";
				repository.runGit(["branch", repairBranch]);
				repository.runGit(["switch", repairBranch]);
				await writeFile(
					join(repository.repositoryPath, "fixture-source-validation.mjs"),
					"process.stdout.write('隔离源码修复验证通过\\n');\n",
				);
				commit = repository.commitAllRepositoryFilesAtDate({
					message: "修复隔离部署验证",
					authorAndCommitterIsoDate: "2026-11-13T00:01:00Z",
				});
				const originalRequest = JSON.parse(
					await readFile(join(failedDirectory, "frozen-redeployment-request.json"), "utf8"),
				).request;
				executionDirectory = join(fixture.fixtureRootDirectoryPath, "repaired-deployment-artifacts");
				await mkdir(executionDirectory);
				const repairedRequestFile = join(executionDirectory, "request.json");
				await writeFile(
					repairedRequestFile,
					JSON.stringify({ ...originalRequest, executionId: randomUUID(), candidateSourceCommit: commit }),
				);
				const repairedPreparation = await invoke("prepare-redeployment", [
					"--request-file",
					repairedRequestFile,
					"--repair-of-execution-directory",
					failedDirectory,
					"--deployment-branch",
					repairBranch,
				]);
				expect(repairedPreparation.code, repairedPreparation.stdout + repairedPreparation.stderr).toBe(0);
				expect(JSON.parse(repairedPreparation.stdout).repairContinuation.repairAttemptNumber).toBe(1);
				expect(await readFile(join(failedDirectory, "owned-command-business-result.json"), "utf8")).toBe(
					failedResult,
				);
			}
			if (!repairAfterQualityFailure) {
				const previousCli = join(repository.repositoryPath, "dist/cli.js");
				await writeFile(
					previousCli,
					(await readFile(join(repository.repositoryPath, "fixture-cli.mjs"), "utf8")) + "\n// 原实例入口\n",
				);
				await writeFile(blockingSessionPath, "等待自然退出");
				await writeFile(join(executionDirectory, "fixture-interrupt-after-registration"), "模拟登记回执写入中断");
				if (process.getuid?.() !== 0) {
					await writeFile(unavailableBackupEntry, "{}");
					await chmod(unavailableBackupEntry, 0o000);
				}
				children.register(
					spawn(node, [previousCli, "serve"], {
						env: { ...environment, KANBAN_RUNTIME_PORT: String(port) },
						stdio: "ignore",
					}),
				);
				await vi.waitFor(
					async () => {
						expect(
							(await fetch("http://127.0.0.1:" + port + "/api/trpc/runtime.getAgentSessionPtyHostDiagnostics"))
								.ok,
						).toBe(true);
					},
					{ timeout: 10_000 },
				);
			}
			const executed = await invoke("start-redeployment");
			expect(executed.code, executed.stdout + executed.stderr).toBe(0);
			if (!repairAfterQualityFailure) {
				const continuityPath = join(executionDirectory, "session-continuity-preflight.json");
				await vi.waitFor(
					async () => {
						expect(JSON.parse(await readFile(continuityPath, "utf8"))).toMatchObject({
							status: "blocked",
							blockingSessions: [{ conversationSessionId: "active-fixture-session" }],
						});
						await readFile(join(executionDirectory, "candidate-build-receipt.json"));
					},
					{ timeout: 45_000 },
				);
				const blockedAnalysis = await invokePackagedCommand(deploymentCli, [
					"deployment",
					"analyze",
					"--execution-directory",
					executionDirectory,
				]);
				expect(JSON.parse(blockedAnalysis.stdout).executions[0]).toMatchObject({
					operationalProgress: {
						sessionContinuityPreflight: { status: "blocked", recoveryCondition: expect.any(String) },
						sourceValidation: {
							reusedSourceValidationCheckCount: 0,
							executedMissingSourceValidationCheckCount: 5,
						},
					},
				});
				await expect(
					readFile(join(executionDirectory, "runtime-state-backup-progress.json")),
				).rejects.toMatchObject({ code: "ENOENT" });
				const originalSupervisor = JSON.parse(
					await readFile(join(executionDirectory, "independent-redeployment-supervisor-reference.json"), "utf8"),
				);
				const supervisorDirectory = join(
					runtimeHome,
					"workspaces",
					workspaceId,
					"task-command-executions",
					originalSupervisor.executionId,
				);
				const inspectOriginalSupervisor = () =>
					inspectOwnedCommandSupervisor(originalSupervisor, { artifactDirectory: supervisorDirectory });
				await vi.waitFor(
					async () => {
						const progress = JSON.parse(
							await readFile(
								join(supervisorDirectory, `supervisor-progress-${originalSupervisor.launchNonce}.json`),
								"utf8",
							),
						);
						expect(progress).toMatchObject({ status: "machine_evidence_pending", ownedProcesses: [] });
					},
					{ timeout: 20_000 },
				);
				const supervisorIdentity = JSON.parse(
					await readFile(
						join(supervisorDirectory, `supervisor-identity-${originalSupervisor.launchNonce}.json`),
						"utf8",
					),
				);
				expect(await inspectOriginalSupervisor()).toBe("running");
				expect(supervisorIdentity.launchNonce).toBe(originalSupervisor.launchNonce);
				const currentSupervisor = await readProcessIdentity(supervisorIdentity.pid);
				expect(hasSameProcessGeneration(currentSupervisor, supervisorIdentity)).toBe(true);
				expect(currentSupervisor?.startAndCommand).toContain(supervisorDirectory);
				process.kill(supervisorIdentity.pid, "SIGKILL");
				await vi.waitFor(async () => expect(await inspectOriginalSupervisor()).toBe("exited"), { timeout: 10_000 });
				const resumed = await invoke("start-redeployment");
				expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0);
				expect(JSON.parse(resumed.stdout)).toMatchObject({
					executionId: originalSupervisor.executionId,
					launchAttemptCount: 2,
				});
				await rm(blockingSessionPath);
				if (process.getuid?.() !== 0) {
					await vi.waitFor(
						async () => {
							const progress = JSON.parse(
								await readFile(join(executionDirectory, "runtime-state-backup-progress.json"), "utf8"),
							);
							expect(progress.pendingEntries).toContainEqual(
								expect.objectContaining({ entryName: "a-temporarily-unreadable.json" }),
							);
							await readFile(join(executionDirectory, "preserved-runtime-state/config.json"));
						},
						{ timeout: 55_000 },
					);
					await chmod(unavailableBackupEntry, 0o600);
				}
			}
			await vi.waitFor(
				async () =>
					expect(
						JSON.parse(await readFile(join(executionDirectory, "owned-command-business-result.json"), "utf8"))
							.analysis?.deploymentOutcome,
					).toBe("succeeded"),
				{ timeout: 100_000, interval: 200 },
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
				workspaceId,
				executionId: reference.executionId,
				launchNonce: reference.launchNonce,
			};
			cleanupSupervisorArtifactDirectory = join(
				runtimeHome,
				`workspaces/${workspaceId}/task-command-executions`,
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
			expect(standardCommandOriginals.filter((name) => name.startsWith("production-build-"))).toHaveLength(1);
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
