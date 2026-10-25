import type { TomlTable } from "smol-toml";

function configurationTable(value: unknown): TomlTable | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date)
		? (value as TomlTable)
		: undefined;
}

function hookTrustStates(configuration: TomlTable): TomlTable | undefined {
	const states = configurationTable(configuration.hooks)?.state;
	if (states === undefined) return undefined;
	const table = configurationTable(states);
	if (!table || Object.values(table).some((entry) => !configurationTable(entry)))
		throw new Error("Codex hooks.state 不是有效的信任记录表；保留现有配置，未覆盖信任决定。");
	return table;
}

export function preserveCodexHookTrustDuringConfigurationRefresh(input: {
	configuration: TomlTable;
	persistedManagedConfiguration: TomlTable;
	relocatedHookSourceFilePaths: ReadonlyMap<string, string>;
}): void {
	const { configuration, persistedManagedConfiguration, relocatedHookSourceFilePaths } = input;
	const sourceStates = hookTrustStates(configuration);
	const persistedStates = hookTrustStates(persistedManagedConfiguration);
	const inheritedStates: TomlTable = { ...sourceStates };
	for (const [key, state] of Object.entries(sourceStates ?? {})) {
		for (const [sourcePath, destinationPath] of relocatedHookSourceFilePaths) {
			if (!key.startsWith(`${sourcePath}:`)) continue;
			const relocatedKey = `${destinationPath}${key.slice(sourcePath.length)}`;
			// 只迁移来源身份，哈希逐字保留；定义是否变化仍由 Codex 的原生门禁判断。
			inheritedStates[relocatedKey] ??= state;
		}
	}
	if (sourceStates || persistedStates) {
		const mergedStates: TomlTable = { ...inheritedStates, ...persistedStates };
		for (const [key, state] of Object.entries(mergedStates)) {
			const inherited = configurationTable(inheritedStates[key]);
			const persisted = configurationTable(persistedStates?.[key]);
			// 本目录的记录优先，包括没有 trusted_hash 的显式未信任记录；任一明确禁用继续有效。
			mergedStates[key] = {
				...configurationTable(state),
				...(inherited?.enabled === false || persisted?.enabled === false ? { enabled: false } : {}),
			};
		}
		configuration.hooks = { ...configurationTable(configuration.hooks), state: mergedStates };
	}
	const profiles = configurationTable(configuration.profiles);
	const persistedProfiles = configurationTable(persistedManagedConfiguration.profiles);
	for (const [name, value] of Object.entries(profiles ?? {})) {
		const profile = configurationTable(value);
		if (profile)
			preserveCodexHookTrustDuringConfigurationRefresh({
				configuration: profile,
				persistedManagedConfiguration: configurationTable(persistedProfiles?.[name]) ?? {},
				relocatedHookSourceFilePaths,
			});
	}
}
