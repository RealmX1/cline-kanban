import { type ChildProcess, spawn } from "node:child_process";
import { appendFile, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDir } from "../utilities/temp-dir";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	sigkillChildProcessAndWaitForExit,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const nativeFaults = vi.hoisted(() => ({
	refuseRead: false,
	addSourceHistoryOnArchive: false,
	beforeRead: null as (() => Promise<void>) | null,
}));

vi.mock("node:child_process", { spy: true });

vi.mock("../../src/rvf-automatic-closeout/codex-app-server-request-connection", () => ({
	withCodexAppServerRequestConnection: async (
		input: { codexConversationStorageHomeDirectoryPath: string },
		operation: (port: {
			request: (method: string, parameters: Record<string, unknown>) => Promise<unknown>;
		}) => Promise<unknown>,
	) =>
		operation({
			request: async (method, parameters) => {
				const home = input.codexConversationStorageHomeDirectoryPath;
				const id = parameters.threadId;
				if (method === "thread/read") {
					await nativeFaults.beforeRead?.();
					if (nativeFaults.refuseRead) throw new Error("隔离故障注入：原生核验失败");
					const state = new Database(join(home, "state_5.sqlite"));
					try {
						const row = state.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(id) as {
							rollout_path: string;
						};
						return { thread: { id, path: row.rollout_path } };
					} finally {
						state.close();
					}
				}
				if (method === "thread/turns/list") {
					const history = new Database(join(home, "thread_history_1.sqlite"));
					try {
						const turns = history
							.prepare("SELECT turn_id FROM thread_turns WHERE thread_id = ? ORDER BY turn_id")
							.all(id) as { turn_id: string }[];
						return {
							data: turns.map((turn, index) => ({
								id: turn.turn_id,
								status: "completed",
								items:
									index === 0
										? (
												history.prepare("SELECT item_id FROM thread_items WHERE thread_id = ?").all(id) as {
													item_id: string;
												}[]
											).map((item) => ({ id: item.item_id, type: "agentMessage" }))
										: [],
							})),
							nextCursor: null,
						};
					} finally {
						history.close();
					}
				}
				if (method === "thread/archive" || method === "thread/unarchive") {
					if (method === "thread/archive" && nativeFaults.addSourceHistoryOnArchive) {
						nativeFaults.addSourceHistoryOnArchive = false;
						const history = new Database(join(home, "thread_history_1.sqlite"));
						history
							.prepare("INSERT INTO thread_items VALUES (?, 'archive-handoff-item', 'source-during-handoff')")
							.run(id);
						history.close();
					}
					const state = new Database(join(home, "state_5.sqlite"));
					try {
						const ids = [id];
						if (method === "thread/archive")
							for (let index = 0; index < ids.length; index++)
								ids.push(
									...(
										state
											.prepare("SELECT child_thread_id FROM thread_spawn_edges WHERE parent_thread_id = ?")
											.all(ids[index]) as { child_thread_id: string }[]
									).map((row) => row.child_thread_id),
								);
						for (const member of ids) {
							const row = state
								.prepare("SELECT rollout_path, archived FROM threads WHERE id = ?")
								.get(member) as { rollout_path: string; archived: number };
							const archived = method === "thread/archive";
							if (row.archived === Number(archived)) continue;
							const destination = join(home, archived ? "archived_sessions" : "sessions", `${member}.jsonl`);
							await mkdir(join(home, archived ? "archived_sessions" : "sessions"), { recursive: true });
							if (destination !== row.rollout_path) await rename(row.rollout_path, destination);
							state
								.prepare("UPDATE threads SET archived = ?, rollout_path = ? WHERE id = ?")
								.run(Number(archived), destination, member);
						}
						return {};
					} finally {
						state.close();
					}
				}
				throw new Error(`测试未提供原生方法：${method}`);
			},
		}),
}));

import {
	getManagedCodexConversationStorageHomeDirectoryPath,
	prepareManagedCodexConversationStorageHome,
	resolveMigratedCodexConversationHome,
} from "../../src/codex-conversation-storage/codex-conversation-storage-home";
import {
	migrateStoppedCodexConversationStorage,
	readCodexConversationStorageMigrationRecord,
	rollbackStoppedCodexConversationStorage,
} from "../../src/codex-conversation-storage/codex-conversation-storage-migration";
import {
	withStoppedCodexNativeConversationFamilyWriterLocks,
	withStoppedCodexNativeThreadWriterLock,
} from "../../src/codex-conversation-storage/codex-native-thread-writer-lock";

let fixture: ReturnType<typeof createTempDir>;
let sourceHome: string;
let binary: string;
const fixtureChildProcesses = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
const nativeSessionId = "01a15120-4476-78b0-8c56-5a7321338e0b";
const unrelatedSessionId = "01a15120-4476-78b0-8c56-5a7321338e0c";
beforeEach(async () => {
	vi.clearAllMocks();
	nativeFaults.refuseRead = false;
	nativeFaults.addSourceHistoryOnArchive = false;
	nativeFaults.beforeRead = null;
	fixture = createTempDir("kanban-codex-storage-migration-");
	vi.stubEnv("HOME", fixture.path);
	sourceHome = join(fixture.path, ".codex");
	await mkdir(join(sourceHome, "sessions"), { recursive: true });
	binary = join(fixture.path, "synthetic-codex-version");
	await writeFile(binary, '#!/usr/bin/env node\nprocess.stdout.write("codex-cli 0.164.0\\n");\n', { mode: 0o700 });
	const state = new Database(join(sourceHome, "state_5.sqlite"));
	state.exec(
		"CREATE TABLE _sqlx_migrations (version INTEGER PRIMARY KEY, checksum BLOB); INSERT INTO _sqlx_migrations VALUES (1, X'01'); CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, archived INTEGER, archived_at INTEGER, project_id TEXT, thread_section_id TEXT, history_mode TEXT); CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT PRIMARY KEY, status TEXT);",
	);
	for (const id of [nativeSessionId, unrelatedSessionId]) {
		const path = join(sourceHome, "sessions", `${id}.jsonl`);
		await writeFile(path, `${JSON.stringify({ type: "session_meta", payload: { id } })}\n`);
		state.prepare("INSERT INTO threads VALUES (?, ?, 0, NULL, NULL, NULL, 'paginated')").run(id, path);
	}
	state.close();
	const history = new Database(join(sourceHome, "thread_history_1.sqlite"));
	history.exec(
		"CREATE TABLE _sqlx_migrations (version INTEGER PRIMARY KEY, checksum BLOB); INSERT INTO _sqlx_migrations VALUES (1, X'01'); CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, PRIMARY KEY (thread_id, turn_id)); CREATE TABLE thread_items (thread_id TEXT, item_id TEXT, item_json TEXT, PRIMARY KEY (thread_id, item_id));",
	);
	history.prepare("INSERT INTO thread_turns VALUES (?, 'turn-1')").run(nativeSessionId);
	history.prepare("INSERT INTO thread_items VALUES (?, 'item-1', 'original-history')").run(nativeSessionId);
	history.prepare("INSERT INTO thread_turns VALUES (?, 'private-unrelated-turn')").run(unrelatedSessionId);
	history.close();
});
afterEach(async () => {
	for (const child of getFixtureNativeWriterLockHelpers()) fixtureChildProcesses.register(child);
	await fixtureChildProcesses.sigkillEveryStillRunningChildProcessAndWaitForExit();
	vi.unstubAllEnvs();
	fixture.cleanup();
});

function getFixtureNativeWriterLockHelpers(): ChildProcess[] {
	return vi.mocked(spawn).mock.results.flatMap((result, index) => {
		const call = vi.mocked(spawn).mock.calls[index];
		return result.type === "return" &&
			call?.[0] === "python3" &&
			Array.isArray(call[1]) &&
			call[1].some((argument) => argument.includes("CODEX_NATIVE_WRITER_LOCK_ACQUIRED"))
			? [result.value]
			: [];
	});
}

async function killFixtureNativeWriterLockHelper(helperIndex = -1) {
	const child = getFixtureNativeWriterLockHelpers()
		.filter((helper) => helper.exitCode === null && helper.signalCode === null)
		.at(helperIndex);
	if (!child) throw new Error("未找到本 fixture 启动的写锁辅助进程。");
	expect(await sigkillChildProcessAndWaitForExit(child)).toBe(true);
}

function request() {
	return {
		sourceHomeDirectoryPath: sourceHome,
		nativeSessionId,
		workingDirectoryPath: fixture.path,
		binary,
		assertSessionStillStopped: vi.fn(),
	};
}

describe.skipIf(process.platform === "win32")("Codex 历史隔离迁移", () => {
	it("复制意图已持久化但目标库尚未创建时，修复来源后仍能重试", async () => {
		const sourceState = new Database(join(sourceHome, "state_5.sqlite"), { readonly: true });
		const path = (
			sourceState.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(nativeSessionId) as {
				rollout_path: string;
			}
		).rollout_path;
		sourceState.close();
		const originalTranscript = await readFile(path);
		await writeFile(path, "无法解析的隔离故障记录\n");
		await expect(migrateStoppedCodexConversationStorage(request())).rejects.toThrow("无法解析");
		expect((await readCodexConversationStorageMigrationRecord(sourceHome, nativeSessionId))?.stage).toBe(
			"copy_started",
		);
		await writeFile(path, originalTranscript);
		expect((await migrateStoppedCodexConversationStorage(request())).stage).toBe("source_archived");
	});

	it("辅助进程取得写锁后死亡时，不能报告回调成功", async () => {
		await expect(
			withStoppedCodexNativeThreadWriterLock(sourceHome, nativeSessionId, async () => {
				await killFixtureNativeWriterLockHelper();
				return "operation-completed";
			}),
		).rejects.toThrow("写锁辅助进程");
	});
	it("辅助进程死亡的退出事件晚于回调返回时，也不能报告成功", async () => {
		await expect(
			withStoppedCodexNativeThreadWriterLock(sourceHome, nativeSessionId, async () => {
				const child = getFixtureNativeWriterLockHelpers().at(-1);
				if (!child) throw new Error("未找到本 fixture 启动的写锁辅助进程。");
				expect(child.kill("SIGKILL")).toBe(true);
				return "operation-completed-before-exit-event";
			}),
		).rejects.toThrow("写锁辅助进程");
	});
	it("辅助进程死亡后仍保留真实 flock，直到在途回调完全收口", async () => {
		let finishOperation = () => {};
		let confirmOperationStarted = () => {};
		const operationMayFinish = new Promise<void>((resolveOperation) => {
			finishOperation = resolveOperation;
		});
		const operationStarted = new Promise<void>((resolveStarted) => {
			confirmOperationStarted = resolveStarted;
		});
		let operationSettled = false;
		const operation = withStoppedCodexNativeThreadWriterLock(sourceHome, nativeSessionId, async () => {
			confirmOperationStarted();
			await operationMayFinish;
		}).then(
			() => {
				operationSettled = true;
				return null;
			},
			(error: unknown) => {
				operationSettled = true;
				return error;
			},
		);
		await operationStarted;
		try {
			await killFixtureNativeWriterLockHelper();
			await expect(
				withStoppedCodexNativeThreadWriterLock(sourceHome, nativeSessionId, async () => {}),
			).rejects.toThrow("已延后迁移");
			expect(operationSettled).toBe(false);
		} finally {
			finishOperation();
			await operation;
		}
		expect(await operation).toEqual(expect.objectContaining({ message: expect.stringContaining("写锁辅助进程") }));
		await expect(
			withStoppedCodexNativeThreadWriterLock(sourceHome, nativeSessionId, async () => "released"),
		).resolves.toBe("released");
	});
	it("整族只取得部分 flock 后失败时，释放父进程保留的全部 fd", async () => {
		await withStoppedCodexNativeThreadWriterLock(sourceHome, unrelatedSessionId, async () => {
			await expect(
				withStoppedCodexNativeConversationFamilyWriterLocks(
					sourceHome,
					[nativeSessionId, unrelatedSessionId],
					async () => {},
				),
			).rejects.toThrow("已延后迁移");
			await expect(
				withStoppedCodexNativeThreadWriterLock(sourceHome, nativeSessionId, async () => "released"),
			).resolves.toBe("released");
		});
	});
	it.each(["迁移", "回退"] as const)(
		"%s 的写锁辅助进程在复制前死亡时，不继续复制或切换绑定",
		async (operationName) => {
			if (operationName === "回退") {
				await migrateStoppedCodexConversationStorage(request());
				const targetHistory = new Database(
					join(getManagedCodexConversationStorageHomeDirectoryPath(), "thread_history_1.sqlite"),
				);
				targetHistory
					.prepare("INSERT INTO thread_items VALUES (?, 'lock-loss-private-item', 'must-stay-private')")
					.run(nativeSessionId);
				targetHistory.close();
			}
			const operation =
				operationName === "迁移" ? migrateStoppedCodexConversationStorage : rollbackStoppedCodexConversationStorage;
			let stoppedAssertionCount = 0;
			await expect(
				operation({
					...request(),
					assertSessionStillStopped: async () => {
						if (++stoppedAssertionCount === 2) await killFixtureNativeWriterLockHelper();
					},
				}),
			).rejects.toThrow("写锁辅助进程");
			const record = await readCodexConversationStorageMigrationRecord(sourceHome, nativeSessionId);
			expect(record?.stage ?? null).toBe(operationName === "迁移" ? null : "source_archived");
			if (operationName === "迁移") {
				await expect(
					readFile(join(getManagedCodexConversationStorageHomeDirectoryPath(), "state_5.sqlite")),
				).rejects.toMatchObject({ code: "ENOENT" });
			} else {
				const originalHistory = new Database(join(sourceHome, "thread_history_1.sqlite"));
				expect(
					originalHistory.prepare("SELECT 1 FROM thread_items WHERE item_id = 'lock-loss-private-item'").get(),
				).toBeUndefined();
				originalHistory.close();
			}
			expect(await resolveMigratedCodexConversationHome(sourceHome, nativeSessionId)).toBe(
				operationName === "迁移" ? sourceHome : getManagedCodexConversationStorageHomeDirectoryPath(),
			);
		},
	);
	it.each(["迁移", "回退"] as const)("%s 最终绑定前外层辅助进程死亡时，保留原绑定", async (operationName) => {
		if (operationName === "回退") await migrateStoppedCodexConversationStorage(request());
		const operation =
			operationName === "迁移" ? migrateStoppedCodexConversationStorage : rollbackStoppedCodexConversationStorage;
		let stoppedAssertionCount = 0;
		await expect(
			operation({
				...request(),
				assertSessionStillStopped: async () => {
					if (++stoppedAssertionCount === (operationName === "迁移" ? 5 : 3))
						await killFixtureNativeWriterLockHelper(0);
				},
			}),
		).rejects.toThrow("写锁辅助进程");
		expect((await readCodexConversationStorageMigrationRecord(sourceHome, nativeSessionId))?.stage).toBe(
			operationName === "迁移" ? "copied" : "source_archived",
		);
		expect(await resolveMigratedCodexConversationHome(sourceHome, nativeSessionId)).toBe(
			operationName === "迁移" ? sourceHome : getManagedCodexConversationStorageHomeDirectoryPath(),
		);
	});
	it.each(["迁移", "回退"] as const)("%s 在原生核验期间失去辅助进程时，不提交目录绑定", async (operationName) => {
		if (operationName === "回退") await migrateStoppedCodexConversationStorage(request());
		nativeFaults.beforeRead = async () => {
			nativeFaults.beforeRead = null;
			await killFixtureNativeWriterLockHelper();
		};
		const operation =
			operationName === "迁移" ? migrateStoppedCodexConversationStorage : rollbackStoppedCodexConversationStorage;
		await expect(operation(request())).rejects.toThrow("写锁辅助进程");
		expect((await readCodexConversationStorageMigrationRecord(sourceHome, nativeSessionId))?.stage).toBe(
			operationName === "迁移" ? "copied" : "source_archived",
		);
		expect(await resolveMigratedCodexConversationHome(sourceHome, nativeSessionId)).toBe(
			operationName === "迁移" ? sourceHome : getManagedCodexConversationStorageHomeDirectoryPath(),
		);
	});
	it("专用库新增原生子会话后拒绝不完整回退，保留全部私有历史", async () => {
		await migrateStoppedCodexConversationStorage(request());
		const targetHome = getManagedCodexConversationStorageHomeDirectoryPath();
		const target = new Database(join(targetHome, "state_5.sqlite"));
		target
			.prepare("INSERT INTO thread_spawn_edges VALUES (?, ?, 'completed')")
			.run(nativeSessionId, "01a15120-4476-78b0-8c56-5a7321338e0e");
		target.close();
		await expect(rollbackStoppedCodexConversationStorage(request())).rejects.toThrow("无法完整覆盖");
		expect(await resolveMigratedCodexConversationHome(sourceHome, nativeSessionId)).toBe(targetHome);
	});
	it("原生目录无法证明属于当前 Task 时，不迁移可能共享的来源对话", async () => {
		await expect(migrateStoppedCodexConversationStorage({ ...request(), taskCardCreatedAtMs: 1 })).rejects.toThrow(
			"工作目录与 Task 执行目录不一致或未知",
		);
		expect(await readCodexConversationStorageMigrationRecord(sourceHome, nativeSessionId)).toBeNull();
	});
	it("归档锁交接期间来源若有新增数据，不提交绑定，恢复原记录可见性后可重试", async () => {
		nativeFaults.addSourceHistoryOnArchive = true;
		await expect(migrateStoppedCodexConversationStorage(request())).rejects.toThrow("数据库历史有变化");
		expect(await resolveMigratedCodexConversationHome(sourceHome, nativeSessionId)).toBe(sourceHome);
		const source = new Database(join(sourceHome, "state_5.sqlite"));
		expect(source.prepare("SELECT archived FROM threads WHERE id = ?").get(nativeSessionId)).toEqual({ archived: 0 });
		source.close();
		await migrateStoppedCodexConversationStorage(request());
	});
	it("回退前发现原库独有新历史时，拒绝覆盖且保留私有绑定", async () => {
		await migrateStoppedCodexConversationStorage(request());
		const source = new Database(join(sourceHome, "thread_history_1.sqlite"));
		source
			.prepare("INSERT INTO thread_items VALUES (?, 'source-only-item', 'preserve-original-divergence')")
			.run(nativeSessionId);
		source.close();
		await expect(rollbackStoppedCodexConversationStorage(request())).rejects.toThrow("拒绝覆盖重试");
		expect(await resolveMigratedCodexConversationHome(sourceHome, nativeSessionId)).toBe(
			getManagedCodexConversationStorageHomeDirectoryPath(),
		);
	});
	it("核验失败后仍续接原目录，来源新增历史后可安全重试", async () => {
		nativeFaults.refuseRead = true;
		await expect(migrateStoppedCodexConversationStorage(request())).rejects.toThrow("原生核验失败");
		expect(await resolveMigratedCodexConversationHome(sourceHome, nativeSessionId)).toBe(sourceHome);
		await appendFile(join(sourceHome, "sessions", `${nativeSessionId}.jsonl`), '{"type":"new-source-event"}\n');
		const history = new Database(join(sourceHome, "thread_history_1.sqlite"));
		history.prepare("INSERT INTO thread_turns VALUES (?, 'turn-2')").run(nativeSessionId);
		history.prepare("INSERT INTO thread_items VALUES (?, 'item-2', 'new-source-history')").run(nativeSessionId);
		history.close();
		nativeFaults.refuseRead = false;
		await migrateStoppedCodexConversationStorage(request());
		const target = new Database(
			join(getManagedCodexConversationStorageHomeDirectoryPath(), "thread_history_1.sqlite"),
		);
		expect(target.prepare("SELECT item_json FROM thread_items ORDER BY item_id").all()).toEqual([
			{ item_json: "original-history" },
			{ item_json: "new-source-history" },
		]);
		target.close();
	});
	it("未提交绑定的副本若有独有新增历史，重试拒绝覆盖", async () => {
		nativeFaults.refuseRead = true;
		await expect(migrateStoppedCodexConversationStorage(request())).rejects.toThrow("原生核验失败");
		const target = new Database(
			join(getManagedCodexConversationStorageHomeDirectoryPath(), "thread_history_1.sqlite"),
		);
		target.prepare("INSERT INTO thread_items VALUES (?, 'independent-item', 'must-preserve')").run(nativeSessionId);
		target.close();
		nativeFaults.refuseRead = false;
		await expect(migrateStoppedCodexConversationStorage(request())).rejects.toThrow("拒绝覆盖重试");
		expect(await resolveMigratedCodexConversationHome(sourceHome, nativeSessionId)).toBe(sourceHome);
	});
	it("目标数据库软链到原库时，拒绝迁移且不归档源记录", async () => {
		const target = await prepareManagedCodexConversationStorageHome(sourceHome);
		await symlink(join(sourceHome, "state_5.sqlite"), join(target, "state_5.sqlite"));
		await expect(migrateStoppedCodexConversationStorage(request())).rejects.toThrow("包含软链");
		const source = new Database(join(sourceHome, "state_5.sqlite"));
		expect(source.prepare("SELECT archived FROM threads WHERE id = ?").get(nativeSessionId)).toEqual({ archived: 0 });
		source.close();
	});
	it("使用外置 SQLite 的历史保守拒绝，既有配置保持原样", async () => {
		await writeFile(join(sourceHome, "config.toml"), 'sqlite_home="/different-sqlite-home"');
		await expect(migrateStoppedCodexConversationStorage(request())).rejects.toThrow("独立 sqlite_home");
		expect(await readCodexConversationStorageMigrationRecord(sourceHome, nativeSessionId)).toBeNull();
	});
	it("仅转移已确认会话，保留完整分页历史与原生 ID，验证后归档源记录", async () => {
		const record = await migrateStoppedCodexConversationStorage(request());
		expect(record.stage).toBe("source_archived");
		const targetHome = getManagedCodexConversationStorageHomeDirectoryPath();
		const state = new Database(join(targetHome, "state_5.sqlite"));
		expect(state.prepare("SELECT id FROM threads").all()).toEqual([{ id: nativeSessionId }]);
		state.close();
		const history = new Database(join(targetHome, "thread_history_1.sqlite"));
		expect(history.prepare("SELECT item_json FROM thread_items").all()).toEqual([{ item_json: "original-history" }]);
		history.close();
		expect(await resolveMigratedCodexConversationHome(sourceHome, nativeSessionId)).toBe(targetHome);
		const sourceState = new Database(join(sourceHome, "state_5.sqlite"));
		expect(sourceState.prepare("SELECT archived FROM threads WHERE id = ?").get(nativeSessionId)).toEqual({
			archived: 1,
		});
		expect(sourceState.prepare("SELECT archived FROM threads WHERE id = ?").get(unrelatedSessionId)).toEqual({
			archived: 0,
		});
		sourceState.close();
	});
	it("原生写锁仍被占用时拒绝迁移，不归档、不生成目录绑定", async () => {
		await withStoppedCodexNativeThreadWriterLock(sourceHome, nativeSessionId, async () => {
			await expect(migrateStoppedCodexConversationStorage(request())).rejects.toThrow("已延后迁移");
		});
		expect(await readCodexConversationStorageMigrationRecord(sourceHome, nativeSessionId)).toBeNull();
	});
	it("回退包含私有库中新增加的历史，不把用户接回旧副本", async () => {
		await migrateStoppedCodexConversationStorage(request());
		const targetHome = getManagedCodexConversationStorageHomeDirectoryPath();
		const history = new Database(join(targetHome, "thread_history_1.sqlite"));
		history.prepare("INSERT INTO thread_items VALUES (?, 'item-2', 'history-after-migration')").run(nativeSessionId);
		history.close();
		await rollbackStoppedCodexConversationStorage(request());
		const restored = new Database(join(sourceHome, "thread_history_1.sqlite"));
		expect(restored.prepare("SELECT item_json FROM thread_items ORDER BY item_id").all()).toEqual([
			{ item_json: "original-history" },
			{ item_json: "history-after-migration" },
		]);
		restored.close();
		expect(await resolveMigratedCodexConversationHome(sourceHome, nativeSessionId)).toBe(sourceHome);
	});
	it("原生子会话仍持有写锁时整族延后，停止后整族迁移并保留父子关系", async () => {
		const childId = "01a15120-4476-78b0-8c56-5a7321338e0d";
		const state = new Database(join(sourceHome, "state_5.sqlite"));
		const path = join(sourceHome, "sessions", `${childId}.jsonl`);
		await writeFile(path, `${JSON.stringify({ type: "session_meta", payload: { id: childId } })}\n`);
		state.prepare("INSERT INTO threads VALUES (?, ?, 0, NULL, NULL, NULL, 'paginated')").run(childId, path);
		state.prepare("INSERT INTO thread_spawn_edges VALUES (?, ?, 'completed')").run(nativeSessionId, childId);
		state.close();
		const history = new Database(join(sourceHome, "thread_history_1.sqlite"));
		history.prepare("INSERT INTO thread_turns VALUES (?, 'child-turn')").run(childId);
		history.prepare("INSERT INTO thread_items VALUES (?, 'child-item', 'child-history')").run(childId);
		history.close();
		await withStoppedCodexNativeThreadWriterLock(sourceHome, childId, async () => {
			await expect(migrateStoppedCodexConversationStorage(request())).rejects.toThrow("已延后迁移");
		});
		expect(await readCodexConversationStorageMigrationRecord(sourceHome, nativeSessionId)).toBeNull();
		await migrateStoppedCodexConversationStorage(request());
		const target = new Database(join(getManagedCodexConversationStorageHomeDirectoryPath(), "state_5.sqlite"));
		expect(target.prepare("SELECT id FROM threads ORDER BY id").all()).toEqual([
			{ id: nativeSessionId },
			{ id: childId },
		]);
		expect(target.prepare("SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges").all()).toEqual([
			{ parent_thread_id: nativeSessionId, child_thread_id: childId },
		]);
		target.close();
		expect(await resolveMigratedCodexConversationHome(sourceHome, childId)).toBe(
			getManagedCodexConversationStorageHomeDirectoryPath(),
		);
		await rollbackStoppedCodexConversationStorage({ ...request(), nativeSessionId: childId });
		expect(
			await resolveMigratedCodexConversationHome(getManagedCodexConversationStorageHomeDirectoryPath(), childId),
		).toBe(sourceHome);
	});
});
