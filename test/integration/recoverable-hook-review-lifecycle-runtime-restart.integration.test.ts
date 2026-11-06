import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { createTRPCProxyClient, httpLink } from "@trpc/client";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeBoardData, RuntimeHookIngestRequest } from "../../src/core/api-contract";
import { setTaskCardShelvingState } from "../../src/core/task-shelving-state";
import type { RuntimeAppRouter } from "../../src/trpc/app-router";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	sigkillChildProcessAndWaitForExit,
	waitForRuntimeServerStartupBannerOrSigkillChild,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const cliPath = process.env.KANBAN_HIGH_LOAD_RELIABILITY_PACKAGED_CLI_PATH;
const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(() => children.sigkillEveryStillRunningChildProcessAndWaitForExit());

describe.skipIf(!cliPath)("完成事件在真实运行时强杀后的自动对账", { timeout: 240_000 }, () => {
	it("三次持久化 EIO、重启、历史补证和 40 条后续事件仍只有一次完成", async () => {
		if (!cliPath) throw new Error("缺少本任务隔离构建 CLI。");
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const repository = fixture.createNonBareRepository({
			repositoryDirectoryName: "recoverable-review-runtime",
			initialBranchName: "main",
		});
		await writeFile(join(repository.repositoryPath, "baseline.txt"), "隔离的本地 main\n");
		repository.commitAllRepositoryFilesAtDate({
			message: "初始化可靠性隔离仓库",
			authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
		});
		const binaries = join(fixture.fixtureRootDirectoryPath, "isolated-agent-binaries");
		await mkdir(binaries);
		await writeFile(
			join(binaries, "claude"),
			`#!${process.execPath}\nif(process.argv.includes('--version'))process.stdout.write('2.1.23 (Claude Code)\\n');else{process.stdout.write('Claude Code\\n❯ ');process.stdin.resume();setInterval(()=>{},1000)}\n`,
			{ mode: 0o755 },
		);
		const faultMarker = join(fixture.fixtureRootDirectoryPath, "snapshot-write-fault-enabled");
		const preload = join(fixture.fixtureRootDirectoryPath, "isolated-snapshot-write-fault.cjs");
		await writeFile(
			preload,
			`const fs=require('node:fs');const fsp=require('node:fs/promises');const original=fsp.writeFile;fsp.writeFile=async function(path,...args){if(String(path).includes('workspace-state-snapshot-commit.json.tmp')&&fs.existsSync(${JSON.stringify(faultMarker)}))throw Object.assign(new Error('隔离 EIO 故障'),{code:'EIO'});return original.call(this,path,...args)};require('node:module').syncBuiltinESMExports();`,
		);
		const reservation = createServer();
		await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
		const address = reservation.address();
		if (!address || typeof address === "string") throw new Error("隔离端口不可用。");
		await new Promise<void>((resolve) => reservation.close(() => resolve()));
		const environment = fixture.createIsolatedChildProcessEnvironment();
		for (const key of Object.keys(environment))
			if (
				/^(KANBAN_|ANTHROPIC_|OPENAI_|CLAUDE_|CODEX_|CURSOR_|GEMINI_|GOOGLE_|KIMI_|AGENT_CONVERSATION_)/u.test(key)
			)
				delete environment[key];
		Object.assign(environment, {
			PATH: `${binaries}:${dirname(process.execPath)}:/usr/bin:/bin`,
			CODEX_HOME: join(fixture.fixtureRootDirectoryPath, "isolated-codex-home"),
			CODEX_SQLITE_HOME: join(fixture.fixtureRootDirectoryPath, "isolated-codex-sqlite-home"),
			KANBAN_RUNTIME_PORT: String(address.port),
			KANBAN_AGENT_SESSION_PTY_HOST_MODE: "disabled",
		});
		const start = async () => {
			const child = children.register(
				spawn(
					process.execPath,
					["--require", preload, cliPath, "--no-open", "--no-passcode", "--port", String(address.port)],
					{ cwd: repository.repositoryPath, env: environment, stdio: ["ignore", "pipe", "pipe"] },
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
				await waitForRuntimeServerStartupBannerOrSigkillChild(child);
			} catch (error) {
				throw new Error(`${String(error)}\n${output}`);
			}
			return child;
		};
		const client = (workspaceId?: string) =>
			createTRPCProxyClient<RuntimeAppRouter>({
				links: [
					httpLink({
						url: `http://127.0.0.1:${address.port}/api/trpc`,
						headers: workspaceId ? { "x-kanban-workspace-id": workspaceId } : {},
					}),
				],
			});
		let runtime = await start();
		try {
			const workspaceId = (await client().projects.list.query()).projects.find(
				(project) => project.path === repository.repositoryPath,
			)?.id;
			if (!workspaceId) throw new Error("隔离工作区未登记。");
			const scoped = client(workspaceId);
			const initial = await scoped.workspace.getState.query();
			const taskId = "recoverable-review-main";
			const boardWithTask: RuntimeBoardData = {
				...initial.board,
				columns: initial.board.columns.map((column) => ({
					...column,
					cards:
						column.id === "in_progress"
							? [
									{
										id: taskId,
										title: "[TEST]完成恢复",
										prompt: "隔离核验，不请求模型",
										baseRef: "main",
										startInPlanMode: false,
										createdAt: Date.now(),
										updatedAt: Date.now(),
									},
								]
							: [],
				})),
			};
			const shelvedBoard = setTaskCardShelvingState(boardWithTask, taskId, true).board;
			const unshelvedBoard = setTaskCardShelvingState(shelvedBoard, taskId, false).board;
			expect(unshelvedBoard.columns.flatMap((column) => column.cards)[0]?.taskShelvingState?.isShelved).toBe(false);
			await scoped.workspace.saveState.mutate({
				board: unshelvedBoard,
				sessions: {},
				expectedRevision: initial.revision,
			});
			const started = await scoped.runtime.startTaskSession.mutate({
				taskId,
				agentId: "claude",
				prompt: "隔离完成事件",
				baseRef: "main",
				startInPlanMode: false,
				worktreeMode: "inplace",
			});
			expect(started.ok).toBe(true);
			if (!started.summary?.runtimeSessionIncarnationId) throw new Error("隔离 agent 未产生启动代际。");
			const transcriptPath = join(fixture.fixtureRootDirectoryPath, "isolated-claude-transcript.jsonl");
			await writeFile(transcriptPath, "");
			const identity = {
				sourceAgentId: "claude" as const,
				nativeSessionId: randomUUID(),
				transcriptPath,
				observedAt: Date.now(),
			};
			expect(
				(
					await scoped.hooks.ingest.mutate({
						workspaceId,
						taskId,
						event: "agent_conversation_session_identity_observed",
						agentNativeConversationSessionIdentity: identity,
					})
				).ok,
			).toBe(true);
			const state = await scoped.workspace.getState.query();
			const capturedAt = Date.now();
			const request: RuntimeHookIngestRequest = {
				workspaceId,
				taskId,
				event: "to_review",
				metadata: { source: "claude", hookEventName: "Stop", finalMessage: "正文不可进入恢复文件" },
				agentNativeConversationSessionIdentity: { ...identity, observedAt: capturedAt },
				hookRuntimeSessionIncarnationId: started.summary.runtimeSessionIncarnationId,
				hookEventDeliveryIdempotencyKey: randomUUID(),
				hookEventCapturedAtEpochMs: capturedAt,
			};
			await writeFile(faultMarker, "EIO");
			expect(await scoped.hooks.ingest.mutate(request)).toMatchObject({
				ok: true,
				lifecycleEventDeliveryStatus: "durably_accepted_pending_application",
			});
			const deliveryPath = join(state.statePath, "recoverable-hook-lifecycle-event-deliveries.json");
			const pending = JSON.parse(await readFile(deliveryPath, "utf8"));
			expect(pending.deliveries[0]).toMatchObject({
				status: "waiting_for_recovery_evidence",
				attemptsStartedInRecoveryCycle: 3,
			});
			expect(JSON.stringify(pending)).not.toContain("正文不可进入恢复文件");
			await sigkillChildProcessAndWaitForExit(runtime);
			await rm(faultMarker);
			runtime = await start();
			await expect
				.poll(
					async () => {
						const observation = {
							deliveryFile: JSON.parse(await readFile(deliveryPath, "utf8")),
							session: (await scoped.workspace.getState.query()).sessions[taskId],
						};
						const evidenceDirectory = process.env.KANBAN_HIGH_LOAD_RELIABILITY_EVIDENCE_DIRECTORY;
						if (evidenceDirectory) {
							await mkdir(evidenceDirectory, { recursive: true });
							await writeFile(
								join(evidenceDirectory, "restart-recovery-observation.json"),
								JSON.stringify(observation, null, 2),
							);
						}
						return observation.deliveryFile.deliveries[0].status;
					},
					{
						timeout: 60_000,
					},
				)
				.toBe("application_confirmed");
			const recovered = (await scoped.workspace.getState.query()).sessions[taskId];
			const confirmedDelivery = JSON.parse(await readFile(deliveryPath, "utf8")).deliveries[0];
			expect(confirmedDelivery.admissionRuntimeProcessInstanceId).toBe(
				pending.deliveries[0].admissionRuntimeProcessInstanceId,
			);
			expect(confirmedDelivery.applicationConfirmationRuntimeProcessInstanceId).not.toBe(
				confirmedDelivery.admissionRuntimeProcessInstanceId,
			);
			expect(confirmedDelivery.applicationAttemptRuntimeProcessInstanceIds).toContain(
				confirmedDelivery.applicationConfirmationRuntimeProcessInstanceId,
			);
			expect(confirmedDelivery.applicationConfirmedAtEpochMs).toBeGreaterThanOrEqual(capturedAt);
			expect(recovered).toMatchObject({ turnOwner: "user", liveness: "exited", pid: null, userTurnKind: "review" });
			expect(recovered?.lastAgentConversationUserHandoffObservation?.observedAtMs).toBe(capturedAt);
			for (let index = 0; index < 40; index += 1)
				await scoped.hooks.ingest.mutate({
					workspaceId,
					taskId,
					event: "activity",
					hookEventDeliveryIdempotencyKey: `later-event-${index}`,
				});
			expect(await scoped.hooks.ingest.mutate(request)).toMatchObject({
				ok: true,
				lifecycleEventDeliveryStatus: "application_confirmed",
			});
			expect(JSON.parse(await readFile(deliveryPath, "utf8")).deliveries).toHaveLength(1);
			expect(
				(await scoped.workspace.getState.query()).sessions[taskId]?.lastAgentConversationUserHandoffObservation,
			).toEqual(recovered?.lastAgentConversationUserHandoffObservation);
		} finally {
			await sigkillChildProcessAndWaitForExit(runtime);
			fixture.cleanup();
		}
	});
});
