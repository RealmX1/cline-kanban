import { randomUUID } from "node:crypto";
import type * as FilesystemPromises from "node:fs/promises";
import { appendFile, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ConfigurationFieldProjection from "../../../src/codex-configuration-sync/codex-configuration-field-projection";
import {
	createCodexConfigurationProfile,
	updateCodexConfigurationProfileFields,
} from "../../../src/codex-configuration-sync/codex-configuration-profiles";
import { createCodexConfigurationSyncService } from "../../../src/codex-configuration-sync/codex-configuration-sync-service";
import {
	getCodexConfigurationSyncDirectory,
	mutateCodexConfigurationSyncStore,
	readCodexConfigurationSyncStore,
} from "../../../src/codex-configuration-sync/codex-configuration-sync-store";
import { prepareCodexConfigurationWriterBinding } from "../../../src/codex-configuration-sync/codex-configuration-writer-binding";
import type * as NativeTurnPermissionEvidence from "../../../src/codex-configuration-sync/codex-native-turn-permission-evidence";
import { runtimeTaskSessionSummarySchema } from "../../../src/core/api-contract";
import { lockedFileSystem } from "../../../src/fs/locked-file-system";
import { createTempDir } from "../../utilities/temp-dir";

async function assertCodexConfigurationStoreKernelWriteLockAvailable(): Promise<void> {
	const directory = getCodexConfigurationSyncDirectory();
	const release = await lockedFileSystem.acquireLock({
		path: directory,
		type: "directory",
		lockfilePath: `${directory}.lock`,
		retries: 0,
	});
	await release();
}

const suspendedObservation = vi.hoisted(() => ({
	home: "",
	hookDefinitionPath: "",
	nativePermissionRead: false,
	nativePermissionTranscriptFingerprintCheck: false,
	onRead: () => {},
	waitForRelease: Promise.resolve(),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof FilesystemPromises>();
	return {
		...original,
		readFile: async (...arguments_: Parameters<typeof original.readFile>) => {
			const content = await original.readFile(...arguments_);
			if (String(arguments_[0]) === suspendedObservation.hookDefinitionPath) {
				suspendedObservation.hookDefinitionPath = "";
				suspendedObservation.onRead();
				await suspendedObservation.waitForRelease;
			}
			return content;
		},
	};
});
vi.mock("../../../src/codex-configuration-sync/codex-native-turn-permission-evidence", async (importOriginal) => {
	const original = await importOriginal<typeof NativeTurnPermissionEvidence>();
	return {
		...original,
		codexNativeTurnPermissionTranscriptFingerprintStillCurrent: async (
			...arguments_: Parameters<typeof original.codexNativeTurnPermissionTranscriptFingerprintStillCurrent>
		) => {
			const stillCurrent = await original.codexNativeTurnPermissionTranscriptFingerprintStillCurrent(...arguments_);
			if (suspendedObservation.nativePermissionTranscriptFingerprintCheck) {
				suspendedObservation.nativePermissionTranscriptFingerprintCheck = false;
				suspendedObservation.onRead();
				await suspendedObservation.waitForRelease;
			}
			return stillCurrent;
		},
		readCodexNativeTurnPermissionEvidence: async (
			input: Parameters<typeof original.readCodexNativeTurnPermissionEvidence>[0],
		) => {
			const evidence = await original.readCodexNativeTurnPermissionEvidence(input);
			if (suspendedObservation.nativePermissionRead) {
				suspendedObservation.nativePermissionRead = false;
				suspendedObservation.onRead();
				await suspendedObservation.waitForRelease;
			}
			return evidence;
		},
	};
});
vi.mock("../../../src/codex-configuration-sync/codex-configuration-field-projection", async (importOriginal) => {
	const original = await importOriginal<typeof ConfigurationFieldProjection>();
	return {
		...original,
		projectCodexConfigurationFields: async (
			input: Parameters<typeof original.projectCodexConfigurationFields>[0],
		) => {
			const fields = await original.projectCodexConfigurationFields(input);
			if (input.home === suspendedObservation.home) {
				suspendedObservation.home = "";
				suspendedObservation.onRead();
				await suspendedObservation.waitForRelease;
			}
			return fields;
		},
	};
});

let fixture: ReturnType<typeof createTempDir>;
let sourceHome: string;
beforeEach(async () => {
	fixture = createTempDir("codex-configuration-scan-lock-contention-");
	fixture.path = await realpath(fixture.path);
	sourceHome = join(fixture.path, "isolated-source-home");
	vi.stubEnv("HOME", fixture.path);
	vi.stubEnv("CODEX_HOME", sourceHome);
	vi.stubEnv("CODEX_SQLITE_HOME", sourceHome);
	await mkdir(sourceHome);
	await writeFile(join(sourceHome, "config.toml"), 'model="initial-model"\n');
});
afterEach(() => {
	suspendedObservation.home = "";
	suspendedObservation.hookDefinitionPath = "";
	suspendedObservation.nativePermissionRead = false;
	suspendedObservation.nativePermissionTranscriptFingerprintCheck = false;
	vi.unstubAllEnvs();
	fixture.cleanup();
});

function prepareWriter(conversationSessionId: string, storageHome = sourceHome) {
	return prepareCodexConfigurationWriterBinding({
		purpose: "native_session",
		storageHome,
		workspaceId: "scan-contention-workspace",
		conversationSessionId,
		runtimeSessionIncarnationId: randomUUID(),
	});
}

function suspendNextConfigurationObservation(home: string) {
	let releaseObservation = () => {};
	suspendedObservation.home = home;
	suspendedObservation.waitForRelease = new Promise<void>((resolve) => {
		releaseObservation = resolve;
	});
	const observationRead = new Promise<void>((resolve) => {
		suspendedObservation.onRead = resolve;
	});
	return { observationRead, releaseObservation };
}

describe("配置扫描锁外读取与并发决定保护", () => {
	it("扫描读取期间的 Task profile 换绑不被旧绑定请求覆盖", async () => {
		const binding = await prepareWriter("rebound-session");
		let selectedProfileId = binding.codexConfigurationProfileId ?? "";
		const replacementProfileId = await mutateCodexConfigurationSyncStore(
			(store) =>
				createCodexConfigurationProfile(store, { name: "并发换绑目标", copyFromProfileId: selectedProfileId })
					.profileId,
		);
		const summary = runtimeTaskSessionSummarySchema.parse({
			taskId: "rebound-session",
			agentId: "codex",
			workspacePath: fixture.path,
			turnOwner: "user",
			liveness: "live",
			userTurnKind: "review",
			pid: 1234,
			startedAt: 1,
			updatedAt: 1,
			lastOutputAt: null,
			reviewReason: null,
			exitCode: null,
			runtimeSessionIncarnationId: binding.runtimeSessionIncarnationId,
			codexConfigurationWriterBinding: binding,
		});
		const service = createCodexConfigurationSyncService({
			listSessions: () => [{ workspaceId: "scan-contention-workspace", summary }],
			onUpdated: () => {},
			listTaskProfileBindings: async () => ({
				unavailableWorkspaceCount: 0,
				bindings: [
					{
						workspaceId: "scan-contention-workspace",
						conversationSessionId: "rebound-session",
						profileId: selectedProfileId,
					},
				],
			}),
		});
		const barrier = suspendNextConfigurationObservation(binding.configurationHomeDirectoryPath);
		const scanning = service.scan();
		try {
			await barrier.observationRead;
			await assertCodexConfigurationStoreKernelWriteLockAvailable();
			selectedProfileId = replacementProfileId;
			await mutateCodexConfigurationSyncStore((store) => {
				store.writers[binding.writerId].codexConfigurationProfileId = replacementProfileId;
				store.revision++;
			});
		} finally {
			barrier.releaseObservation();
			await scanning;
			await service.close();
		}
		expect((await readCodexConfigurationSyncStore()).writers[binding.writerId].codexConfigurationProfileId).toBe(
			replacementProfileId,
		);
	});

	it("取锁等待期间改选的 Task profile 不会被锁外快照写回", async () => {
		const binding = await prepareWriter("lock-wait-profile-session");
		const staleProfileId = binding.codexConfigurationProfileId ?? "";
		const currentProfileId = await mutateCodexConfigurationSyncStore(
			(store) =>
				createCodexConfigurationProfile(store, { name: "锁等待期间的当前选择", copyFromProfileId: staleProfileId })
					.profileId,
		);
		const summary = runtimeTaskSessionSummarySchema.parse({
			taskId: "lock-wait-profile-session",
			agentId: "codex",
			workspacePath: fixture.path,
			turnOwner: "user",
			liveness: "live",
			userTurnKind: "review",
			pid: 1234,
			startedAt: 1,
			updatedAt: 1,
			lastOutputAt: null,
			reviewReason: null,
			exitCode: null,
			runtimeSessionIncarnationId: binding.runtimeSessionIncarnationId,
			codexConfigurationWriterBinding: binding,
		});
		let selectedProfileId = staleProfileId;
		let releaseSnapshot = () => {};
		const snapshotMayReturn = new Promise<void>((resolve) => {
			releaseSnapshot = resolve;
		});
		let markSnapshotRead = () => {};
		const snapshotWasRead = new Promise<void>((resolve) => {
			markSnapshotRead = resolve;
		});
		let signaled = false;
		const boundProfiles: string[] = [];
		const service = createCodexConfigurationSyncService({
			listSessions: () => [{ workspaceId: "scan-contention-workspace", summary }],
			onUpdated: () => {},
			listTaskProfileBindings: async () => {
				const profileId = selectedProfileId;
				if (!signaled) {
					signaled = true;
					markSnapshotRead();
					await snapshotMayReturn;
				}
				return {
					unavailableWorkspaceCount: 0,
					bindings: [
						{
							workspaceId: "scan-contention-workspace",
							conversationSessionId: "lock-wait-profile-session",
							profileId,
						},
					],
				};
			},
			onSessionProfileBound: (_workspaceId, _sessionId, profileId) => {
				boundProfiles.push(profileId);
			},
		});
		const scanning = service.scan();
		let releaseLock = () => {};
		let heldMutation: Promise<unknown> = Promise.resolve();
		try {
			// 启动时的权限来源回写会先取锁；等锁外快照开始后才占用存储锁，避免和这次回写互相等待。
			await snapshotWasRead;
			let markLockHeld = () => {};
			const lockWasHeld = new Promise<void>((resolve) => {
				markLockHeld = resolve;
			});
			const lockMayRelease = new Promise<void>((resolve) => {
				releaseLock = resolve;
			});
			heldMutation = mutateCodexConfigurationSyncStore(async () => {
				markLockHeld();
				await lockMayRelease;
			});
			await lockWasHeld;
			selectedProfileId = currentProfileId;
			releaseSnapshot();
			releaseLock();
			await scanning;
		} finally {
			releaseLock();
			releaseSnapshot();
			await Promise.allSettled([scanning, heldMutation, service.close()]);
		}
		expect(boundProfiles).toEqual([staleProfileId, currentProfileId]);
		expect((await readCodexConfigurationSyncStore()).writers[binding.writerId].codexConfigurationProfileId).toBe(
			currentProfileId,
		);
	});

	it("锁外读到的原生权限证据在转录追加后不会覆盖已发布的新权限", async () => {
		const binding = await prepareWriter("stale-permission-session");
		const nativeSessionId = randomUUID();
		const transcriptPath = join(fixture.path, "stale-permission.jsonl");
		const turnContext = (approval: string, sandbox: string) =>
			`${JSON.stringify({
				type: "turn_context",
				timestamp: new Date().toISOString(),
				payload: { approval_policy: approval, sandbox_policy: { type: sandbox } },
			})}\n`;
		await writeFile(
			transcriptPath,
			`${JSON.stringify({
				type: "session_meta",
				payload: { id: nativeSessionId, source: "cli", cwd: fixture.path },
			})}\n${turnContext("never", "danger-full-access")}`,
		);
		const summary = runtimeTaskSessionSummarySchema.parse({
			taskId: "stale-permission-session",
			agentId: "codex",
			workspacePath: fixture.path,
			turnOwner: "user",
			liveness: "live",
			userTurnKind: "review",
			pid: 1234,
			startedAt: 1,
			updatedAt: 1,
			lastOutputAt: null,
			reviewReason: null,
			exitCode: null,
			runtimeSessionIncarnationId: binding.runtimeSessionIncarnationId,
			codexConfigurationWriterBinding: binding,
			codexEffectivePermissionMode: null,
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "codex",
				nativeSessionId,
				transcriptPath,
				observedAt: 1,
			},
		});
		let releaseObservation = () => {};
		const observationReleased = new Promise<void>((resolve) => {
			releaseObservation = resolve;
		});
		let markObservationPaused = () => {};
		const observationPaused = new Promise<void>((resolve) => {
			markObservationPaused = resolve;
		});
		let pauseOnce = true;
		const publications: Array<Record<string, { value: unknown }> | null> = [];
		const freshPermission = {
			[JSON.stringify(["config.toml", "approval_policy"])]: { value: "on-request" },
			[JSON.stringify(["config.toml", "sandbox_mode"])]: { value: "workspace-write" },
		};
		const service = createCodexConfigurationSyncService({
			listSessions: () => [{ workspaceId: "scan-contention-workspace", summary }],
			onUpdated: () => {},
			listTaskProfileBindings: async () => {
				if (pauseOnce) {
					pauseOnce = false;
					markObservationPaused();
					await observationReleased;
				}
				return { bindings: [], unavailableWorkspaceCount: 0 };
			},
			onWriterPermissionsObserved: (_workspaceId, _sessionId, fields) => {
				publications.push(fields);
				const approval = fields?.[JSON.stringify(["config.toml", "approval_policy"])]?.value;
				summary.codexEffectivePermissionMode =
					approval === "never" ? "bypass_all_permission_prompts" : fields ? "ask_for_every_tool_use" : null;
			},
		});
		const firstScan = service.scan();
		try {
			await observationPaused;
			await appendFile(transcriptPath, turnContext("on-request", "workspace-write"));
			await service.mutateProfile({
				action: "set_default",
				profileId: binding.codexConfigurationProfileId ?? "",
				idempotencyKey: randomUUID(),
			});
			releaseObservation();
			await firstScan;
			await service.scan();
		} finally {
			releaseObservation();
			await Promise.allSettled([firstScan, service.close()]);
		}
		expect(publications.at(-1)).toEqual(freshPermission);
		expect(
			publications.some((fields) => fields?.[JSON.stringify(["config.toml", "approval_policy"])]?.value === "never"),
		).toBe(false);
		expect(
			(await readCodexConfigurationSyncStore()).writers[binding.writerId].pendingNativePermissionVerificationAtMs,
		).toBeUndefined();
	});

	it("真实 hook 摘要读取暂停期间，其他任务准备不等待扫描锁", async () => {
		const hookPath = join(sourceHome, "hooks.json");
		await writeFile(
			hookPath,
			JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "true" }] }] } }),
		);
		await writeFile(
			join(sourceHome, "config.toml"),
			stringify({
				model: "initial-model",
				hooks: { state: { [`${hookPath}:stop:0:0`]: { trusted_hash: "fixture-hook-hash", enabled: true } } },
			}),
		);
		const binding = await prepareWriter("observed-session");
		const barrier = suspendNextConfigurationObservation("");
		suspendedObservation.hookDefinitionPath = join(binding.configurationHomeDirectoryPath, "hooks.json");
		const service = createCodexConfigurationSyncService({ listSessions: () => [], onUpdated: () => {} });
		const scanning = service.scan();
		try {
			await barrier.observationRead;
			await assertCodexConfigurationStoreKernelWriteLockAvailable();
			await expect(prepareWriter("another-session")).resolves.toHaveProperty(
				"conversationSessionId",
				"another-session",
			);
		} finally {
			barrier.releaseObservation();
			await scanning;
			await service.close();
		}
	});

	it.each([
		["unchanged", "native_read"],
		["generation_replaced", "native_read"],
		["native_identity_replaced", "native_read"],
		["writer_replaced", "native_read"],
		["working_directory_replaced", "native_read"],
		["exited_session_became_live", "native_read"],
		["generation_replaced", "fingerprint_check"],
		["native_identity_replaced", "fingerprint_check"],
		["writer_replaced", "fingerprint_check"],
		["working_directory_replaced", "fingerprint_check"],
	] as const)("%s 在 %s 期间变化时只向仍匹配的会话发布权限", async (concurrentChange, verificationStage) => {
		const binding = await prepareWriter("permission-session");
		const independentSourceHome = join(fixture.path, "independent-source-home");
		await mkdir(independentSourceHome);
		await writeFile(join(independentSourceHome, "config.toml"), 'model="independent-model"\n');
		const nativeSessionId = randomUUID();
		const transcriptPath = join(binding.conversationStorageHomeDirectoryPath, "sessions", "permission-session.jsonl");
		await mkdir(join(binding.conversationStorageHomeDirectoryPath, "sessions"), { recursive: true });
		await writeFile(
			transcriptPath,
			[
				JSON.stringify({
					type: "session_meta",
					payload: { id: nativeSessionId, source: "cli", cwd: fixture.path },
				}),
				JSON.stringify({
					type: "turn_context",
					timestamp: new Date().toISOString(),
					payload: {
						approval_policy: "on-request",
						sandbox_policy: { type: "workspace-write" },
					},
				}),
				"",
			].join("\n"),
		);
		const summary = runtimeTaskSessionSummarySchema.parse({
			taskId: "permission-session",
			agentId: "codex",
			workspacePath: fixture.path,
			turnOwner: "user",
			liveness: concurrentChange === "exited_session_became_live" ? "exited" : "live",
			userTurnKind: "review",
			pid: 1234,
			startedAt: 1,
			updatedAt: 1,
			lastOutputAt: null,
			reviewReason: null,
			exitCode: null,
			runtimeSessionIncarnationId: binding.runtimeSessionIncarnationId,
			codexConfigurationWriterBinding: binding,
			codexEffectivePermissionMode: null,
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "codex",
				nativeSessionId,
				transcriptPath,
				observedAt: 1,
			},
		});
		const observedPermissions = vi.fn();
		const service = createCodexConfigurationSyncService({
			listSessions: () => [{ workspaceId: "scan-contention-workspace", summary }],
			onUpdated: () => {},
			onWriterPermissionsObserved: observedPermissions,
		});
		const barrier = suspendNextConfigurationObservation("");
		suspendedObservation.nativePermissionRead = verificationStage === "native_read";
		suspendedObservation.nativePermissionTranscriptFingerprintCheck = verificationStage === "fingerprint_check";
		const scanning = service.scan();
		try {
			await barrier.observationRead;
			if (verificationStage === "native_read") {
				await assertCodexConfigurationStoreKernelWriteLockAvailable();
				await prepareWriter("another-session", independentSourceHome);
			}
			if (concurrentChange === "generation_replaced") summary.runtimeSessionIncarnationId = randomUUID();
			if (concurrentChange === "native_identity_replaced" && summary.agentNativeConversationSessionIdentity)
				summary.agentNativeConversationSessionIdentity.nativeSessionId = randomUUID();
			if (concurrentChange === "writer_replaced")
				summary.codexConfigurationWriterBinding = { ...binding, writerId: randomUUID() };
			if (concurrentChange === "working_directory_replaced") summary.workspacePath = independentSourceHome;
			if (concurrentChange === "exited_session_became_live") summary.liveness = "live";
		} finally {
			barrier.releaseObservation();
			await scanning;
		}
		try {
			if (concurrentChange === "unchanged" || concurrentChange === "exited_session_became_live") {
				expect(observedPermissions).toHaveBeenCalledWith("scan-contention-workspace", "permission-session", {
					[JSON.stringify(["config.toml", "approval_policy"])]: { value: "on-request" },
					[JSON.stringify(["config.toml", "sandbox_mode"])]: { value: "workspace-write" },
				});
			} else expect(observedPermissions).not.toHaveBeenCalled();
			expect((await readCodexConfigurationSyncStore()).writers[binding.writerId].retiredAt).toBeUndefined();
		} finally {
			await service.close();
		}
	});

	it("writer 读取挂起期间，另一任务仍能准备 resume", async () => {
		const binding = await prepareWriter("observed-session");
		const independentSourceHome = join(fixture.path, "independent-source-home");
		await mkdir(independentSourceHome);
		await writeFile(join(independentSourceHome, "config.toml"), 'model="independent-model"\n');
		const independentBinding = await prepareWriter("resuming-session", independentSourceHome);
		const observedHome = binding.configurationHomeDirectoryPath;
		await writeFile(join(observedHome, "config.toml"), 'model="independent-observation"\n');
		const service = createCodexConfigurationSyncService({ listSessions: () => [], onUpdated: () => {} });
		const barrier = suspendNextConfigurationObservation(observedHome);
		const scanning = service.scan();
		try {
			await barrier.observationRead;
			await assertCodexConfigurationStoreKernelWriteLockAvailable();
			const resumedBinding = await prepareCodexConfigurationWriterBinding({
				purpose: "native_session",
				storageHome: independentSourceHome,
				previousBinding: independentBinding,
				workspaceId: "scan-contention-workspace",
				conversationSessionId: "resuming-session",
				runtimeSessionIncarnationId: randomUUID(),
			});
			expect(resumedBinding.sourceIdentity).toBe(independentBinding.sourceIdentity);
			expect(resumedBinding.conversationStorageHomeDirectoryPath).toBe(
				independentBinding.conversationStorageHomeDirectoryPath,
			);
		} finally {
			barrier.releaseObservation();
			await scanning;
			await service.close();
		}
		expect(
			(await readCodexConfigurationSyncStore()).changes.some(
				(change) => change.value?.value === "independent-observation",
			),
		).toBe(true);
	});

	it("writer 的旧观察不覆盖并发 profile 决定，下一次补扫采用新观察", async () => {
		const binding = await prepareWriter("observed-session");
		const service = createCodexConfigurationSyncService({ listSessions: () => [], onUpdated: () => {} });
		const observedHome = binding.configurationHomeDirectoryPath;
		const modelFieldKey = JSON.stringify(["config.toml", "model"]);
		await writeFile(join(observedHome, "config.toml"), 'model="obsolete-observation"\n');
		const barrier = suspendNextConfigurationObservation(observedHome);
		const scanning = service.scan();
		try {
			await barrier.observationRead;
			await assertCodexConfigurationStoreKernelWriteLockAvailable();
			await mutateCodexConfigurationSyncStore((store) => {
				const profileId = store.writers[binding.writerId].codexConfigurationProfileId;
				if (!profileId) throw new Error("缺少合成 profile");
				updateCodexConfigurationProfileFields(store, profileId, { [modelFieldKey]: { value: "new-decision" } });
			});
			await writeFile(join(observedHome, "config.toml"), 'model="fresh-observation"\n');
		} finally {
			barrier.releaseObservation();
			await scanning;
		}
		try {
			const store = await readCodexConfigurationSyncStore();
			expect(store.changes.some((change) => change.value?.value === "obsolete-observation")).toBe(false);
			expect(store.writers[binding.writerId].lastObservedFields[modelFieldKey].value).toBe("initial-model");
			expect(store.profiles[binding.codexConfigurationProfileId ?? ""].fields[modelFieldKey].value).toBe(
				"new-decision",
			);
			await service.scan();
			expect(
				(await readCodexConfigurationSyncStore()).changes.some(
					(change) => change.value?.value === "fresh-observation",
				),
			).toBe(true);
		} finally {
			await service.close();
		}
	});
});
