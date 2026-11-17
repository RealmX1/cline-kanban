import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { getRuntimeFetch } from "../../../src/core/runtime-endpoint";
import { startPreparedLocalRedeployment } from "../../../src/deployment/local-redeployment-owned-execution";
import {
	assertLocalRedeploymentOwnerStillEligible,
	createLocalRedeploymentOwnedCommandSpecification,
	type FrozenLocalRedeploymentRequest,
	readFrozenLocalRedeploymentRequest,
} from "../../../src/deployment/local-redeployment-preparation";
import { observeLocalRedeploymentRuntimeBaseline } from "../../../src/deployment/local-redeployment-standard-execution";
import { readTaskCommandExecutions } from "../../../src/task-command-execution/task-command-execution-store";
import {
	inspectOwnedCommandSupervisor,
	launchOwnedCommandSupervisor,
	readProcessIdentity,
	readSystemBootIdentity,
} from "../../../src/task-command-execution/task-command-execution-supervisor";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

vi.mock("../../../src/core/runtime-endpoint", () => ({ getRuntimeFetch: vi.fn() }));
vi.mock("../../../src/deployment/local-redeployment-preparation", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	readFrozenLocalRedeploymentRequest: vi.fn(),
	assertLocalRedeploymentOwnerStillEligible: vi.fn(),
}));
vi.mock("../../../src/deployment/local-redeployment-standard-execution", () => ({
	observeLocalRedeploymentRuntimeBaseline: vi.fn(),
	observeStandardLocalRedeploymentRecoveryEvidence: vi.fn(),
}));
vi.mock("../../../src/task-command-execution/task-command-execution-store", () => ({
	readTaskCommandExecutions: vi.fn(),
	taskCommandExecutionArtifactDirectory: (_workspaceId: string, executionId: string) =>
		join(process.env.HOME ?? "", "supervisor-artifacts", executionId),
}));
vi.mock("../../../src/task-command-execution/task-command-execution-supervisor", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	inspectOwnedCommandSupervisor: vi.fn(),
	launchOwnedCommandSupervisor: vi.fn(),
	cancelOwnedCommandProcesses: vi.fn(),
	readProcessIdentity: vi.fn(),
	readSystemBootIdentity: vi.fn(),
}));

beforeEach(() => vi.resetAllMocks());
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("在线登记结果未知时避免重复离线派发", () => {
	const registrationRecoveryScenarios = [
		"原进程仍存活",
		"原生身份暂时不可读",
		"旧runtime仅拒绝可选清理字段",
		"其它schema拒绝不能降级",
	];
	it.each(registrationRecoveryScenarios)("%s", async (condition) => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		onTestFinished(fixture.cleanup);
		vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
		vi.stubEnv("CODEX_HOME", join(fixture.isolatedHomeDirectoryPath, ".codex"));
		vi.stubEnv("CODEX_SQLITE_HOME", join(fixture.isolatedHomeDirectoryPath, ".codex"));
		const directory = join(fixture.fixtureRootDirectoryPath, "persistent-redeployment");
		await mkdir(directory);
		const frozen: FrozenLocalRedeploymentRequest = {
			request: {
				schemaVersion: 1,
				executionId: "032609d8-7508-4bdc-b202-1d7bd7da8a14",
				workspaceId: "workspace",
				taskId: "task",
				originatingTaskWorktreePath: fixture.fixtureRootDirectoryPath,
				sourceCheckoutPath: fixture.fixtureRootDirectoryPath,
				candidateSourceCommit: "a".repeat(40),
				deploymentNodeBinaryPath: process.execPath,
				distributionDirectoryPath: join(fixture.fixtureRootDirectoryPath, "dist"),
				runtimeIdentity: {
					runtimeHomeDirectoryPath: join(fixture.isolatedHomeDirectoryPath, ".cline/kanban"),
					runtimeHost: "127.0.0.1",
					runtimePort: 39884,
				},
				serviceLaunch: { command: [process.execPath] },
				authorization: { sourceReference: "test:isolated", userRequestQuote: "仅隔离部署" },
			},
			requestSha256: "b".repeat(64),
			executorSha256: "c".repeat(64),
			npmCliEntrypointPath: join(fixture.fixtureRootDirectoryPath, "npm-cli.js"),
			serviceExecutableSha256: "d".repeat(64),
			owner: {
				taskIncarnationCreatedAtEpochMs: 1,
				conversationSessionId: "task",
				nativeSessionId: "native-session",
				runtimeSessionIncarnationId: "session-generation",
				worktreeIdentity: {
					realPath: fixture.fixtureRootDirectoryPath,
					device: 1,
					inode: 1,
					createdAtEpochMs: 1,
				},
			},
		};
		await writeFile(
			join(directory, "owned-command-specification.json"),
			JSON.stringify(createLocalRedeploymentOwnedCommandSpecification(directory, frozen)),
		);
		vi.mocked(readFrozenLocalRedeploymentRequest).mockResolvedValue(frozen);
		vi.mocked(assertLocalRedeploymentOwnerStillEligible).mockResolvedValue(undefined);
		vi.mocked(readTaskCommandExecutions).mockResolvedValue([]);
		vi.mocked(readSystemBootIdentity).mockResolvedValue("same-system-boot");
		vi.mocked(inspectOwnedCommandSupervisor).mockResolvedValue("not_started");
		vi.mocked(launchOwnedCommandSupervisor).mockResolvedValue(undefined);
		vi.mocked(observeLocalRedeploymentRuntimeBaseline).mockResolvedValue({
			state: "verified_online",
			runtimeBefore: { processId: 12345, processStartTimeText: "Fri Nov 13 12:00:00 2026" },
		});
		if (condition === "旧runtime仅拒绝可选清理字段" || condition === "其它schema拒绝不能降级") {
			const keys =
				condition === "旧runtime仅拒绝可选清理字段" ? ["postProcessExitCleanupCommand"] : ["expectedOwner"];
			const fetchRuntime = vi
				.fn()
				.mockResolvedValueOnce(
					new Response(
						JSON.stringify({ error: { message: JSON.stringify([{ code: "unrecognized_keys", keys }]) } }),
						{ status: 400 },
					),
				)
				.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));
			vi.mocked(getRuntimeFetch).mockResolvedValue(fetchRuntime);
			if (condition === "其它schema拒绝不能降级") {
				await expect(startPreparedLocalRedeployment(directory)).rejects.toThrow("HTTP 400");
				expect(fetchRuntime).toHaveBeenCalledTimes(1);
			} else {
				expect(await startPreparedLocalRedeployment(directory)).toMatchObject({
					mode: "online_owned_execution",
				});
				expect(fetchRuntime).toHaveBeenCalledTimes(2);
				const first = JSON.parse(fetchRuntime.mock.calls[0][1].body);
				const second = JSON.parse(fetchRuntime.mock.calls[1][1].body);
				expect(second).toMatchObject({
					expectedOwner: first.expectedOwner,
					idempotencyKey: first.idempotencyKey,
				});
				expect(second.specification.postProcessExitCleanupCommand).toBeUndefined();
				expect(
					JSON.parse(await readFile(join(directory, "owned-command-specification.json"), "utf8"))
						.postProcessExitCleanupCommand,
				).toBeDefined();
				expect(
					JSON.parse(
						await readFile(join(directory, "online-registration-optional-cleanup-compatibility.json"), "utf8"),
					).deferredCleanupCommand,
				).toBeDefined();
			}
			return;
		}
		vi.mocked(getRuntimeFetch).mockResolvedValue(vi.fn().mockRejectedValue(new Error("在线登记超时")));
		await expect(startPreparedLocalRedeployment(directory)).rejects.toThrow("在线登记超时");
		vi.mocked(observeLocalRedeploymentRuntimeBaseline).mockResolvedValue({
			state: "verified_offline",
			runtimeBefore: null,
			listenerObservation: "connection_refused_and_no_listener",
			systemBootIdentity: "same-system-boot",
		});
		if (condition === "原进程仍存活")
			vi.mocked(readProcessIdentity).mockResolvedValue({
				pid: 12345,
				startAndCommand: "Fri Nov 13 12:00:00 2026 node runtime",
			});
		else vi.mocked(readProcessIdentity).mockRejectedValue(new Error("原生查询暂时超时"));
		expect(await startPreparedLocalRedeployment(directory)).toMatchObject({ mode: "machine_evidence_pending" });
		expect(launchOwnedCommandSupervisor).not.toHaveBeenCalled();
		vi.mocked(readProcessIdentity).mockResolvedValue(null);
		vi.spyOn(process, "kill").mockImplementation(() => {
			throw Object.assign(new Error("原 PID 已退出"), { code: "ESRCH" });
		});
		expect(await startPreparedLocalRedeployment(directory)).toMatchObject({
			mode: "independent_execution_pending_runtime_adoption",
		});
		expect(launchOwnedCommandSupervisor).toHaveBeenCalledTimes(1);
	});
});
