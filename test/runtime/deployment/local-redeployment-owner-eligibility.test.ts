import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runtimeBoardCardSchema, runtimeTaskSessionSummarySchema } from "../../../src/core/api-contract";
import {
	assertLocalRedeploymentOwnerStillEligible,
	type FrozenLocalRedeploymentRequest,
	LOCAL_REDEPLOYMENT_AUTHORIZED_OWNER_INTERRUPTION_FILENAME,
} from "../../../src/deployment/local-redeployment-preparation";
import {
	listWorkspaceIndexEntries,
	loadPersistedWorkspaceSessionsById,
	loadPersistedWorkspaceStateById,
} from "../../../src/state/workspace-state";
import { createTaskConversationSessionOperationStore } from "../../../src/task-conversation-sessions/task-conversation-session-operation-store";
import { createTempDir } from "../../utilities/temp-dir";

vi.mock("../../../src/state/workspace-state", () => ({
	listWorkspaceIndexEntries: vi.fn(),
	loadPersistedWorkspaceSessionsById: vi.fn(),
	loadPersistedWorkspaceStateById: vi.fn(),
}));
vi.mock("../../../src/task-conversation-sessions/task-conversation-session-operation-store", () => ({
	createTaskConversationSessionOperationStore: vi.fn(),
}));
const readOperations = vi.fn();
let sandbox: ReturnType<typeof createTempDir>;
beforeEach(() => {
	vi.resetAllMocks();
	sandbox = createTempDir("local-redeployment-frozen-owner-");
	vi.mocked(createTaskConversationSessionOperationStore).mockReturnValue({
		read: readOperations,
		observeExplicitStopMarkerVersion: vi.fn(),
		clearExplicitStopMarkersIfObservationUnchanged: vi.fn(),
		recordExplicitStopMarkers: vi.fn(),
		clearExplicitStopMarker: vi.fn(),
		migrateTransferredExplicitStopMarkers: vi.fn(),
		update: vi.fn(),
		listScopes: vi.fn(),
	});
	readOperations.mockResolvedValue({ explicitlyStoppedSessionIds: [] });
});
afterEach(() => sandbox.cleanup());

async function createOwnerContext() {
	const metadata = await stat(sandbox.path);
	const frozen = {
		requestSha256: "b".repeat(64),
		request: {
			workspaceId: "workspace",
			taskId: "task",
			executionId: "deployment",
			originatingTaskWorktreePath: sandbox.path,
		},
		owner: {
			taskIncarnationCreatedAtEpochMs: 1,
			conversationSessionId: "original-session",
			nativeSessionId: "original-native",
			runtimeSessionIncarnationId: "original-generation",
			worktreeIdentity: {
				realPath: await realpath(sandbox.path),
				device: metadata.dev,
				inode: metadata.ino,
				createdAtEpochMs: metadata.birthtimeMs,
			},
		},
	} as FrozenLocalRedeploymentRequest;
	const card = runtimeBoardCardSchema.parse({
		id: "task",
		createdAt: 1,
		updatedAt: 1,
		mainTaskConversationSessionId: "original-session",
		prompt: "隔离部署",
		baseRef: "main",
		startInPlanMode: false,
	});
	const summary = runtimeTaskSessionSummarySchema.parse({
		taskId: "original-session",
		state: "running",
		agentId: "codex",
		pid: null,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		workspacePath: sandbox.path,
		runtimeSessionIncarnationId: "original-generation",
		agentNativeConversationSessionIdentity: {
			nativeSessionId: "original-native",
			sourceAgentId: "codex",
			transcriptPath: null,
			observedAt: 1,
		},
	});
	vi.mocked(listWorkspaceIndexEntries).mockResolvedValue([{ workspaceId: "workspace", repoPath: sandbox.path }]);
	vi.mocked(loadPersistedWorkspaceStateById).mockResolvedValue({
		workspaceId: "workspace",
		revision: 1,
		statePath: join(sandbox.path, "workspace-state.json"),
		sessions: {},
		board: { columns: [{ id: "in_progress", title: "进行中", cards: [card] }] },
	});
	vi.mocked(loadPersistedWorkspaceSessionsById).mockResolvedValue({ "original-session": summary });
	return { frozen, card, summary };
}

describe("后续部署动作严格复核冻结会话", () => {
	it("冻结 owner 仍匹配时可以继续", async () => {
		const { frozen } = await createOwnerContext();
		await expect(assertLocalRedeploymentOwnerStillEligible(sandbox.path, frozen)).resolves.toBeUndefined();
	});
	it.each(["main-session", "native-session", "runtime-generation"])("%s 改变时拒绝旧请求", async (change) => {
		const context = await createOwnerContext();
		if (change === "main-session") context.card.mainTaskConversationSessionId = "replacement-session";
		if (change === "native-session")
			context.summary.agentNativeConversationSessionIdentity = {
				nativeSessionId: "replacement-native",
				sourceAgentId: "codex",
				transcriptPath: null,
				observedAt: 2,
			};
		if (change === "runtime-generation") context.summary.runtimeSessionIncarnationId = "replacement-generation";
		await expect(assertLocalRedeploymentOwnerStillEligible(sandbox.path, context.frozen)).rejects.toThrow("变化");
	});
	it("持久 Stop 留下本执行撤销原件", async () => {
		const { frozen } = await createOwnerContext();
		readOperations.mockResolvedValue({ explicitlyStoppedSessionIds: ["original-session"] });
		await expect(assertLocalRedeploymentOwnerStillEligible(sandbox.path, frozen)).rejects.toThrow("持久 Stop");
		expect(JSON.parse(await readFile(join(sandbox.path, "redeployment-revocation.json"), "utf8"))).toMatchObject({
			executionId: "deployment",
			source: "persistent_explicit_session_stop",
		});
	});
	it("只在该执行已验收授权交接之后允许原发起会话退出，明确 Stop 仍撤销", async () => {
		const { frozen } = await createOwnerContext();
		frozen.request.nonPreservableSessionInterruptionAuthorization = {
			sourceReference: "test:isolated-restart-approval",
			userRequestQuote: "允许中断无法保留的隔离会话",
		};
		vi.mocked(loadPersistedWorkspaceSessionsById).mockResolvedValue({});
		const interruptionReceiptPath = join(sandbox.path, LOCAL_REDEPLOYMENT_AUTHORIZED_OWNER_INTERRUPTION_FILENAME);
		const authorizedOwnerSession = {
			workspaceId: "workspace",
			conversationSessionId: "original-session",
			nativeConversationSessionId: "original-native",
			runtimeSessionIncarnationId: "original-generation",
		};
		const interruptionReceipt = {
			requestSha256: frozen.requestSha256,
			dispatchedAtEpochMs: 10,
			runtimeBefore: { processId: 100, processStartTimeText: "previous-runtime" },
			nativeHandover: {
				outcome: "handover_restart_started",
				runtimeProcessId: 100,
				runtimeProcessStartTimeText: "previous-runtime",
				authorizedUnretainableSessionHandoverBound: true,
			},
			authorizedOwnerSession,
		};
		await writeFile(interruptionReceiptPath, JSON.stringify(interruptionReceipt));
		const manifest = {
			executionId: frozen.request.executionId,
			redeploymentRequestSha256: frozen.requestSha256,
			candidateDistributionSha256: "c".repeat(64),
		};
		await writeFile(join(sandbox.path, "local-deployment-execution.json"), JSON.stringify({ manifest }));
		await expect(assertLocalRedeploymentOwnerStillEligible(sandbox.path, frozen)).rejects.toThrow("变化");
		await writeFile(
			join(sandbox.path, "runtime-restart-acceptance.json"),
			JSON.stringify({
				executionId: manifest.executionId,
				candidateDistributionSha256: manifest.candidateDistributionSha256,
				observedAtEpochMs: 11,
				runtime: { ok: true, runtimeProcessId: 101, runtimeProcessStartTimeText: "replacement-runtime" },
			}),
		);
		await expect(assertLocalRedeploymentOwnerStillEligible(sandbox.path, frozen)).rejects.toThrow("变化");
		await writeFile(
			interruptionReceiptPath,
			JSON.stringify({
				...interruptionReceipt,
				nativeHandover: {
					...interruptionReceipt.nativeHandover,
					authorizedUnretainableSessionsAtHandoverAcceptance: [
						{ ...authorizedOwnerSession, processId: 99, sessionKind: "acp_stdio_subprocess" },
					],
				},
			}),
		);
		await expect(assertLocalRedeploymentOwnerStillEligible(sandbox.path, frozen)).resolves.toBeUndefined();
		readOperations.mockResolvedValue({ explicitlyStoppedSessionIds: ["original-session"] });
		await expect(assertLocalRedeploymentOwnerStillEligible(sandbox.path, frozen)).rejects.toThrow("持久 Stop");
	});
	it("候选换代但缺少目标代际的原生交接回执时，不放宽原会话归属", async () => {
		const { frozen } = await createOwnerContext();
		frozen.request.nonPreservableSessionInterruptionAuthorization = {
			sourceReference: "test:isolated-restart-approval",
			userRequestQuote: "允许中断无法保留的隔离会话",
		};
		vi.mocked(loadPersistedWorkspaceSessionsById).mockResolvedValue({});
		await writeFile(
			join(sandbox.path, "local-deployment-execution.json"),
			JSON.stringify({
				manifest: {
					executionId: frozen.request.executionId,
					redeploymentRequestSha256: frozen.requestSha256,
					candidateDistributionSha256: "c".repeat(64),
				},
			}),
		);
		await writeFile(
			join(sandbox.path, "runtime-restart-acceptance.json"),
			JSON.stringify({
				executionId: frozen.request.executionId,
				candidateDistributionSha256: "c".repeat(64),
				observedAtEpochMs: 11,
				runtime: { ok: true, runtimeProcessId: 101, runtimeProcessStartTimeText: "replacement-runtime" },
			}),
		);
		await writeFile(
			join(sandbox.path, LOCAL_REDEPLOYMENT_AUTHORIZED_OWNER_INTERRUPTION_FILENAME),
			JSON.stringify({
				requestSha256: frozen.requestSha256,
				dispatchedAtEpochMs: 10,
				runtimeBefore: { processId: 100, processStartTimeText: "previous-runtime" },
			}),
		);
		await expect(assertLocalRedeploymentOwnerStillEligible(sandbox.path, frozen)).rejects.toThrow("变化");
		const receipt = JSON.parse(
			await readFile(join(sandbox.path, LOCAL_REDEPLOYMENT_AUTHORIZED_OWNER_INTERRUPTION_FILENAME), "utf8"),
		);
		receipt.nativeHandover = { outcome: "handover_restart_started", runtimeProcessId: 404 };
		await writeFile(
			join(sandbox.path, LOCAL_REDEPLOYMENT_AUTHORIZED_OWNER_INTERRUPTION_FILENAME),
			JSON.stringify(receipt),
		);
		await expect(assertLocalRedeploymentOwnerStillEligible(sandbox.path, frozen)).rejects.toThrow("变化");
		receipt.nativeHandover = {
			outcome: "handover_restart_started",
			runtimeProcessId: 100,
			runtimeProcessStartTimeText: "previous-runtime",
		};
		receipt.authorizedOwnerSession = {
			workspaceId: "workspace",
			conversationSessionId: "original-session",
			nativeConversationSessionId: "original-native",
			runtimeSessionIncarnationId: "original-generation",
		};
		await writeFile(
			join(sandbox.path, LOCAL_REDEPLOYMENT_AUTHORIZED_OWNER_INTERRUPTION_FILENAME),
			JSON.stringify(receipt),
		);
		await expect(assertLocalRedeploymentOwnerStillEligible(sandbox.path, frozen)).rejects.toThrow("变化");
	});
});
