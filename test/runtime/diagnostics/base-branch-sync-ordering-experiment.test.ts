import { execFileSync } from "node:child_process";
import type { lookup } from "node:dns/promises";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, type RequestListener } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { deriveReviewedBatchFromCohort } from "../../../scripts/base-branch-sync-ordering-experiment/derive-reviewed-batch-from-cohort";
import {
	appendTaskDependencyEnvironmentBackups,
	backupExecutionEnvironment,
} from "../../../scripts/base-branch-sync-ordering-experiment/execution-environment-backup";
import {
	decideOperationRecovery,
	deriveTaskOrder,
	experimentInputSchema,
	fingerprint,
	inspectCompletedNativeHistory,
	summarizeNewTurnUsage,
	validateTaskOrder,
} from "../../../scripts/base-branch-sync-ordering-experiment/experiment-contract";
import { materializeIndependentWorkingState } from "../../../scripts/base-branch-sync-ordering-experiment/frozen-source-snapshot";
import {
	createMacosExperimentSandboxProfile,
	createOwnedModelEndpointProxySandboxRule,
} from "../../../scripts/base-branch-sync-ordering-experiment/macos-experiment-process-isolation";
import {
	requireApprovedModelProxyTarget,
	startModelEndpointEgressProxy,
} from "../../../scripts/base-branch-sync-ordering-experiment/model-endpoint-egress-proxy";
import {
	createOwnedExperimentRoot,
	isolatedProcessEnvironment,
	safeEntryPath,
} from "../../../scripts/base-branch-sync-ordering-experiment/persistent-experiment-storage";
import { restoreExecutionEnvironmentIntoPrivateDirectories } from "../../../scripts/base-branch-sync-ordering-experiment/restore-execution-environment";
import { backupReusableTaskCohort } from "../../../scripts/base-branch-sync-ordering-experiment/reusable-task-cohort-backup";
import { verifyReusableTaskCohortBackup } from "../../../scripts/base-branch-sync-ordering-experiment/verify-reusable-cohort-backup";
import { captureSourceGitWorkingState } from "../../../src/independent-task-creation/git-working-state-snapshot";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

describe("排序实验的固定输入与计量", () => {
	const tasks = [
		{ taskId: "alpha", readyAt: 10, codeChangedLines: 50, dependsOn: [] },
		{ taskId: "beta", readyAt: 5, codeChangedLines: 1, dependsOn: ["alpha"] },
		{ taskId: "gamma", readyAt: 10, codeChangedLines: 5, dependsOn: [] },
	];
	it("基线稳定遵守共同依赖，语义排列不得缺项、重复或违反依赖", () => {
		expect(deriveTaskOrder(tasks, "fifo")).toEqual(["alpha", "beta", "gamma"]);
		expect(deriveTaskOrder(tasks, "smallest-change-first")).toEqual(["gamma", "alpha", "beta"]);
		expect(() => validateTaskOrder(tasks, ["beta", "alpha", "gamma"])).toThrow("依赖");
		expect(() => validateTaskOrder(tasks, ["alpha", "alpha", "gamma"])).toThrow("恰好");
		expect(() => deriveTaskOrder([{ ...tasks[0], dependsOn: ["missing"] }], "fifo")).toThrow("缺失依赖");
		expect(() => deriveTaskOrder([{ ...tasks[0], dependsOn: ["alpha"] }], "fifo")).toThrow("依赖环");
	});
	it.each(["d55ee", "dd679"])("工作负载排序拒绝明确排除的任务 %s", (taskId) => {
		const excludedTasks = [{ taskId, readyAt: 1, codeChangedLines: 1, dependsOn: [] }];
		expect(() => validateTaskOrder(excludedTasks, [taskId])).toThrow("范围");
		expect(() => deriveTaskOrder(excludedTasks, "fifo")).toThrow("范围");
		expect(() => deriveTaskOrder(excludedTasks, "smallest-change-first")).toThrow("范围");
	});
	it("拒绝排除任务与滚动扩大的时间窗，保留原队列的等待资格", () => {
		const input = {
			schemaVersion: 1,
			workspaceId: "fixture",
			requestArrivedAt: 200_000_000,
			projectPath: "/source",
			baseRef: "main",
			boardPath: "/board.json",
			sessionsPath: "/sessions.json",
			workflowEvidencePaths: [],
			tasks: [
				{
					taskId: "alpha",
					taskIncarnationCreatedAt: 100_000_000,
					worktreePath: "/source-task",
					implementationActivityAt: 199_999_999,
					dependsOn: [],
					review: {
						candidateCommit: "a".repeat(40),
						candidateTree: "b".repeat(40),
						completedAt: 200_000_001,
						evidencePaths: ["/review.json"],
					},
				},
			],
		};
		expect(experimentInputSchema.safeParse(input).success).toBe(true);
		for (const taskId of ["d55ee", "dd679"]) {
			expect(experimentInputSchema.safeParse({ ...input, tasks: [{ ...input.tasks[0], taskId }] }).success).toBe(
				false,
			);
			expect(
				experimentInputSchema.safeParse({ ...input, tasks: [{ ...input.tasks[0], dependsOn: [taskId] }] }).success,
			).toBe(false);
		}
		expect(
			experimentInputSchema.safeParse({
				...input,
				tasks: [{ ...input.tasks[0], implementationActivityAt: 300_000_000 }],
			}).success,
		).toBe(false);
		expect(
			experimentInputSchema.safeParse({
				...input,
				tasks: [
					{
						...input.tasks[0],
						implementationActivityAt: 300_000_000,
						originalCohortEvidencePath: "/original-cohort.md",
					},
				],
			}).success,
		).toBe(true);
	});
	it("只冻结完整回合，身份错误、在途回合与损坏尾行均保持未知", () => {
		const id = "12345678-1234-4234-8234-123456789abc";
		const rows = [
			{ type: "session_meta", payload: { id } },
			{ type: "event_msg", payload: { type: "task_started", turn_id: "first" } },
			{ type: "turn_context", payload: { turn_id: "first", model: "test-model", effort: "high" } },
			{ type: "event_msg", payload: { type: "task_complete", turn_id: "first" } },
		];
		const text = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
		expect(inspectCompletedNativeHistory(text, id).turnIds).toEqual(["first"]);
		expect(() => inspectCompletedNativeHistory(text, "different")).toThrow("身份");
		expect(() =>
			inspectCompletedNativeHistory(
				`${text}${JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "second" } })}\n`,
				id,
			),
		).toThrow("尚未");
		expect(() => inspectCompletedNativeHistory(`${text}{`, id)).toThrow();
	});
	it("多工具回合逐请求加总、去重通知，不计历史、其他线程和 reasoning 子集", () => {
		const usage = (
			total: number,
			input: number,
			cached: number,
			output: number,
			turnId = "fresh",
			totalOutput = output,
		) => ({
			method: "thread/tokenUsage/updated",
			params: {
				threadId: "child",
				turnId,
				tokenUsage: {
					total: { inputTokens: total, outputTokens: totalOutput },
					last: { inputTokens: input, cachedInputTokens: cached, outputTokens: output, reasoningOutputTokens: 2 },
				},
			},
		});
		const frames = [
			usage(5000, 4000, 3900, 10, "historical"),
			usage(5100, 100, 80, 5, "fresh", 15),
			usage(5100, 100, 80, 5, "fresh", 15),
			usage(5300, 200, 150, 8, "fresh", 23),
		];
		const result = summarizeNewTurnUsage(frames, "child", "fresh");
		expect(result.status).toBe("measured");
		expect(result.totals).toEqual({
			inputTokens: 300,
			cachedInputTokens: 230,
			uncachedInputTokens: 70,
			outputTokens: 13,
		});
		expect(summarizeNewTurnUsage([], "child", "fresh").totals).toBeNull();
		expect(summarizeNewTurnUsage([usage(1, 10, 11, 2)], "child", "fresh").status).toBe("unknown");
		expect(summarizeNewTurnUsage([usage(1, 10, 5, 2), usage(1, 11, 5, 2)], "child", "fresh").status).toBe("unknown");
	});
	it("累计水位发现漏报时保持未知，补齐乱序通知后才能精确结算", () => {
		const usage = (totalInput: number, totalOutput: number, input: number, output: number) => ({
			method: "thread/tokenUsage/updated",
			params: {
				threadId: "child",
				turnId: "fresh",
				tokenUsage: {
					total: { inputTokens: totalInput, outputTokens: totalOutput },
					last: { inputTokens: input, cachedInputTokens: 0, outputTokens: output },
				},
			},
		});
		const first = usage(100, 20, 100, 20);
		const missing = usage(300, 30, 200, 10);
		const last = usage(600, 60, 300, 30);
		const verifiedEmptyThreadCounters = { inputTokens: 0, outputTokens: 0 };
		expect(summarizeNewTurnUsage([first], "child", "fresh")).toMatchObject({ status: "unknown", totals: null });
		expect(summarizeNewTurnUsage([first], "child", "fresh", { inputTokens: 100, outputTokens: 20 })).toMatchObject({
			status: "unknown",
			totals: null,
		});
		expect(summarizeNewTurnUsage([first, last], "child", "fresh", verifiedEmptyThreadCounters)).toMatchObject({
			status: "unknown",
			totals: null,
		});
		expect(
			summarizeNewTurnUsage([first, last, missing, first], "child", "fresh", verifiedEmptyThreadCounters),
		).toMatchObject({
			status: "measured",
			totals: { inputTokens: 600, outputTokens: 60 },
		});
	});
	it("提交或 fork 回执未知时先对账，不重发；隔离环境不继承生产控制面", () => {
		expect(decideOperationRecovery("submitting")).toBe("inspect-private-evidence-before-retry");
		expect(decideOperationRecovery("completed")).toBe("already-completed");
		expect(decideOperationRecovery("prepared")).toBe("execute-prepared-operation");
		const environment = isolatedProcessEnvironment("/private-home", "/private-temporary");
		expect(environment.CODEX_HOME).toBe("/private-home/codex-home");
		expect(environment.CODEX_SQLITE_HOME).toBe("/private-home/codex-sqlite-home");
		expect(Object.keys(environment).filter((key) => key.startsWith("KANBAN_"))).toEqual([]);
		const profile = createMacosExperimentSandboxProfile("/arm-one", ["/usr/bin/node"]);
		expect(profile).toContain("(deny default)");
		expect(profile).toContain('(subpath "/arm-one")');
		expect(profile).not.toContain("*:3484");
		const readOnlyProfile = createMacosExperimentSandboxProfile(
			"/arm-one",
			["/usr/bin/node"],
			["/arm-one/frozen-inputs"],
		);
		expect(readOnlyProfile).toContain('(deny file-write* (subpath "/arm-one/frozen-inputs"))');
		expect(() => createMacosExperimentSandboxProfile("/arm-one", [], ["/arm-two"])).toThrow("当前实验组");
		expect(() => createMacosExperimentSandboxProfile("/arm-one", [], ["/arm-one"])).toThrow("整个原生存储组");
		expect(profile).not.toContain("network-outbound");
		expect(createOwnedModelEndpointProxySandboxRule(23456)).toBe(
			'(allow network-outbound (remote tcp "localhost:23456"))\n',
		);
		expect(() => createOwnedModelEndpointProxySandboxRule(3484)).toThrow("专用端口");
		const endpoints = [{ hostname: "approved-model.example", port: 443 }];
		expect(requireApprovedModelProxyTarget("approved-model.example:443", endpoints)).toEqual(endpoints[0]);
		for (const authority of [
			"unapproved.example:443",
			"approved-model.example:3484",
			"approved-model.example:443@unapproved.example:443",
			"approved-model.example:443/path",
		])
			expect(() => requireApprovedModelProxyTarget(authority, endpoints)).toThrow();
	});
});

describe("排序实验的模型出站白名单", () => {
	it.each([
		{ name: "单一允许地址", addresses: [{ address: "203.0.113.9", family: 4 }] },
		{
			name: "混合允许与禁止地址",
			addresses: [
				{ address: "fdfe:dcba:9876::a", family: 6 },
				{ address: "127.0.0.1", family: 4 },
				{ address: "203.0.113.9", family: 4 },
			],
		},
	])("受控代理固定$name，拒绝其他 HTTPS 与全禁止解析，关闭时回收全部连接", async ({ addresses }) => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const server = createServer();
		vi.spyOn(server, "listen").mockImplementation(() => {
			queueMicrotask(() => server.emit("listening"));
			return server;
		});
		vi.spyOn(server, "address").mockReturnValue({ address: "127.0.0.1", family: "IPv4", port: 23456 });
		vi.spyOn(server, "close").mockImplementation((callback) => {
			callback?.();
			return server;
		});
		const createSocket = () => {
			const written: string[] = [];
			const stream = new Duplex({
				read() {},
				write(chunk, _encoding, callback) {
					written.push(chunk.toString());
					callback();
				},
			});
			Object.assign(stream, { setTimeout: vi.fn().mockReturnValue(stream) });
			return { socket: stream as unknown as Socket, written };
		};
		const upstream = createSocket();
		const connectToModel = vi.fn(() => upstream.socket);
		const resolveModel = vi.fn(async () => addresses);
		const proxy = await startModelEndpointEgressProxy(
			[{ hostname: "approved-model.example", port: 443 }],
			fixture.fixtureRootDirectoryPath,
			{
				createServer: ((listener: RequestListener) => {
					server.on("request", listener);
					return server;
				}) as typeof createServer,
				lookup: resolveModel as unknown as typeof lookup,
				connect: connectToModel,
			},
		);
		const handleConnect = server.listeners("connect")[0] as (
			request: { url: string },
			socket: Socket,
			head: Buffer,
		) => Promise<void>;
		const trackClient = server.listeners("connection").at(-1) as (socket: Socket) => void;
		const client = createSocket();
		trackClient(client.socket);
		try {
			await handleConnect({ url: "approved-model.example:443" }, client.socket, Buffer.from("first-model-bytes"));
			expect(connectToModel).toHaveBeenCalledWith({ host: "203.0.113.9", port: 443 });
			upstream.socket.emit("connect");
			expect(client.written.join("")).toContain("200 Connection Established");
			expect(upstream.written.join("")).toBe("first-model-bytes");
			client.socket.push("model-request");
			upstream.socket.push("model-response");
			await vi.waitFor(() => {
				expect(upstream.written.join("")).toContain("model-request");
				expect(client.written.join("")).toContain("model-response");
			});
			for (const authority of ["unapproved.example:443", "127.0.0.1:3484"]) {
				const denied = createSocket();
				trackClient(denied.socket);
				await handleConnect({ url: authority }, denied.socket, Buffer.alloc(0));
				expect(denied.written.join("")).toContain("403 Forbidden");
			}
			const response = { writeHead: vi.fn().mockReturnThis(), end: vi.fn() };
			const handleHttp = server.listeners("request")[0] as (
				request: { url: string },
				outgoingResponse: typeof response,
			) => Promise<void>;
			for (const url of ["http://unapproved.example/request", "https://approved-model.example/request"])
				await handleHttp({ url }, response);
			expect(response.writeHead).toHaveBeenCalledTimes(2);
			expect(response.writeHead).toHaveBeenCalledWith(403);
			resolveModel.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
			const localTarget = createSocket();
			trackClient(localTarget.socket);
			await handleConnect({ url: "approved-model.example:443" }, localTarget.socket, Buffer.alloc(0));
			expect(localTarget.written.join("")).toContain("403 Forbidden");
			expect(connectToModel).toHaveBeenCalledTimes(1);
		} finally {
			await proxy.close();
		}
		expect(client.socket.destroyed).toBe(true);
		expect(upstream.socket.destroyed).toBe(true);
	});
});

describe("排序实验独立仓库恢复", () => {
	it("私有安装保留物理 node_modules 语义，默认 Node 能运行同级 ESM 依赖", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const root = join(fixture.ownedIntegrationProjectsDirectoryPath, "node-module-resolution-restoration");
		await createOwnedExperimentRoot(root, join(fixture.fixtureRootDirectoryPath, "source-git-directory"));
		const source = join(fixture.fixtureRootDirectoryPath, "source-project");
		const modules = join(source, "node_modules");
		for (const name of ["consumer", "dependency"]) {
			mkdirSync(join(modules, name), { recursive: true });
			writeFileSync(
				join(modules, name, "package.json"),
				JSON.stringify({ name, type: "module", exports: "./index.js" }),
			);
		}
		writeFileSync(join(modules, "consumer/index.js"), 'export { value } from "dependency";');
		writeFileSync(join(modules, "dependency/index.js"), "export const value = 42;");
		const executeConsumer = (cwd: string) =>
			execFileSync(
				process.execPath,
				["--input-type=module", "-e", 'import {value} from "consumer"; process.stdout.write(String(value));'],
				{ cwd, env: fixture.createIsolatedChildProcessEnvironment(), encoding: "utf8" },
			);
		expect(executeConsumer(source)).toBe("42");
		const input = join(fixture.fixtureRootDirectoryPath, "environment-input.json");
		writeFileSync(
			input,
			JSON.stringify({
				schemaVersion: 1,
				directories: [{ sourcePath: modules, destinationName: "runtime-node-modules" }],
				executables: [],
			}),
		);
		await backupExecutionEnvironment(input, root);
		const restored = join(root, "private-execution-environment");
		await restoreExecutionEnvironmentIntoPrivateDirectories(root, restored);
		const project = join(root, "restored-project");
		mkdirSync(project);
		symlinkSync(join(restored, "runtime-node-modules/node_modules"), join(project, "node_modules"));
		expect(executeConsumer(project)).toBe("42");
	});
	it("备份不把最后一回合未完成当作无法保存；接续不会改动原工作树", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const source = fixture.createNonBareRepository({
			repositoryDirectoryName: "cohort-source",
			initialBranchName: "main",
		});
		writeFileSync(join(source.repositoryPath, "source.txt"), "基线\n");
		source.commitAllRepositoryFilesAtDate({ message: "基线", authorAndCommitterIsoDate: "2026-01-01T00:00:00Z" });
		const task = source.createLinkedWorktree({ worktreeDirectoryName: "alpha", branchName: "alpha" });
		writeFileSync(join(task.worktreePath, "source.txt"), "尚未提交\n");
		const metadata = join(fixture.fixtureRootDirectoryPath, "workspace-state");
		mkdirSync(metadata);
		const nativeHome = join(fixture.fixtureRootDirectoryPath, "private-codex-home");
		const transcriptDirectory = join(nativeHome, "sessions", "2026", "01", "01");
		mkdirSync(transcriptDirectory, { recursive: true });
		const id = "12345678-1234-4234-8234-123456789abc";
		const transcriptPath = join(transcriptDirectory, `rollout-${id}.jsonl`);
		const history = [
			{ type: "session_meta", payload: { id } },
			{ type: "event_msg", payload: { type: "task_started", turn_id: "unfinished" } },
		]
			.map((row) => JSON.stringify(row))
			.join("\n");
		writeFileSync(transcriptPath, history);
		writeFileSync(
			join(metadata, "board.json"),
			JSON.stringify({ columns: [{ id: "review", cards: [{ id: "alpha", createdAt: 1 }] }] }),
		);
		writeFileSync(
			join(metadata, "sessions.json"),
			JSON.stringify({
				alpha: {
					taskId: "alpha",
					agentId: "codex",
					agentNativeConversationSessionIdentity: { sourceAgentId: "codex", nativeSessionId: id, transcriptPath },
				},
			}),
		);
		const root = join(fixture.ownedIntegrationProjectsDirectoryPath, "reusable-cohort");
		const inputPath = join(fixture.fixtureRootDirectoryPath, "cohort-backup-input.json");
		writeFileSync(
			inputPath,
			JSON.stringify({
				schemaVersion: 1,
				projectPath: source.repositoryPath,
				baseRef: "main",
				requestArrivedAt: 1,
				workspaceStateDirectory: metadata,
				tasks: [
					{
						taskId: "alpha",
						worktreePath: task.worktreePath,
						artifactDirectories: [],
						readinessNote: "资格待核验",
					},
				],
				screenedTaskIds: ["alpha"],
				sharedEvidencePaths: [],
				workflowArtifactDirectories: [],
			}),
		);
		const before = readFileSync(join(task.worktreePath, "source.txt"));
		const first = await backupReusableTaskCohort(inputPath, root);
		expect(first[0].nativeSessions[0].frozenHistory).toMatchObject({
			status: "raw-history-preserved-boundary-unverified",
		});
		const second = await backupReusableTaskCohort(inputPath, root);
		expect(second[0].restoredTree).toBe(first[0].restoredTree);
		expect(readFileSync(join(task.worktreePath, "source.txt"))).toEqual(before);
		expect(readFileSync(transcriptPath, "utf8")).toBe(history);
	});
	it("旧备份中的 dd679 可读取和离线核验，但旧资格决定不能将其重新派生为实验工作负载", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const source = fixture.createNonBareRepository({
			repositoryDirectoryName: "excluded-workload-source",
			initialBranchName: "main",
		});
		writeFileSync(join(source.repositoryPath, "source.txt"), "原始交付\n");
		source.commitAllRepositoryFilesAtDate({
			message: "旧备份基线",
			authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
		});
		const task = source.createLinkedWorktree({ worktreeDirectoryName: "dd679", branchName: "dd679" });
		const metadata = join(fixture.fixtureRootDirectoryPath, "excluded-workload-metadata");
		mkdirSync(metadata);
		writeFileSync(join(metadata, "board.json"), JSON.stringify({ columns: [] }));
		writeFileSync(join(metadata, "sessions.json"), "{}");
		const root = join(fixture.ownedIntegrationProjectsDirectoryPath, "historical-cohort-with-excluded-task");
		const inputPath = join(fixture.fixtureRootDirectoryPath, "historical-cohort-backup-input.json");
		writeFileSync(
			inputPath,
			JSON.stringify({
				schemaVersion: 1,
				projectPath: source.repositoryPath,
				baseRef: "main",
				requestArrivedAt: 1,
				workspaceStateDirectory: metadata,
				tasks: [
					{ taskId: "dd679", worktreePath: task.worktreePath, artifactDirectories: [], readinessNote: "旧资格" },
				],
				screenedTaskIds: ["dd679"],
				sharedEvidencePaths: [],
				workflowArtifactDirectories: [],
			}),
		);
		expect(await backupReusableTaskCohort(inputPath, root)).toMatchObject([
			{ taskId: "dd679", sourceUnchanged: true },
		]);
		const environmentInputPath = join(fixture.fixtureRootDirectoryPath, "historical-cohort-environment-input.json");
		writeFileSync(environmentInputPath, JSON.stringify({ schemaVersion: 1, directories: [], executables: [] }));
		await backupExecutionEnvironment(environmentInputPath, root);
		expect(await verifyReusableTaskCohortBackup(root)).toMatchObject({
			status: "verified",
			restoredTasks: [{ taskId: "dd679", originalIndexBytesVerified: true }],
		});
		writeFileSync(
			join(root, "backup-acceptance-record.json"),
			JSON.stringify({
				status: "backup-complete-and-offline-restoration-verified",
				files: {
					"reusable-cohort-backup-manifest.json": fingerprint(
						readFileSync(join(root, "reusable-cohort-backup-manifest.json")),
					),
				},
			}),
		);
		const decisionsPath = join(fixture.fixtureRootDirectoryPath, "historical-cohort-eligibility-decisions.json");
		writeFileSync(
			decisionsPath,
			JSON.stringify({
				schemaVersion: 1,
				decisions: [{ taskId: "dd679", status: "inspect-exact-rvf", reason: "旧资格决定" }],
			}),
		);
		const destination = join(fixture.ownedIntegrationProjectsDirectoryPath, "derived-experiment-with-excluded-task");
		await expect(deriveReviewedBatchFromCohort(root, destination, decisionsPath)).rejects.toThrow("尚无精确准入任务");
		expect(
			JSON.parse(readFileSync(join(destination, "cohort-eligibility-and-delivery-deduplication.json"), "utf8")),
		).toMatchObject({
			backedUpTaskCount: 1,
			decisions: [{ taskId: "dd679", status: "excluded-from-experiment-workload" }],
		});
		expect(existsSync(join(destination, "frozen-batch-manifest.json"))).toBe(false);
	});

	it("按内容归档任务私有依赖，重复内容复用归档对象而不连接生产安装目录", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const root = join(fixture.ownedIntegrationProjectsDirectoryPath, "dependency-archive");
		await createOwnedExperimentRoot(root, join(fixture.fixtureRootDirectoryPath, "source-git-directory"));
		const first = join(fixture.fixtureRootDirectoryPath, "common-installation");
		const second = join(fixture.fixtureRootDirectoryPath, "task-installation");
		mkdirSync(first);
		mkdirSync(second);
		writeFileSync(join(first, "same.js"), "共享内容");
		writeFileSync(join(second, "same.js"), "共享内容");
		writeFileSync(join(second, "changed.js"), "任务新增依赖");
		symlinkSync("same.js", join(second, "relative-link"));
		symlinkSync(join(first, "same.js"), join(second, "external-link"));
		const input = join(fixture.fixtureRootDirectoryPath, "environment-input.json");
		writeFileSync(
			input,
			JSON.stringify({
				schemaVersion: 1,
				directories: [{ sourcePath: first, destinationName: "common-node-modules" }],
				executables: [],
			}),
		);
		await backupExecutionEnvironment(input, root);
		const bindings = join(fixture.fixtureRootDirectoryPath, "task-source-bindings.json");
		writeFileSync(bindings, JSON.stringify({ [second]: ["alpha:node_modules"] }));
		const result = await appendTaskDependencyEnvironmentBackups(root, bindings);
		expect(result.newObjectCount).toBe(1);
		expect(result.outsideSymlinkCount).toBe(1);
		const index = JSON.parse(
			readFileSync(join(root, "execution-environment", "task-alpha-node-modules-manifest.json"), "utf8"),
		);
		expect(index.files.find((file: { path: string }) => file.path === "same.js").archivedRelativePath).toBe(
			"common-node-modules/same.js",
		);
		expect(readFileSync(join(second, "changed.js"), "utf8")).toBe("任务新增依赖");
		expect((await appendTaskDependencyEnvironmentBackups(root, bindings)).newObjectCount).toBe(0);
		rmSync(join(first, "same.js"));
		rmSync(join(second, "same.js"));
		const restored = join(root, "restored-private-installations");
		await restoreExecutionEnvironmentIntoPrivateDirectories(root, restored);
		expect(readFileSync(join(restored, "task-alpha-node-modules", "external-link"), "utf8")).toBe("共享内容");
		writeFileSync(join(restored, "task-alpha-node-modules", "changed.js"), "仅修改副本");
		expect(readFileSync(join(second, "changed.js"), "utf8")).toBe("任务新增依赖");
	});

	it("跨 common-dir 保留原始 split index、WIP、二进制、模式和链接，拒绝越界", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const source = fixture.createNonBareRepository({ repositoryDirectoryName: "source", initialBranchName: "main" });
		writeFileSync(join(source.repositoryPath, "changed.txt"), "原始\n");
		writeFileSync(join(source.repositoryPath, "deleted.txt"), "待删除\n");
		writeFileSync(join(source.repositoryPath, "executable.sh"), "echo 原始\n");
		writeFileSync(join(source.repositoryPath, ".gitignore"), "ignored-secret\n");
		source.commitAllRepositoryFilesAtDate({ message: "初始", authorAndCommitterIsoDate: "2026-01-01T00:00:00Z" });
		writeFileSync(join(source.repositoryPath, "changed.txt"), "暂存版本\n");
		source.runGit(["add", "changed.txt"]);
		writeFileSync(join(source.repositoryPath, "changed.txt"), "工作版本\n");
		rmSync(join(source.repositoryPath, "deleted.txt"));
		writeFileSync(join(source.repositoryPath, "binary.bin"), Buffer.from([0, 1, 255]));
		writeFileSync(join(source.repositoryPath, "ignored-secret"), "禁止复制\n");
		chmodSync(join(source.repositoryPath, "executable.sh"), 0o755);
		symlinkSync("changed.txt", join(source.repositoryPath, "relative-link"));
		source.runGit(["update-index", "--split-index"]);
		const originalStatus = source.runGit(["status", "--porcelain=v1"]).stdout;
		const root = join(fixture.ownedIntegrationProjectsDirectoryPath, "ordering-experiment");
		await createOwnedExperimentRoot(root, join(source.repositoryPath, ".git"));
		const archive = join(root, "frozen-source");
		await captureSourceGitWorkingState(source.repositoryPath, archive);
		const targetPath = join(root, "restored-repository");
		mkdirSync(targetPath);
		const target = fixture.createNonBareRepositoryAtOwnedPath({ repositoryPath: targetPath });
		await materializeIndependentWorkingState(root, archive, targetPath);
		expect(readFileSync(join(targetPath, ".git/index"))).toEqual(readFileSync(join(archive, "source-git-index")));
		expect(target.runGit(["--no-optional-locks", "status", "--porcelain=v1"]).stdout).toBe(originalStatus);
		expect(source.runGit(["status", "--porcelain=v1"]).stdout).toBe(originalStatus);
		expect(target.runGit(["show", ":changed.txt"]).stdout).toBe("暂存版本\n");
		expect(readFileSync(join(targetPath, "changed.txt"), "utf8")).toBe("工作版本\n");
		expect(readFileSync(join(targetPath, "binary.bin"))).toEqual(Buffer.from([0, 1, 255]));
		expect(readlinkSync(join(targetPath, "relative-link"))).toBe("changed.txt");
		expect(statSync(join(targetPath, "executable.sh")).mode & 0o111).toBe(0o111);
		expect(readFileSync(join(targetPath, ".git/index"))).toEqual(readFileSync(join(archive, "source-git-index")));
		expect(target.runGit(["remote"]).stdout).toBe("");
		await expect(safeEntryPath(targetPath, "../source")).rejects.toThrow("路径");
		symlinkSync(source.repositoryPath, join(targetPath, "escape-link"));
		await expect(safeEntryPath(targetPath, "escape-link/danger")).rejects.toThrow("符号链接");
		symlinkSync(join(source.repositoryPath, "changed.txt"), join(targetPath, "file-ancestor-link"));
		await expect(safeEntryPath(targetPath, "file-ancestor-link/missing-parent/child")).rejects.toThrow("符号链接");
		await expect(materializeIndependentWorkingState(root, archive, source.repositoryPath)).rejects.toThrow("所有权");
		await expect(materializeIndependentWorkingState(root, archive, targetPath)).rejects.toThrow("空的");
	});
});
