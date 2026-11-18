import { randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { createCodexConfigurationSyncService } from "../../../src/codex-configuration-sync/codex-configuration-sync-service";
import {
	type CodexConfigurationCurrentSessionIdentity,
	closeCodexConfigurationSyncDatabase,
	getCodexConfigurationSyncDirectory,
	listCodexConfigurationStoredSessionAdoptionProgress,
	mutateCodexConfigurationSyncStore,
	readCodexConfigurationSyncOverviewStore,
	readCodexConfigurationSyncStorageMetrics,
	type StoredCodexConfigurationChange,
} from "../../../src/codex-configuration-sync/codex-configuration-sync-store";
import { prepareCodexConfigurationWriterBinding } from "../../../src/codex-configuration-sync/codex-configuration-writer-binding";
import { assertCodexConfigurationAdoptionQueryHistoryWorkIsBounded } from "../../fixtures/codex-configuration-adoption-query-history-work";
import { createTempDir } from "../../utilities/temp-dir";

let fixture: ReturnType<typeof createTempDir>;
afterEach(async () => {
	await closeCodexConfigurationSyncDatabase();
	vi.unstubAllEnvs();
	fixture?.cleanup();
});

it("完整采用统计与详情 SQL 的扫描量不随无关历史扩大十倍", async (context) => {
	const report = assertCodexConfigurationAdoptionQueryHistoryWorkIsBounded();
	await context.annotate(JSON.stringify(report), "sqlite-vm-instruction-budget");
	expect(report.failures).toEqual([]);
	console.info("采用 SQL 历史增长计量", JSON.stringify(report.comparisons));
});

it("采用索引保留重载与启动继承归属，旧库升级和再次重启不改变历史原文", async () => {
	fixture = createTempDir("codex-adoption-index-upgrade-");
	fixture.path = await realpath(fixture.path);
	const configurationHome = join(fixture.path, "isolated-codex-home");
	vi.stubEnv("HOME", fixture.path);
	vi.stubEnv("CODEX_HOME", configurationHome);
	vi.stubEnv("CODEX_SQLITE_HOME", configurationHome);
	await mkdir(configurationHome);
	await writeFile(join(configurationHome, "config.toml"), 'model = "fixture-model"\n');
	const binding = await prepareCodexConfigurationWriterBinding({
		purpose: "native_session",
		storageHome: configurationHome,
		workspaceId: "adoption-index-upgrade",
		conversationSessionId: "current-session",
		runtimeSessionIncarnationId: randomUUID(),
	});
	const session: CodexConfigurationCurrentSessionIdentity = {
		workspaceId: binding.workspaceId ?? "",
		conversationSessionId: binding.conversationSessionId ?? "",
		runtimeSessionIncarnationId: binding.runtimeSessionIncarnationId,
		writerId: binding.writerId,
		profileId: binding.codexConfigurationProfileId ?? null,
	};
	const fieldKey = JSON.stringify(["config.toml", "model"]);
	const changeId = "current-profile-field-adoption-evidence";
	let currentFieldVersion = 0;
	await mutateCodexConfigurationSyncStore((store) => {
		const profile = store.profiles[session.profileId ?? ""];
		const writer = store.writers[binding.writerId];
		if (!profile || !writer) throw new Error("缺少隔离配置或当前 writer");
		currentFieldVersion = ++store.revision;
		profile.fieldVersions[fieldKey] = currentFieldVersion;
		profile.version = currentFieldVersion;
		writer.consumedProfileFieldVersions ??= {};
		writer.consumedProfileFieldVersions[fieldKey] = currentFieldVersion - 1;
		store.changes.push({
			changeId,
			version: currentFieldVersion,
			sourceIdentity: profile.sourceIdentity,
			sourceWriterId: binding.writerId,
			codexConfigurationProfileId: profile.profileId,
			fieldKey,
			value: { value: "fixture-model" },
			acceptedProfileFieldVersion: currentFieldVersion,
			recordKind: "historical_record",
			approvalStatus: "approved",
			mergeStatus: "shared_default_updated",
			acknowledgedAt: 1,
			observedAt: 1,
			targets: [
				{
					writerId: binding.writerId,
					workspaceId: session.workspaceId,
					conversationSessionId: session.conversationSessionId,
					status: "applied",
					reason: "原所有者已重载，保留原始诊断正文。",
					attemptCount: 1,
					acceptedAt: 1,
					diskSavedAt: 1,
					ownerReloadedAt: 1,
					recoveryCondition: null,
				},
			],
		});
	});
	const editAdoptionEvidence = (edit: (change: StoredCodexConfigurationChange) => void) =>
		mutateCodexConfigurationSyncStore((store) => {
			const change = store.changes.find((entry) => entry.changeId === changeId);
			if (!change) throw new Error("缺少采用证据");
			edit(change);
		});
	const expectAdoptionStatus = async (status: "adopted" | "unverified") => {
		expect((await readCodexConfigurationSyncOverviewStore([session])).adoptionCounts).toEqual([
			{
				profileId: session.profileId,
				total: 1,
				adopted: Number(status === "adopted"),
				unverified: Number(status === "unverified"),
				pending: 0,
				saved: 0,
				conflict: 0,
				local_selection: 0,
			},
		]);
		expect(
			(await listCodexConfigurationStoredSessionAdoptionProgress({ limit: 50 }, [session])).entries,
		).toMatchObject([{ writerId: binding.writerId, status }]);
	};
	await expectAdoptionStatus("adopted");
	await editAdoptionEvidence((change) => {
		change.targets[0].ownerReloadedAt = null;
	});
	await expectAdoptionStatus("unverified");
	await editAdoptionEvidence((change) => {
		change.targets[0].writerId = "previous-writer";
		change.targets[0].appliedAtStartupByWriterId = binding.writerId;
	});
	await expectAdoptionStatus("adopted");
	for (const attribution of [
		{ workspaceId: "other-workspace", conversationSessionId: session.conversationSessionId },
		{ workspaceId: session.workspaceId, conversationSessionId: "other-session" },
	]) {
		await editAdoptionEvidence((change) => Object.assign(change.targets[0], attribution));
		await expectAdoptionStatus("unverified");
	}
	await editAdoptionEvidence((change) => {
		change.targets[0].workspaceId = session.workspaceId;
		change.targets[0].conversationSessionId = session.conversationSessionId;
		change.acceptedProfileFieldVersion = currentFieldVersion - 1;
	});
	await expectAdoptionStatus("unverified");
	await editAdoptionEvidence((change) => {
		change.acceptedProfileFieldVersion = currentFieldVersion;
		change.value = { value: "different-model" };
	});
	await expectAdoptionStatus("unverified");
	await editAdoptionEvidence((change) => {
		change.value = { value: "fixture-model" };
	});
	await expectAdoptionStatus("adopted");
	await editAdoptionEvidence((change) => {
		change.approvalStatus = "rejected";
	});
	await expectAdoptionStatus("unverified");
	await editAdoptionEvidence((change) => {
		change.approvalStatus = "approved";
	});
	await expectAdoptionStatus("adopted");

	await closeCodexConfigurationSyncDatabase();
	const databasePath = join(getCodexConfigurationSyncDirectory(), "codex-configuration-sync.sqlite");
	const readHistoricalRows = (database: Database.Database) => ({
		changes: database.prepare("SELECT * FROM configuration_changes ORDER BY change_id").all(),
		targets: database
			.prepare(
				"SELECT change_id,writer_id,insertion_sequence,status,payload_json,requires_legacy_observation FROM configuration_propagation_targets ORDER BY change_id,writer_id",
			)
			.all(),
		history: database.prepare("SELECT * FROM configuration_history_entries ORDER BY history_sequence").all(),
	});
	const legacyDatabase = new Database(databasePath, { fileMustExist: true });
	let originalHistoricalRows: ReturnType<typeof readHistoricalRows>;
	try {
		originalHistoricalRows = readHistoricalRows(legacyDatabase);
		legacyDatabase.transaction(() => {
			legacyDatabase.exec(`
				DROP INDEX configuration_targets_current_writer_adoption_field;
				DROP INDEX configuration_targets_startup_writer_adoption_field;
				ALTER TABLE configuration_propagation_targets DROP COLUMN approved_profile_field_value_version_key;
				PRAGMA user_version = 1;
			`);
		})();
	} finally {
		legacyDatabase.close();
	}
	for (let restart = 0; restart < 2; restart++) {
		await expectAdoptionStatus("adopted");
		await closeCodexConfigurationSyncDatabase();
		const upgradedDatabase = new Database(databasePath, { readonly: true, fileMustExist: true });
		try {
			expect(upgradedDatabase.pragma("user_version", { simple: true })).toBe(2);
			expect(readHistoricalRows(upgradedDatabase)).toEqual(originalHistoricalRows);
			expect(
				upgradedDatabase
					.prepare(
						"SELECT count(*) FROM configuration_propagation_targets WHERE approved_profile_field_value_version_key IS NOT NULL",
					)
					.pluck()
					.get(),
			).toBe(1);
		} finally {
			upgradedDatabase.close();
		}
	}
});
it("历史和传播目标扩大十倍时概览不解码目标，按完整当前代际计数并稳定分页", async () => {
	fixture = createTempDir("codex-overview-read-budget-");
	fixture.path = await realpath(fixture.path);
	const configurationHome = join(fixture.path, "isolated-codex-home");
	vi.stubEnv("HOME", fixture.path);
	vi.stubEnv("CODEX_HOME", configurationHome);
	vi.stubEnv("CODEX_SQLITE_HOME", configurationHome);
	await mkdir(configurationHome);
	await writeFile(join(configurationHome, "config.toml"), 'model = "fixture-model"\n');
	const binding = await prepareCodexConfigurationWriterBinding({
		purpose: "native_session",
		storageHome: configurationHome,
		workspaceId: "budget",
		conversationSessionId: "current-session",
		runtimeSessionIncarnationId: randomUUID(),
	});
	const session: CodexConfigurationCurrentSessionIdentity = {
		workspaceId: "budget",
		conversationSessionId: "current-session",
		runtimeSessionIncarnationId: binding.runtimeSessionIncarnationId,
		writerId: binding.writerId,
		profileId: binding.codexConfigurationProfileId ?? null,
	};
	const fieldKey = JSON.stringify(["config.toml", "model"]);
	const addTargets = async (count: number) =>
		mutateCodexConfigurationSyncStore((store) => {
			const profile = store.profiles[session.profileId ?? ""];
			if (!profile) throw new Error("缺少隔离配置");
			for (let index = store.changes.length; index < count; index++)
				store.changes.push({
					changeId: `history-${index}`,
					version: ++store.revision,
					sourceIdentity: profile.sourceIdentity,
					sourceWriterId: binding.writerId,
					codexConfigurationProfileId: profile.profileId,
					fieldKey,
					value: { value: "fixture-model" },
					acceptedProfileFieldVersion: profile.fieldVersions[fieldKey],
					recordKind: "historical_record",
					approvalStatus: "approved",
					mergeStatus: "shared_default_updated",
					acknowledgedAt: 1,
					observedAt: 1,
					targets: [
						{
							writerId: index === 0 ? binding.writerId : `old-writer-${index}`,
							workspaceId: "budget",
							conversationSessionId: "current-session",
							status: index === 0 ? "applied" : "pending_reload",
							reason: "x".repeat(4096),
							attemptCount: 1,
							acceptedAt: 1,
							diskSavedAt: 1,
							ownerReloadedAt: index === 0 ? 1 : null,
							recoveryCondition: null,
						},
					],
				});
		});
	await addTargets(100);
	const first = await readCodexConfigurationSyncOverviewStore([session, session]);
	const firstMetrics = await readCodexConfigurationSyncStorageMetrics();
	await addTargets(1000);
	const grown = await readCodexConfigurationSyncOverviewStore([session, session]);
	const grownMetrics = await readCodexConfigurationSyncStorageMetrics();
	expect(grown.adoptionCounts).toEqual([
		{
			profileId: session.profileId,
			total: 1,
			adopted: 1,
			pending: 0,
			saved: 0,
			conflict: 0,
			local_selection: 0,
			unverified: 0,
		},
	]);
	expect(grownMetrics.decodedRows).toBe(firstMetrics.decodedRows);
	expect(grownMetrics.decodedBytes).toBeLessThan(firstMetrics.decodedBytes + 2000);
	expect(grown.store.changes.flatMap((change) => change.targets)).toHaveLength(0);
	expect(JSON.stringify(grown).length).toBeLessThan(JSON.stringify(first).length + 2000);
	await mutateCodexConfigurationSyncStore((store) => {
		const writer = store.writers[binding.writerId];
		const change = store.changes.find((item) =>
			item.targets.some((target) => target.writerId === binding.writerId && target.status === "applied"),
		);
		const target = change?.targets.find((item) => item.writerId === binding.writerId && item.status === "applied");
		if (!writer || !target) throw new Error("缺少当前代际采用证据");
		writer.consumedProfileFieldVersions ??= {};
		writer.consumedProfileFieldVersions[fieldKey] = 0;
		target.writerId = "previous-writer";
		target.ownerReloadedAt = null;
		target.appliedAtStartupByWriterId = binding.writerId;
		target.workspaceId = session.workspaceId;
		target.conversationSessionId = session.conversationSessionId;
	});
	expect((await readCodexConfigurationSyncOverviewStore([session])).adoptionCounts[0]).toMatchObject({
		total: 1,
		adopted: 1,
		unverified: 0,
	});
	const nextGeneration = { ...session, runtimeSessionIncarnationId: randomUUID() };
	expect((await readCodexConfigurationSyncOverviewStore([nextGeneration])).adoptionCounts).toEqual([]);
	const sessions = Array.from({ length: 120 }, (_, index) => ({
		...session,
		conversationSessionId: `session-${String(index).padStart(3, "0")}`,
		writerId: null,
	}));
	expect((await readCodexConfigurationSyncOverviewStore(sessions)).adoptionCounts).toEqual([]);
	const page = await listCodexConfigurationStoredSessionAdoptionProgress({ limit: 50 }, sessions);
	expect(page.entries).toHaveLength(50);
	expect(page.totalCount).toBe(120);
	const second = await listCodexConfigurationStoredSessionAdoptionProgress(
		{ limit: 50, cursor: page.nextCursor ?? undefined },
		sessions,
	);
	expect(second.entries[0]?.conversationSessionId).toBe("session-050");
	const service = createCodexConfigurationSyncService({
		getSessionSummary: () => null,
		listSessions: () => [],
		onUpdated: () => {},
	});
	try {
		expect((await service.getOverview()).stateResponseScope).toBe("overview");
	} finally {
		await service.close();
	}
});
