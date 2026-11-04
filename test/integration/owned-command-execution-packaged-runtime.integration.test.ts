import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { createTRPCProxyClient, httpLink } from "@trpc/client";
import { afterEach, expect, it } from "vitest";
import { runtimeTaskSessionSummarySchema } from "../../src/core/api-contract";
import type { RuntimeAppRouter } from "../../src/trpc/app-router";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import {
	computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts,
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForChildProcessExit,
	waitForRuntimeServerStartupBannerOrSigkillChild,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(() => children.sigkillEveryStillRunningChildProcessAndWaitForExit());
const cli = process.env.KANBAN_OWNED_COMMAND_PACKAGED_CLI_PATH;

it.skipIf(!cli)(
	"打包 CLI 经真实 runtime 托管、幂等、取消，并跨重启保留撤销",
	{
		timeout: computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts({
			runtimeColdStartCount: 2,
			testBodyTimeoutBudgetMs: 120_000,
		}),
	},
	async () => {
		if (!cli) throw new Error("需要本任务的隔离构建 CLI");
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const project = fixture.createNonBareRepository({ repositoryDirectoryName: "owned-command-project" });
		writeFileSync(join(project.repositoryPath, "README.md"), "所属执行隔离验证\n");
		project.commitAllRepositoryFilesAtDate({
			message: "初始化隔离项目",
			authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
		});
		const reservation = createServer();
		await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done));
		const address = reservation.address();
		if (!address || typeof address === "string") throw new Error("未取得隔离端口");
		const port = address.port;
		await new Promise<void>((done) => reservation.close(() => done()));
		expect(port).not.toBe(3484);
		const environment = fixture.createIsolatedChildProcessEnvironment();
		for (const key of Object.keys(environment))
			if (/^(KANBAN_|RVF_|ANTHROPIC_|OPENAI_|CLAUDE_|CODEX_|CURSOR_|GEMINI_|GOOGLE_|KIMI_)/u.test(key))
				delete environment[key];
		Object.assign(environment, {
			PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
			KANBAN_RUNTIME_PORT: String(port),
			CODEX_HOME: join(fixture.isolatedHomeDirectoryPath, ".codex"),
			CODEX_SQLITE_HOME: join(fixture.isolatedHomeDirectoryPath, ".codex-sqlite"),
			RVF_USER_LOCAL_DATA_ROOT: join(fixture.isolatedHomeDirectoryPath, ".rvf/user-local-data"),
		});
		const shutdownHook = resolve(import.meta.dirname, "shutdown-ipc-hook.cjs");
		const artifacts = process.env.KANBAN_OWNED_COMMAND_EVIDENCE_DIRECTORY ?? fixture.fixtureRootDirectoryPath;
		mkdirSync(artifacts, { recursive: true });
		const runCli = async (arguments_: string[]) => {
			const child = children.register(
				spawn(process.execPath, [cli, ...arguments_], {
					cwd: project.repositoryPath,
					env: environment,
					stdio: ["ignore", "pipe", "pipe"],
				}),
			);
			let stdout = "";
			let stderr = "";
			child.stdout?.on("data", (chunk) => {
				stdout += String(chunk);
			});
			child.stderr?.on("data", (chunk) => {
				stderr += String(chunk);
			});
			if (!(await waitForChildProcessExit(child, 45_000)) || child.exitCode !== 0)
				throw new Error(`隔离 CLI 失败：${stderr}\n${stdout}`);
			return JSON.parse(stdout) as {
				ok: boolean;
				task?: { id: string };
				execution?: {
					executionId: string;
					materialSha256: string;
					recoveryEvidenceObservationRegistration?: { command: string[]; boundMaterialSha256: string };
					launchAttemptCount: number;
					revokedAtEpochMs: number | null;
					businessDisposition: string | null;
					specification: {
						readOnlyRecoveryEvidenceObservationCommand?: string[];
						ownerSessionInterruptPolicy?: string;
						continuationNoticesFile?: string;
						producerExecutionRevocationFile?: string;
						recoveryEvidenceObservationMode?: string;
					};
				};
			};
		};
		const startRuntime = async (name: string) => {
			const child = children.register(
				spawn(
					process.execPath,
					["--require", shutdownHook, cli, "--port", String(port), "--no-open", "--no-passcode"],
					{ cwd: project.repositoryPath, env: environment, stdio: ["ignore", "pipe", "pipe", "ipc"] },
				),
			);
			let output = "";
			child.stdout?.on("data", (chunk) => {
				output += String(chunk);
			});
			child.stderr?.on("data", (chunk) => {
				output += String(chunk);
			});
			child.once("exit", () => writeFileSync(join(artifacts, `${name}.log`), output));
			await waitForRuntimeServerStartupBannerOrSigkillChild(child);
			return child;
		};
		const client = (workspaceId?: string) =>
			createTRPCProxyClient<RuntimeAppRouter>({
				links: [
					httpLink({
						url: `http://127.0.0.1:${port}/api/trpc`,
						headers: workspaceId ? { "x-kanban-workspace-id": workspaceId } : {},
					}),
				],
			});
		let runtime = await startRuntime("owned-command-before-restart");
		try {
			const created = await runCli([
				"task",
				"create",
				"--start-in-plan-mode",
				"false",
				"--title",
				"所属执行隔离验证",
				"--prompt",
				"只测试通用命令托管，不启动真实模型",
				"--worktree-mode",
				"inplace",
				"--project-path",
				project.repositoryPath,
			]);
			const taskId = created.task?.id;
			const workspaceId = (await client().projects.list.query()).projects.find(
				(entry) => entry.path === project.repositoryPath,
			)?.id;
			if (!taskId || !workspaceId) throw new Error("隔离任务或工作区未登记");
			const scoped = client(workspaceId);
			const state = await scoped.workspace.getState.query();
			state.sessions[taskId] = runtimeTaskSessionSummarySchema.parse({
				taskId,
				agentId: "codex",
				state: "awaiting_review",
				turnOwner: "user",
				liveness: "exited",
				userTurnKind: "review",
				workspacePath: project.repositoryPath,
				pid: null,
				startedAt: 1,
				updatedAt: 1,
				lastOutputAt: null,
				reviewReason: "hook",
				exitCode: 0,
				lastHookAt: null,
				latestHookActivity: null,
				agentNativeConversationSessionIdentity: {
					sourceAgentId: "codex",
					nativeSessionId: "isolated-native-owner",
					observedAt: 1,
					transcriptPath: null,
				},
			});
			await scoped.workspace.saveState.mutate({
				board: state.board,
				sessions: state.sessions,
				expectedRevision: state.revision,
			});
			const resultFile = join(fixture.fixtureRootDirectoryPath, "business-result.json");
			const specificationFile = join(fixture.fixtureRootDirectoryPath, "owned-command-specification.json");
			const command = [
				process.execPath,
				"-e",
				`require('node:fs').writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({disposition:'machine_evidence_pending',recovery:{trigger:'fixture_changed',action:'resume_same_run',maximum_unchanged_retries:1}}))`,
			];
			const readOnlyRecoveryEvidenceObservationCommand = [
				process.execPath,
				"-e",
				`process.stdout.write(JSON.stringify({evidenceSha256:'${"b".repeat(64)}'}))`,
			];
			writeFileSync(
				specificationFile,
				JSON.stringify({
					command,
					resumeCommand: command,
					ownerSessionInterruptPolicy: "preserve_execution",
					continuationNoticesFile: join(fixture.fixtureRootDirectoryPath, "continuation-notices.json"),
					producerExecutionRevocationFile: join(
						fixture.fixtureRootDirectoryPath,
						"producer-execution-revocation.json",
					),
					workingDirectory: project.repositoryPath,
					resultFile,
					materialSha256: "a".repeat(64),
					label: "通用机器待证",
				}),
			);
			const startArguments = [
				"task",
				"command-execution",
				"start",
				"--task-id",
				taskId,
				"--project-path",
				project.repositoryPath,
				"--idempotency-key",
				"same-work",
				"--spec-file",
				specificationFile,
			];
			const first = await runCli(startArguments);
			const second = await runCli(startArguments);
			expect(first.execution?.executionId).toBe(second.execution?.executionId);
			expect(second.execution?.launchAttemptCount).toBe(1);
			expect(second.execution?.specification.ownerSessionInterruptPolicy).toBe("preserve_execution");
			expect(second.execution?.specification.continuationNoticesFile).toBe(
				join(fixture.fixtureRootDirectoryPath, "continuation-notices.json"),
			);
			expect(second.execution?.specification.producerExecutionRevocationFile).toBe(
				join(fixture.fixtureRootDirectoryPath, "producer-execution-revocation.json"),
			);
			expect(second.execution?.specification.readOnlyRecoveryEvidenceObservationCommand).toBeUndefined();
			const executionId = first.execution?.executionId;
			if (!executionId) throw new Error("所属执行未受理");
			const registrationFile = join(
				fixture.fixtureRootDirectoryPath,
				"bound-recovery-observation-registration.json",
			);
			writeFileSync(
				registrationFile,
				JSON.stringify({
					taskId,
					executionId,
					expectedMaterialSha256: first.execution?.materialSha256,
					command: readOnlyRecoveryEvidenceObservationCommand,
					mode: "semantic_observation_only",
				}),
			);
			const registrationArguments = [
				"task",
				"command-execution",
				"register-recovery-evidence-observation",
				"--registration-file",
				registrationFile,
				"--project-path",
				project.repositoryPath,
			];
			const attached = await runCli(registrationArguments);
			const repeatedAttachment = await runCli(registrationArguments);
			expect(attached.execution?.specification).toEqual(second.execution?.specification);
			expect(attached.execution?.materialSha256).toBe(first.execution?.materialSha256);
			expect(attached.execution?.recoveryEvidenceObservationRegistration?.command).toEqual(
				readOnlyRecoveryEvidenceObservationCommand,
			);
			expect(repeatedAttachment.execution?.recoveryEvidenceObservationRegistration).toEqual(
				attached.execution?.recoveryEvidenceObservationRegistration,
			);
			const cancelled = await runCli([
				"task",
				"command-execution",
				"cancel",
				"--task-id",
				taskId,
				"--project-path",
				project.repositoryPath,
				"--execution-id",
				executionId,
			]);
			expect(cancelled.execution?.revokedAtEpochMs).toBeTypeOf("number");
			runtime.send?.({ type: "kanban.shutdown" });
			if (!(await waitForChildProcessExit(runtime, 15_000))) throw new Error("旧隔离 runtime 没有退出");
			runtime = await startRuntime("owned-command-after-restart");
			const restored = await runCli([
				"task",
				"command-execution",
				"inspect",
				"--task-id",
				taskId,
				"--project-path",
				project.repositoryPath,
				"--execution-id",
				executionId,
			]);
			expect(restored.execution?.businessDisposition).toBe("cancelled");
			expect(restored.execution?.launchAttemptCount).toBe(1);
			expect(restored.execution?.recoveryEvidenceObservationRegistration?.command).toEqual(
				readOnlyRecoveryEvidenceObservationCommand,
			);
			const producerEntrypoint = process.env.KANBAN_RVF_PRODUCER_ENTRYPOINT;
			if (producerEntrypoint) {
				const python = process.env.KANBAN_RVF_PRODUCER_PYTHON_EXECUTABLE ?? "python3";
				const producerSource = resolve(dirname(producerEntrypoint), "../../../../..");
				const producerRun = join(fixture.fixtureRootDirectoryPath, "paired-rvf-machine-evidence-run");
				const roleProgram = join(fixture.fixtureRootDirectoryPath, "paired-machine-request-reviewer.py");
				writeFileSync(
					roleProgram,
					[
						"import json,os",
						"from pathlib import Path",
						"request=json.loads(Path(os.environ['RVF_ROLE_INPUT']).read_text())",
						"pending='reviewer-2' in request['input_file'] and not request.get('reviewer_machine_evidence')",
						"result={'status':'incomplete' if pending else 'completed','findings':[],'audit_summary':'独立隔离协议替身，未调用真实模型'}",
						"if pending: result['requests']=[{'kind':'machine_evidence','binding':request['machine_evidence_request_binding'],'registered_command_references':[{'command_collection':'validation_commands','command_index':0}]}]",
						"print(json.dumps(result,ensure_ascii=False))",
					].join("\n"),
				);
				// 只暂停模型输入；真实生产方控制器、宿主命令和只读观察继续运行。
				const ownerState = await scoped.workspace.getState.query();
				const ownerSummary = ownerState.sessions[taskId];
				if (!ownerSummary) throw new Error("隔离主会话身份丢失");
				ownerState.sessions[taskId] = runtimeTaskSessionSummarySchema.parse({
					...ownerSummary,
					taskConversationSessionMetadata: {
						workspaceTaskId: taskId,
						taskConversationSessionRole: "main",
						taskConversationSessionContextSource: "started_from_scratch",
						taskAutomationSuspendedForMainSessionHandover: true,
						parentTaskConversationSessionId: null,
						mainSessionOriginTurnNumber: null,
						mainSessionOriginUserMessagePreview: null,
						latestUserMessagePreview: null,
					},
				});
				await scoped.workspace.saveState.mutate({
					board: ownerState.board,
					sessions: ownerState.sessions,
					expectedRevision: ownerState.revision,
				});
				writeFileSync(join(project.repositoryPath, "README.md"), "固定候选的宿主补证验收\n");
				const settings = {
					repository: project.repositoryPath,
					run: producerRun,
					roleProgram,
					python,
					taskId,
					entrypoint: producerEntrypoint,
					kanbanCli: cli,
					source: producerSource,
				};
				const bootstrap = join(fixture.fixtureRootDirectoryPath, "paired-rvf-bootstrap.py");
				writeFileSync(
					bootstrap,
					[
						"import json,sys",
						"from pathlib import Path",
						`settings=json.loads(${JSON.stringify(JSON.stringify(settings))})`,
						"sys.path.insert(0,settings['source'])",
						"from core.task_snapshot_review.task_snapshot import create_snapshot",
						"from core.task_snapshot_review.persistent_artifacts import write_json",
						"from adapters.cline_kanban.owned_command_execution import start_managed_review",
						"run=Path(settings['run'])",
						"create_snapshot(Path(settings['repository']),base_ref='HEAD',scope_paths=['README.md'],requirements='跨仓宿主补证协议验收'.encode(),run_directory=run,execution_plan={'fix':False,'validation_commands':[[settings['python'],'-c',\"print('registered host proof')\"]]})",
						"write_json(run/'reviewer-configurations.json',{'configurations':[{'command':[settings['python'],settings['roleProgram']],'output_format':'text'}]*2})",
						"result=start_managed_review(run,settings['taskId'],project_path=Path(settings['repository']),kanban_cli=Path(settings['kanbanCli']),entrypoint=Path(settings['entrypoint']))",
						"print(json.dumps(result,ensure_ascii=False))",
					].join("\n"),
				);
				const producer = children.register(
					spawn(python, [bootstrap], {
						cwd: project.repositoryPath,
						env: environment,
						stdio: ["ignore", "pipe", "pipe"],
					}),
				);
				let producerOutput = "";
				producer.stdout?.on("data", (chunk) => {
					producerOutput += String(chunk);
				});
				producer.stderr?.on("data", (chunk) => {
					producerOutput += String(chunk);
				});
				if (!(await waitForChildProcessExit(producer, 45_000)) || producer.exitCode !== 0)
					throw new Error(`真实 RVF 生产方登记失败：${producerOutput}`);
				const resultPath = join(producerRun, "business-result.json");
				try {
					await expect
						.poll(
							() => {
								try {
									return JSON.parse(readFileSync(resultPath, "utf8")).status;
								} catch {
									return "pending";
								}
							},
							{ timeout: 60_000, interval: 200 },
						)
						.toBe("ready_to_commit");
				} catch (error) {
					const diagnostics = join(artifacts, "paired-rvf-failure-originals");
					mkdirSync(diagnostics, { recursive: true });
					cpSync(producerRun, join(diagnostics, "run"), { recursive: true });
					const ownedRoot = join(
						fixture.isolatedHomeDirectoryPath,
						".cline/kanban/workspaces",
						workspaceId,
						"task-command-executions",
					);
					if (existsSync(ownedRoot))
						cpSync(ownedRoot, join(diagnostics, "owned-command-originals"), { recursive: true });
					writeFileSync(join(diagnostics, "bootstrap-output.txt"), producerOutput);
					const receipt = JSON.parse(
						readFileSync(join(producerRun, "kanban-command-execution-start-receipt.json"), "utf8"),
					);
					await runCli([
						"task",
						"command-execution",
						"cancel",
						"--task-id",
						taskId,
						"--project-path",
						project.repositoryPath,
						"--execution-id",
						JSON.parse(receipt.stdout).execution.executionId,
					]);
					throw error;
				}
				const producerReceipt = JSON.parse(
					readFileSync(join(producerRun, "kanban-command-execution-start-receipt.json"), "utf8"),
				);
				const producerExecutionId = JSON.parse(producerReceipt.stdout).execution.executionId as string;
				const pairedExecution = await runCli([
					"task",
					"command-execution",
					"inspect",
					"--task-id",
					taskId,
					"--project-path",
					project.repositoryPath,
					"--execution-id",
					producerExecutionId,
				]);
				expect(pairedExecution.execution?.specification.recoveryEvidenceObservationMode).toBe(
					"semantic_observation_only",
				);
				expect(
					readdirSync(join(producerRun, "reviewer-1")).filter((name) => name.startsWith("attempt-")),
				).toHaveLength(1);
				expect(
					readdirSync(join(producerRun, "reviewer-2")).filter((name) => name.startsWith("attempt-")),
				).toHaveLength(2);
				expect(
					JSON.parse(readFileSync(join(producerRun, "reviewer-2/attempt-001/result.json"), "utf8")).status,
				).toBe("incomplete");
				writeFileSync(
					join(artifacts, "paired-rvf-producer-consumer-receipts.json"),
					JSON.stringify(
						{
							producerOutput,
							pairedExecution,
							result: JSON.parse(readFileSync(resultPath, "utf8")),
							snapshot: JSON.parse(readFileSync(join(producerRun, "run.json"), "utf8")),
						},
						null,
						2,
					),
				);
				const pairedOriginals = join(artifacts, "paired-rvf-success-originals");
				cpSync(producerRun, join(pairedOriginals, "run"), { recursive: true });
				writeFileSync(
					join(pairedOriginals, "archive-only-provenance.json"),
					JSON.stringify(
						{
							purpose: "跨仓隔离协议验收原件，不是生产 run；reviewer 为 Python 协议替身，没有调用真实模型",
							originalRunDirectory: producerRun,
							executionId: producerExecutionId,
							testedBeforeFixtureCleanup: true,
						},
						null,
						2,
					),
				);
				await runCli([
					"task",
					"command-execution",
					"cancel",
					"--task-id",
					taskId,
					"--project-path",
					project.repositoryPath,
					"--execution-id",
					producerExecutionId,
				]);
			}
			writeFileSync(
				join(artifacts, "packaged-command-execution-receipts.json"),
				JSON.stringify({ first, second, attached, repeatedAttachment, cancelled, restored }, null, 2),
			);
			const recordPath = join(
				fixture.isolatedHomeDirectoryPath,
				".cline",
				"kanban",
				"workspaces",
				workspaceId,
				"task-command-executions.json",
			);
			writeFileSync(join(artifacts, "packaged-command-execution-records.json"), readFileSync(recordPath));
		} finally {
			runtime.send?.({ type: "kanban.shutdown" });
			await waitForChildProcessExit(runtime, 15_000);
		}
	},
);
