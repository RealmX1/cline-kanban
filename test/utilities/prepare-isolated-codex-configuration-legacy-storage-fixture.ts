import assert from "node:assert/strict";
import { realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import {
	type CodexConfigurationSyncStore,
	closeCodexConfigurationSyncDatabase,
	getCodexConfigurationSyncDirectory,
} from "../../src/codex-configuration-sync/codex-configuration-sync-store";

// 仅在测试独占目录中模拟尚未升级的旧版本，生产代码没有绕过权威屏障的入口。
export async function prepareIsolatedCodexConfigurationLegacyStorageFixture(
	isolatedRoot: string,
	store: CodexConfigurationSyncStore,
) {
	const directory = await realpath(getCodexConfigurationSyncDirectory());
	const boundary = relative(await realpath(isolatedRoot), directory);
	assert(boundary && !boundary.startsWith("..") && !isAbsolute(boundary));
	await closeCodexConfigurationSyncDatabase();
	for (const name of [
		"codex-configuration-sync.sqlite",
		"codex-configuration-sync.sqlite-wal",
		"codex-configuration-sync.sqlite-shm",
		"configuration-sync-storage-authority.json",
	])
		await rm(join(directory, name), { force: true });
	const {
		storageIdentity: _excludedStorageIdentity,
		storageGeneration: _excludedStorageGeneration,
		sourceDecisionGenerations: _excludedSourceDecisionGenerations,
		historyTotalCount: _excludedHistoryTotalCount,
		historyMaximumSequence: _excludedHistoryMaximumSequence,
		historyProjectionGeneration: _excludedHistoryProjectionGeneration,
		...legacy
	} = store;
	await writeFile(join(directory, "configuration-sync-state.json"), JSON.stringify(legacy), { mode: 0o600 });
}
