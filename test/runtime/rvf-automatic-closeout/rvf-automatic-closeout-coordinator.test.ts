import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RvfAutomaticCloseoutRecord } from "../../../src/core/rvf-automatic-closeout-contract";
import { type LockRequest, lockedFileSystem } from "../../../src/fs/locked-file-system";
import {
	createRvfAutomaticCloseoutCoordinator,
	RvfAutomaticCloseoutPauseError,
} from "../../../src/rvf-automatic-closeout/rvf-automatic-closeout-coordinator";
import {
	readRvfAutomaticCloseoutRecords,
	updateRvfAutomaticCloseoutRecords,
} from "../../../src/rvf-automatic-closeout/rvf-automatic-closeout-store";

function record(): RvfAutomaticCloseoutRecord {
	return {
		workspaceId: "workspace",
		taskId: "task",
		conversationSessionId: "task",
		receipt: {
			schema: "rvf-independent-user-turn-boundary/v1",
			decision_token: "0123456789abcdef",
			session_id: "source",
			worktree: "/worktree",
			native_user_message_id: "boundary-message",
			native_turn_id: "boundary",
			transcript_path: "/source.jsonl",
			boundary_message_sha256: "hash",
			candidate_fingerprint: "candidate",
			worktree_head_commit_sha: "head",
			checkpoint_commit: "checkpoint",
			checkpoint_tree: "tree",
			comparison_base_tip: null,
			comparison_base_ref: null,
			comparison_base_ref_tip: null,
			source: "rvf_automatic_decision_message",
			kanban_task_id: "task",
			idempotency_key: "decision",
		},
		preReviewTurnIds: ["implementation"],
		status: "awaiting_rvf_completion",
		createdAt: 1,
		updatedAt: 1,
		runId: null,
		runDirectory: null,
		handoffPath: null,
		handoffSha256: null,
		restoredNativeSessionId: null,
		restoredTranscriptPath: null,
		pauseReason: null,
		promptDeliveryIdempotencyKey: "closeout",
		restoreWorkspaceStateSha256: null,
		nativeIdentitySwitchStartedAt: null,
		nativeForkAttemptStartedAt: null,
	};
}
const directories: string[] = [];
const childProcesses: ChildProcess[] = [];
afterEach(async () => {
	await Promise.all(
		childProcesses.splice(0).map(async (child) => {
			if (child.exitCode !== null || child.signalCode !== null) return;
			const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
			child.kill("SIGKILL");
			await exited;
		}),
	);
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
	vi.restoreAllMocks();
});
async function setup() {
	const directory = await mkdtemp(join(tmpdir(), "kanban-rvf-closeout-test-"));
	directories.push(directory);
	const path = join(directory, "records.json");
	await updateRvfAutomaticCloseoutRecords(path, () => ({ records: [record()], value: null }));
	return path;
}
function createDeferredCloseoutOperationSignal() {
	let resolve!: () => void;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}
describe("RVF 自动收尾持久编排", () => {
	it("两个独立 coordinator 不能用旧快照重复恢复和投递", async () => {
		const path = await setup();
		const inspectionStarted = createDeferredCloseoutOperationSignal();
		const releaseInspection = createDeferredCloseoutOperationSignal();
		let inspections = 0;
		const dependencies = {
			storePath: path,
			inspectCompletion: async () => {
				if (inspections++ === 0) {
					inspectionStarted.resolve();
					await releaseInspection.promise;
				}
				return { runId: "run", runDirectory: "/run", handoffPath: "/handoff", handoffSha256: "digest" };
			},
			restore: vi.fn(async () => {}),
			enqueue: vi.fn(async () => {}),
		};
		const firstSweep = createRvfAutomaticCloseoutCoordinator(dependencies).sweep();
		await inspectionStarted.promise;
		try {
			await createRvfAutomaticCloseoutCoordinator(dependencies).sweep();
		} finally {
			releaseInspection.resolve();
			await firstSweep;
		}
		expect(dependencies.restore).toHaveBeenCalledOnce();
		expect(dependencies.enqueue).toHaveBeenCalledOnce();
	});
	it("投递尚未结束时，另一个 coordinator 不能重入同一投递副作用", async () => {
		const path = await setup();
		const enqueueStarted = createDeferredCloseoutOperationSignal();
		const releaseEnqueue = createDeferredCloseoutOperationSignal();
		const dependencies = {
			storePath: path,
			inspectCompletion: async () => ({
				runId: "run",
				runDirectory: "/run",
				handoffPath: "/handoff",
				handoffSha256: "digest",
			}),
			restore: vi.fn(async () => {}),
			enqueue: vi.fn(async () => {
				enqueueStarted.resolve();
				await releaseEnqueue.promise;
			}),
		};
		const firstSweep = createRvfAutomaticCloseoutCoordinator(dependencies).sweep();
		await enqueueStarted.promise;
		try {
			await createRvfAutomaticCloseoutCoordinator(dependencies).sweep();
		} finally {
			releaseEnqueue.resolve();
			await firstSweep;
		}
		expect(dependencies.enqueue).toHaveBeenCalledOnce();
	});
	it("恢复中用户持久暂停时，旧回调不能覆盖暂停原因或投递", async () => {
		const path = await setup();
		const restoreStarted = createDeferredCloseoutOperationSignal();
		const releaseRestore = createDeferredCloseoutOperationSignal();
		const dependencies = {
			storePath: path,
			inspectCompletion: async () => ({
				runId: "run",
				runDirectory: "/run",
				handoffPath: "/handoff",
				handoffSha256: "digest",
			}),
			restore: async () => {
				restoreStarted.resolve();
				await releaseRestore.promise;
				throw new RvfAutomaticCloseoutPauseError("旧持有者的暂停原因");
			},
			enqueue: vi.fn(async () => {}),
		};
		const sweep = createRvfAutomaticCloseoutCoordinator(dependencies).sweep();
		await restoreStarted.promise;
		await updateRvfAutomaticCloseoutRecords(path, (records) => ({
			records: records.map((entry) => ({ ...entry, status: "paused", pauseReason: "用户明确停止会话" })),
			value: null,
		}));
		releaseRestore.resolve();
		await sweep;
		expect((await readRvfAutomaticCloseoutRecords(path))[0]).toMatchObject({
			status: "paused",
			pauseReason: "用户明确停止会话",
		});
		expect(dependencies.enqueue).not.toHaveBeenCalled();
	});
	it("持久 claim 被接管后，旧回调既不写恢复身份也不覆盖新持有者状态", async () => {
		const path = await setup();
		const restoreStarted = createDeferredCloseoutOperationSignal();
		const releaseRestore = createDeferredCloseoutOperationSignal();
		const dependencies = {
			storePath: path,
			inspectCompletion: async () => ({
				runId: "run",
				runDirectory: "/run",
				handoffPath: "/handoff",
				handoffSha256: "digest",
			}),
			restore: async (
				_entry: RvfAutomaticCloseoutRecord,
				save: (patch: Partial<RvfAutomaticCloseoutRecord>) => Promise<void>,
			) => {
				restoreStarted.resolve();
				await releaseRestore.promise;
				await save({ restoredNativeSessionId: "stale-fork" });
			},
			enqueue: vi.fn(async () => {}),
			onPaused: vi.fn(async () => {}),
		};
		const sweep = createRvfAutomaticCloseoutCoordinator(dependencies).sweep();
		await restoreStarted.promise;
		await updateRvfAutomaticCloseoutRecords(path, (records) => ({
			records: records.map((entry) => ({
				...entry,
				activeCoordinatorOperationClaimId: "replacement-owner",
				pauseReason: "新持有者现场",
			})),
			value: null,
		}));
		releaseRestore.resolve();
		await sweep;
		expect((await readRvfAutomaticCloseoutRecords(path))[0]).toMatchObject({
			status: "restoring_pre_review_conversation",
			activeCoordinatorOperationClaimId: "replacement-owner",
			pauseReason: "新持有者现场",
			restoredNativeSessionId: null,
		});
		expect(dependencies.enqueue).not.toHaveBeenCalled();
		expect(dependencies.onPaused).not.toHaveBeenCalled();
	});
	it("操作文件锁 compromise 后，持有者不能继续保存身份或推进投递", async () => {
		const path = await setup();
		let compromiseOperationLock!: () => void;
		const originalWithLocks = lockedFileSystem.withLocks.bind(lockedFileSystem);
		vi.spyOn(lockedFileSystem, "withLocks").mockImplementation(
			async <T>(requests: readonly LockRequest[], operation: () => Promise<T>): Promise<T> => {
				const operationLock = requests.find((request) => request.path.startsWith(`${path}.record-operation-`));
				if (operationLock) compromiseOperationLock = () => operationLock.onCompromised?.(new Error("模拟锁失效"));
				return originalWithLocks(requests, operation);
			},
		);
		const enqueue = vi.fn(async () => {});
		await createRvfAutomaticCloseoutCoordinator({
			storePath: path,
			inspectCompletion: async () => ({
				runId: "run",
				runDirectory: "/run",
				handoffPath: "/handoff",
				handoffSha256: "digest",
			}),
			restore: async (_entry, save) => {
				await save({ nativeForkAttemptStartedAt: 123 });
				compromiseOperationLock();
				await save({ restoredNativeSessionId: "stale-fork" });
			},
			enqueue,
		}).sweep();
		expect((await readRvfAutomaticCloseoutRecords(path))[0]).toMatchObject({
			status: "restoring_pre_review_conversation",
			nativeForkAttemptStartedAt: 123,
			restoredNativeSessionId: null,
		});
		expect(enqueue).not.toHaveBeenCalled();
	});
	it("两个独立 Node 进程共享记录时，文件锁只允许一份恢复和投递副作用", async () => {
		const path = await setup();
		const effectsPath = join(dirname(path), "closeout-side-effects.jsonl");
		const coordinatorUrl = new URL(
			"../../../src/rvf-automatic-closeout/rvf-automatic-closeout-coordinator.ts",
			import.meta.url,
		);
		const childSource = `
import { appendFile } from "node:fs/promises";
import { createRvfAutomaticCloseoutCoordinator } from ${JSON.stringify(coordinatorUrl.href)};
await createRvfAutomaticCloseoutCoordinator({
	storePath: ${JSON.stringify(path)},
	inspectCompletion: async () => {
		if (process.env.HOLD_FIRST_INSPECTION === "1") {
			process.send("inspection_started");
			await new Promise((resolve) => process.once("message", resolve));
		}
		return { runId: "run", runDirectory: "/run", handoffPath: "/handoff", handoffSha256: "digest" };
	},
	restore: async () => appendFile(${JSON.stringify(effectsPath)}, "restore\\n"),
	enqueue: async () => appendFile(${JSON.stringify(effectsPath)}, "enqueue\\n"),
}).sweep();
process.disconnect();
`;
		function startCoordinatorProcess(holdFirstInspection: boolean) {
			const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", childSource], {
				cwd: fileURLToPath(new URL("../../../", import.meta.url)),
				env: {
					PATH: process.env.PATH,
					HOME: dirname(path),
					HOLD_FIRST_INSPECTION: holdFirstInspection ? "1" : "0",
				},
				stdio: ["ignore", "pipe", "pipe", "ipc"],
			});
			childProcesses.push(child);
			let stderr = "";
			child.stderr?.on("data", (chunk) => {
				stderr += String(chunk);
			});
			const exited = new Promise<void>((resolve, reject) => {
				child.once("error", reject);
				child.once("exit", (code, signal) =>
					code === 0 ? resolve() : reject(new Error(`独立 coordinator 退出异常：${code ?? signal}\n${stderr}`)),
				);
			});
			return { child, exited };
		}
		const first = startCoordinatorProcess(true);
		await new Promise<void>((resolve, reject) => {
			first.child.once("message", () => resolve());
			first.exited.then(() => reject(new Error("首个 coordinator 未进入检查便退出")), reject);
		});
		try {
			await startCoordinatorProcess(false).exited;
		} finally {
			first.child.send("release_inspection");
			await first.exited;
		}
		expect((await readFile(effectsPath, "utf8")).trim().split("\n")).toEqual(["restore", "enqueue"]);
		expect((await readRvfAutomaticCloseoutRecords(path))[0]?.status).toBe("closeout_prompt_submitted");
	});
	it("完成后自动恢复并投递；重复扫描与重启不重复投递", async () => {
		const path = await setup();
		const restore = vi.fn(
			async (
				_entry: RvfAutomaticCloseoutRecord,
				save: (patch: Partial<RvfAutomaticCloseoutRecord>) => Promise<void>,
			) => {
				await save({ restoredNativeSessionId: "fork", restoredTranscriptPath: "/fork.jsonl" });
			},
		);
		const enqueue = vi.fn(async () => {});
		const dependencies = {
			storePath: path,
			inspectCompletion: vi.fn(async () => ({
				runId: "run",
				runDirectory: "/run",
				handoffPath: "/run/handoff.md",
				handoffSha256: "digest",
			})),
			restore,
			enqueue,
		};
		await createRvfAutomaticCloseoutCoordinator(dependencies).sweep();
		await createRvfAutomaticCloseoutCoordinator(dependencies).sweep();
		expect(restore).toHaveBeenCalledOnce();
		expect(enqueue).toHaveBeenCalledOnce();
		expect((await readRvfAutomaticCloseoutRecords(path))[0]?.status).toBe("closeout_prompt_submitted");
	});
	it("fork 已持久化后崩溃：重启复验既有身份，不创造第二个 fork", async () => {
		const path = await setup();
		let attempts = 0;
		const restore = vi.fn(
			async (
				entry: RvfAutomaticCloseoutRecord,
				save: (patch: Partial<RvfAutomaticCloseoutRecord>) => Promise<void>,
			) => {
				if (!entry.restoredNativeSessionId)
					await save({ restoredNativeSessionId: "fork", restoredTranscriptPath: "/fork.jsonl" });
				if (attempts++ === 0) throw new Error("模拟崩溃");
			},
		);
		const dependencies = {
			storePath: path,
			inspectCompletion: async () => ({
				runId: "run",
				runDirectory: "/run",
				handoffPath: "/handoff",
				handoffSha256: "digest",
			}),
			restore,
			enqueue: vi.fn(async () => {}),
		};
		await expect(createRvfAutomaticCloseoutCoordinator(dependencies).sweep()).rejects.toThrow("模拟崩溃");
		await createRvfAutomaticCloseoutCoordinator(dependencies).sweep();
		expect(restore.mock.calls[1]?.[0].restoredNativeSessionId).toBe("fork");
		expect(dependencies.enqueue).toHaveBeenCalledOnce();
	});
	it("没有完成事实时不恢复；明确门禁暂停并保留原因", async () => {
		const path = await setup();
		const restore = vi.fn();
		const dependencies = { storePath: path, inspectCompletion: vi.fn(async () => null), restore, enqueue: vi.fn() };
		await createRvfAutomaticCloseoutCoordinator(dependencies).sweep();
		expect(restore).not.toHaveBeenCalled();
		dependencies.inspectCompletion.mockRejectedValueOnce(new Error("错误 workspace"));
		await createRvfAutomaticCloseoutCoordinator(dependencies).sweep();
		expect((await readRvfAutomaticCloseoutRecords(path))[0]).toMatchObject({
			status: "paused",
			pauseReason: "错误 workspace",
		});
	});
});
