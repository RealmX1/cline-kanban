import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { createTRPCProxyClient, httpLink } from "@trpc/client";
import { afterEach, expect, it, vi } from "vitest";
import { loadTaskConversationHistoryPage } from "../../src/agent-session-history/task-conversation-history-page";
import { type RuntimeTaskSessionSummary, runtimeBoardDataSchema } from "../../src/core/api-contract";
import { withRunningCodexAppServerControlSocketConnection } from "../../src/rvf-automatic-closeout/codex-app-server-control-socket-request-connection";
import {
	assertCodexNativeConversationLoadedByCurrentHost,
	readCodexConversationTurns,
} from "../../src/rvf-automatic-closeout/codex-native-conversation-prefix";
import { renderTaskMainSessionHandoverReportPrompt } from "../../src/server/task-main-session-handover-coordinator";
import { queryCodexMainSessionHandoverReportAcceptance } from "../../src/server/task-main-session-handover-report-acceptance";
import { loadWorkspaceContext, saveWorkspaceState } from "../../src/state/workspace-state";
import type { RuntimeAppRouter } from "../../src/trpc/app-router";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForChildProcessExit,
	waitForRuntimeServerStartupBannerOrSigkillChild,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const packagedCliPath = process.env.KANBAN_MAIN_SESSION_HANDOVER_PACKAGED_CLI_PATH;
const nativeCodexBinary = process.env.KANBAN_CODEX_NATIVE_RVF_CLOSEOUT_SMOKE_BINARY;
const evidenceRoot = process.env.KANBAN_MAIN_SESSION_HANDOVER_NATIVE_EVIDENCE_DIRECTORY;
const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(async () => {
	await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
	vi.unstubAllEnvs();
});

function lastNativeUserPrompt(body: string) {
	const parsed = JSON.parse(body) as { input?: { role?: string; content?: { text?: string }[] }[] };
	return (
		parsed.input
			?.filter((item) => item.role === "user")
			.at(-1)
			?.content?.map((part) => part.text ?? "")
			.join("") ?? ""
	);
}
function isNativeHandoverReportPrompt(text: string) {
	return (
		text.startsWith("KANBAN_MAIN_SESSION_HANDOVER_REPORT:") ||
		text.startsWith("/plan KANBAN_MAIN_SESSION_HANDOVER_REPORT:")
	);
}

it
	.skipIf(!packagedCliPath || !nativeCodexBinary || process.platform === "win32")
	.each(["fresh_context_with_handover_material", "fork_complete_native_conversation"] as const)(
	"真实 Codex 主会话交接 %s：本地模型、原生 Plan、独立身份和冷恢复",
	async (mode) => {
		if (!packagedCliPath || !nativeCodexBinary) throw new Error("缺少隔离原生验收参数");
		vi.stubEnv("TMPDIR", "/tmp");
		const fixture = createIsolatedGitTestWorkspaceFixture({ fixtureRootDirectoryNamePrefix: "native-handover-" });
		const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "project" });
		writeFileSync(join(repository.repositoryPath, "implementation.txt"), "隔离基线\n");
		repository.commitAllRepositoryFilesAtDate({
			message: "隔离原生交接基线",
			authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
		});
		vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
		const codexHome = join(fixture.isolatedHomeDirectoryPath, ".codex");
		mkdirSync(codexHome, { recursive: true });
		const evidenceDirectory = evidenceRoot
			? join(evidenceRoot, mode)
			: join(fixture.fixtureRootDirectoryPath, "evidence");
		mkdirSync(evidenceDirectory, { recursive: true });
		const modelRequests: string[] = [];
		const modelServer = createServer(async (request, response) => {
			let body = "";
			for await (const chunk of request) body += String(chunk);
			if (request.method !== "POST") {
				response.end(JSON.stringify({ data: [] }));
				return;
			}
			modelRequests.push(body);
			const number = modelRequests.length;
			const text = isNativeHandoverReportPrompt(lastNativeUserPrompt(body))
				? "计划总览：接回主线。已经实现：交接材料已固定。有待进行：等待用户。"
				: lastNativeUserPrompt(body).startsWith("Generate a concise")
					? '{"title":"隔离交接验收"}'
					: "隔离原生回合已完成。";
			const item = {
				id: `native_message_${number}`,
				type: "message",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text, annotations: [] }],
			};
			const result = {
				id: `native_response_${number}`,
				object: "response",
				created_at: Math.floor(Date.now() / 1000),
				status: "completed",
				model: "gpt-5.4",
				output: [item],
				usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
			};
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			for (const [type, fields] of [
				["response.created", { response: { ...result, status: "in_progress", output: [] } }],
				["response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } }],
				["response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: text }],
				["response.output_item.done", { output_index: 0, item }],
				["response.completed", { response: result }],
			] as const)
				response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
			response.end();
		});
		await new Promise<void>((done) => modelServer.listen(0, "127.0.0.1", done));
		const modelAddress = modelServer.address();
		if (!modelAddress || typeof modelAddress === "string") throw new Error("未分配回环模型端口");
		writeFileSync(
			join(codexHome, "config.toml"),
			`model="gpt-5.4"\nmodel_provider="isolated_loopback"\ncheck_for_update_on_startup=false\n[features]\nmemories=false\nbackground_paginated_rollout_migration=false\n[model_providers.isolated_loopback]\nname="隔离回环模型"\nbase_url="http://127.0.0.1:${modelAddress.port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n[projects.${JSON.stringify(repository.repositoryPath)}]\ntrust_level="trusted"\n`,
		);
		writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "synthetic-loopback-only" }), {
			mode: 0o600,
		});
		const binaryDirectory = join(fixture.fixtureRootDirectoryPath, "native-codex-binary-wrapper");
		mkdirSync(binaryDirectory);
		const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
		writeFileSync(
			join(binaryDirectory, "codex"),
			`#!/bin/sh\nexec ${quote(nativeCodexBinary)} --dangerously-bypass-hook-trust "$@"\n`,
		);
		chmodSync(join(binaryDirectory, "codex"), 0o755);
		const workspace = await loadWorkspaceContext(repository.repositoryPath);
		const taskId = "native-handover-task";
		const board = runtimeBoardDataSchema.parse({
			columns: [
				{
					id: "in_progress",
					title: "进行中",
					cards: [
						{
							id: taskId,
							title: "原生交接隔离验收",
							prompt: "只读核对当前计划并等待用户。",
							agentId: "codex",
							baseRef: "main",
							worktreeMode: "inplace",
							startInPlanMode: false,
							taskAgentPermissionMode: "bypass_all_permission_prompts",
							autoReviewEnabled: false,
							createdAt: 1,
							updatedAt: 1,
						},
					],
				},
			],
		});
		await saveWorkspaceState(repository.repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
			board,
			sessions: {},
		});
		const reservation = createServer();
		await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done));
		const address = reservation.address();
		if (!address || typeof address === "string") throw new Error("未分配隔离运行时端口");
		const port = address.port;
		expect(port).not.toBe(3484);
		await new Promise<void>((done) => reservation.close(() => done()));
		const environment = fixture.createIsolatedChildProcessEnvironment();
		for (const key of Object.keys(environment))
			if (/^(KANBAN_|CLINE_KANBAN_|RVF_|CODEX_|OPENAI_|ANTHROPIC_|CLAUDE_)/u.test(key)) delete environment[key];
		Object.assign(environment, {
			PATH: `${binaryDirectory}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin`,
			CODEX_HOME: codexHome,
			KANBAN_RUNTIME_PORT: String(port),
		});
		let runtimeOutput = "";
		const startRuntime = async () => {
			const child = children.register(
				spawn(
					process.execPath,
					[
						"--require",
						resolve("test/integration/shutdown-ipc-hook.cjs"),
						packagedCliPath,
						"--port",
						String(port),
						"--no-open",
						"--no-passcode",
					],
					{ cwd: repository.repositoryPath, env: environment, stdio: ["ignore", "pipe", "pipe", "ipc"] },
				),
			);
			child.stdout?.on("data", (chunk) => {
				runtimeOutput += String(chunk);
			});
			child.stderr?.on("data", (chunk) => {
				runtimeOutput += String(chunk);
			});
			await waitForRuntimeServerStartupBannerOrSigkillChild(child);
			return child;
		};
		let runtime = await startRuntime();
		const api = createTRPCProxyClient<RuntimeAppRouter>({
			links: [
				httpLink({
					url: `http://127.0.0.1:${port}/api/trpc`,
					headers: { "x-kanban-workspace-id": workspace.workspaceId },
				}),
			],
		});
		try {
			const started = await api.runtime.startTaskSession.mutate({
				taskId,
				agentId: "codex",
				prompt: "NATIVE_ORIGINAL_SIDE_TOPIC_MARKER",
				baseRef: "main",
				worktreeMode: "inplace",
				startInPlanMode: false,
				taskAgentPermissionMode: "bypass_all_permission_prompts",
			});
			expect(started.ok, started.error).toBe(true);
			let source: RuntimeTaskSessionSummary | undefined;
			await vi.waitFor(
				async () => {
					source = (await api.workspace.getState.query()).sessions[taskId];
					expect(
						modelRequests.filter((body) => lastNativeUserPrompt(body) === "NATIVE_ORIGINAL_SIDE_TOPIC_MARKER"),
					).toHaveLength(1);
					expect(source?.agentNativeConversationSessionIdentity?.nativeSessionId).toBeTruthy();
					expect(source?.latestHookActivity?.finalMessage).toBe("隔离原生回合已完成。");
					assert(source?.codexNativeSessionControlEndpoint);
					const sourceNativeId = source.agentNativeConversationSessionIdentity?.nativeSessionId;
					assert(sourceNativeId);
					await withRunningCodexAppServerControlSocketConnection(
						async (reader) => {
							const turns = await readCodexConversationTurns(reader, sourceNativeId);
							expect(turns.at(-1)?.status).toBe("completed");
							expect(turns.some((turn) => turn.status === "inProgress")).toBe(false);
						},
						{ socketPath: source.codexNativeSessionControlEndpoint.socketPath },
					);
				},
				{ timeout: 60_000, interval: 250 },
			);
			const sourceNativeId = source?.agentNativeConversationSessionIdentity?.nativeSessionId;
			// 来源回合已经由原生历史与 Stop 双重证明；显式停住测试来源，固定可重复的交接边界。
			await api.runtime.stopTaskSession.mutate({ taskId });
			await api.runtime.requestTaskMainSessionHandover.mutate({
				taskId,
				expectedMainTaskConversationSessionId: taskId,
				requestId: randomUUID(),
				destination: { kind: "new_codex_session", contextInheritanceMode: mode },
				userContextNotes: "只读汇报后等待用户",
				additionalPlanReferencePaths: [],
			});
			await vi.waitFor(
				async () => {
					const result = await api.runtime.getTaskMainSessionHandoverStatus.query({ taskId });
					if (
						result.record?.status === "failed" &&
						result.record.automaticRecovery?.classification !== "waiting_for_machine_evidence"
					)
						throw new Error(result.record.errorMessage ?? "原生交接失败");
					expect(result.record?.status).toBe("awaiting_user_message");
					expect(
						modelRequests.filter((body) => isNativeHandoverReportPrompt(lastNativeUserPrompt(body))),
					).toHaveLength(1);
				},
				{ timeout: 60_000, interval: 250 },
			);
			const record = (await api.runtime.getTaskMainSessionHandoverStatus.query({ taskId })).record;
			assert(record);
			const state = await api.workspace.getState.query();
			const card = state.board.columns.flatMap((column) => column.cards).find((entry) => entry.id === taskId);
			assert(card);
			const target = state.sessions[record.targetTaskConversationSessionId];
			expect(target.agentNativeConversationSessionIdentity?.nativeSessionId).not.toBe(sourceNativeId);
			expect(target.workspacePath).toBe(source?.workspacePath);
			expect(state.sessions[taskId].agentNativeConversationSessionIdentity?.nativeSessionId).toBe(sourceNativeId);
			expect(
				state.sessions[taskId].taskConversationSessionMetadata?.taskConversationSessionHasHeldMainResponsibility,
			).toBe(true);
			const reportRequest = modelRequests.find((body) => isNativeHandoverReportPrompt(lastNativeUserPrompt(body)));
			assert(reportRequest);
			expect(reportRequest).toMatch(/plan mode/iu);
			expect(reportRequest.includes("NATIVE_ORIGINAL_SIDE_TOPIC_MARKER")).toBe(
				mode === "fork_complete_native_conversation",
			);
			if (!record.reportAcceptanceProbe) throw new Error("缺少提交前固定的原生绑定");
			const acceptance = await queryCodexMainSessionHandoverReportAcceptance({
				workspaceId: workspace.workspaceId,
				card,
				summary: target,
				probe: record.reportAcceptanceProbe,
				prompt: renderTaskMainSessionHandoverReportPrompt(record),
			});
			expect(acceptance.historicalAcceptanceEvidence).not.toBeNull();
			const history = await loadTaskConversationHistoryPage({
				card,
				sessions: state.sessions,
				request: { workspaceTaskId: taskId, taskConversationSessionId: target.taskId },
			});
			writeFileSync(join(evidenceDirectory, "native-history-page.json"), JSON.stringify(history, null, 2));
			expect(history.availability).toBe("available");
			expect(
				history.messages.filter(
					(message) => message.role === "user" && message.content.includes("KANBAN_MAIN_SESSION_HANDOVER_REPORT:"),
				),
			).toHaveLength(1);
			assert(record.materialDirectoryPath);
			expect(readFileSync(join(record.materialDirectoryPath, "HANDOVER.md"), "utf8")).toContain("只读核对后汇报");
			await api.runtime.stopTaskSession.mutate({ taskId: target.taskId });
			runtime.kill("SIGINT");
			expect(await waitForChildProcessExit(runtime, 20_000)).toBe(true);
			runtime = await startRuntime();
			const cold = await api.runtime.startTaskSession.mutate({
				taskId,
				agentId: "codex",
				prompt: "COLD_START_MUST_NOT_BE_SENT",
				baseRef: "main",
				worktreeMode: "inplace",
			});
			expect(cold.ok, cold.error).toBe(true);
			expect(cold.summary?.taskId).toBe(target.taskId);
			await vi.waitFor(
				async () => {
					const resumed = (await api.workspace.getState.query()).sessions[target.taskId];
					expect(resumed.agentNativeConversationSessionIdentity?.nativeSessionId).toBe(
						target.agentNativeConversationSessionIdentity?.nativeSessionId,
					);
					if (!resumed.codexNativeSessionControlEndpoint) throw new Error("等待原生控制宿主恢复");
					const resumedNativeId = resumed.agentNativeConversationSessionIdentity?.nativeSessionId;
					assert(resumedNativeId);
					await withRunningCodexAppServerControlSocketConnection(
						async (reader) => await assertCodexNativeConversationLoadedByCurrentHost(reader, resumedNativeId),
						{ socketPath: resumed.codexNativeSessionControlEndpoint.socketPath },
					);
				},
				{ timeout: 30_000, interval: 250 },
			);
			const human = await api.runtime.sendTaskChatMessage.mutate({
				taskId,
				text: "NATIVE_HUMAN_CONTINUE_AFTER_COLD_RESUME",
			});
			expect(human.ok, human.error).toBe(true);
			await vi.waitFor(
				async () =>
					expect((await api.runtime.getTaskMainSessionHandoverStatus.query({ taskId })).record?.status).toBe(
						"completed",
					),
				{ timeout: 30_000, interval: 250 },
			);
			expect(
				(await api.runtime.getTaskMainSessionHandoverStatus.query({ taskId })).record?.automaticRecovery,
			).toBeUndefined();
			expect(modelRequests.every((body) => !body.includes("COLD_START_MUST_NOT_BE_SENT"))).toBe(true);
			expect(modelRequests.filter((body) => isNativeHandoverReportPrompt(lastNativeUserPrompt(body)))).toHaveLength(
				1,
			);
			writeFileSync(
				join(evidenceDirectory, "native-handover-result.json"),
				JSON.stringify(
					{
						mode,
						sourceNativeId,
						targetNativeId: target.agentNativeConversationSessionIdentity?.nativeSessionId,
						acceptance,
						record,
						history,
						finalState: await api.workspace.getState.query(),
					},
					null,
					2,
				),
			);
		} finally {
			writeFileSync(
				join(evidenceDirectory, "last-runtime-state.json"),
				JSON.stringify(await api.workspace.getState.query().catch(() => null), null, 2),
			);
			writeFileSync(join(evidenceDirectory, "isolated-runtime.log"), runtimeOutput);
			writeFileSync(
				join(evidenceDirectory, "loopback-model-requests.json"),
				JSON.stringify(
					modelRequests.map((body) => JSON.parse(body)),
					null,
					2,
				),
			);
			await api.runtime.stopTaskSession.mutate({ taskId }).catch(() => null);
			runtime.kill("SIGINT");
			await waitForChildProcessExit(runtime, 20_000);
			modelServer.closeAllConnections();
			await new Promise<void>((done) => modelServer.close(() => done()));
			for (const [label, directory] of [
				["configured-codex-sessions", join(codexHome, "sessions")],
				[
					"runtime-codex-sessions",
					join(
						fixture.isolatedHomeDirectoryPath,
						".cline",
						"kanban",
						"codex-conversation-storage-home",
						"sessions",
					),
				],
			] as const)
				if (existsSync(directory)) cpSync(directory, join(evidenceDirectory, label), { recursive: true });
			fixture.cleanup();
		}
	},
	180_000,
);
