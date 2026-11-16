import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { getRuntimeFetch } from "../../../src/core/runtime-endpoint";
import {
	type LocalRedeploymentRequest,
	localRedeploymentSha256,
} from "../../../src/deployment/local-redeployment-preparation";
import { readLocalRedeploymentWorkspaceState } from "../../../src/deployment/local-redeployment-state-preservation";
import {
	getWorkspaceStateSnapshotReadFingerprintById,
	loadPersistedWorkspaceStateById,
	type PersistedWorkspaceStateById,
} from "../../../src/state/workspace-state";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

vi.mock("../../../src/core/runtime-endpoint", () => ({ getRuntimeFetch: vi.fn() }));
vi.mock("../../../src/state/workspace-state", () => ({
	getWorkspaceStateSnapshotReadFingerprintById: vi.fn(),
	loadPersistedWorkspaceStateById: vi.fn(),
	listWorkspaceIndexEntries: vi.fn(),
}));

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getWorkspaceStateSnapshotReadFingerprintById).mockResolvedValue("committed-snapshot-identity");
});

function createWorkspaceStateRecoveryFixture() {
	const fixture = createIsolatedGitTestWorkspaceFixture();
	onTestFinished(fixture.cleanup);
	const directory = join(fixture.fixtureRootDirectoryPath, "workspace-state-verification");
	const state: PersistedWorkspaceStateById = {
		workspaceId: "isolated-workspace",
		statePath: join(fixture.isolatedHomeDirectoryPath, "workspace-state"),
		board: { columns: [] },
		sessions: {},
		revision: 42,
	};
	const request: LocalRedeploymentRequest = {
		schemaVersion: 1,
		executionId: "032609d8-7508-4bdc-b202-1d7bd7da8a14",
		workspaceId: state.workspaceId,
		taskId: "isolated-task",
		originatingTaskWorktreePath: fixture.fixtureRootDirectoryPath,
		sourceCheckoutPath: fixture.fixtureRootDirectoryPath,
		candidateSourceCommit: "a".repeat(40),
		deploymentNodeBinaryPath: process.execPath,
		distributionDirectoryPath: join(fixture.fixtureRootDirectoryPath, "distribution"),
		runtimeIdentity: {
			runtimeHomeDirectoryPath: fixture.isolatedHomeDirectoryPath,
			runtimeHost: "127.0.0.1",
			runtimePort: 39884,
		},
		serviceLaunch: { command: [process.execPath] },
		authorization: { sourceReference: "test:workspace-state-recovery", userRequestQuote: "仅验证隔离实例" },
	};
	vi.mocked(loadPersistedWorkspaceStateById).mockResolvedValue(state);
	const checkpointName = `${localRedeploymentSha256(`workspace-state:${state.workspaceId}`)}.json`;
	return { directory, state, request, checkpointName };
}

function respondWithWorkspaceState(value: unknown) {
	vi.mocked(getRuntimeFetch).mockResolvedValue(
		vi.fn(async () => new Response(JSON.stringify({ result: { data: value } }))),
	);
}

describe("workspace API 结构或身份缺证时采用已提交快照，保留身份门禁", () => {
	it.each(["missing_identity", "wrong_identity", "invalid_board"] as const)(
		"HTTP 200 的 %s 响应使用原生一致快照补证",
		async (invalidResponseKind) => {
			const { directory, state, request, checkpointName } = createWorkspaceStateRecoveryFixture();
			const { workspaceId: _workspaceId, ...stateWithoutIdentity } = state;
			respondWithWorkspaceState(
				invalidResponseKind === "missing_identity"
					? stateWithoutIdentity
					: invalidResponseKind === "wrong_identity"
						? { ...state, workspaceId: "another-workspace" }
						: { ...state, board: { columns: null } },
			);
			expect(await readLocalRedeploymentWorkspaceState(request, directory, state.workspaceId)).toEqual(state);
			expect(loadPersistedWorkspaceStateById).toHaveBeenCalledWith(state.workspaceId);
			const checkpoint = JSON.parse(
				await readFile(join(directory, "verification-checkpoints", checkpointName), "utf8"),
			);
			expect(checkpoint).toMatchObject({
				evidenceSource: "consistent_persisted_workspace_snapshot",
				inputFingerprint: "committed-snapshot-identity",
				value: { workspaceId: state.workspaceId, revision: 42 },
			});
		},
	);

	it("API 自带完整所属身份时保留在线证据来源", async () => {
		const { directory, state, request, checkpointName } = createWorkspaceStateRecoveryFixture();
		respondWithWorkspaceState(state);
		expect(await readLocalRedeploymentWorkspaceState(request, directory, state.workspaceId)).toEqual(state);
		expect(loadPersistedWorkspaceStateById).not.toHaveBeenCalled();
		const checkpoint = JSON.parse(
			await readFile(join(directory, "verification-checkpoints", checkpointName), "utf8"),
		);
		expect(checkpoint.evidenceSource).toBe("runtime_workspace_getState");
	});

	it("补证快照归属错误时继续拒绝，不产生通过记录", async () => {
		const { directory, state, request, checkpointName } = createWorkspaceStateRecoveryFixture();
		respondWithWorkspaceState({ board: state.board });
		vi.mocked(loadPersistedWorkspaceStateById).mockResolvedValue({ ...state, workspaceId: "another-workspace" });
		await expect(readLocalRedeploymentWorkspaceState(request, directory, state.workspaceId)).rejects.toThrow(
			"核验结果身份或结构不完整",
		);
		await expect(readFile(join(directory, "verification-checkpoints", checkpointName))).rejects.toMatchObject({
			code: "ENOENT",
		});
		expect(JSON.parse(await readFile(join(directory, "machine-evidence-requests", checkpointName), "utf8"))).toEqual({
			kind: "verification_check",
			checkKey: `workspace-state:${state.workspaceId}`,
		});
	});
});
