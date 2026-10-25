import { createHash } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse, type TomlTable } from "smol-toml";

export interface CodexConfigurationFieldValue {
	value: unknown;
	definitionDigest?: string;
}
export type CodexConfigurationFields = Record<string, CodexConfigurationFieldValue>;
export const configurationDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const sameConfigurationField = (
	left: CodexConfigurationFieldValue | undefined,
	right: CodexConfigurationFieldValue | undefined,
) => isDeepStrictEqual(left, right);
export function configurationTable(value: unknown): value is TomlTable {
	return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

// 不共享认证、机器路径、原生身份或运行时注入；这些字段仍留在各自副本中。
const privateConfigurationRootKeys = new Set([
	"sqlite_home",
	"log_dir",
	"history",
	"projects",
	"mcp_servers",
	"model_providers",
	"otel",
	"analytics",
	"model_instructions_file",
	"experimental_instructions_file",
	"experimental_compact_prompt_file",
	"model_catalog_json",
	"agents",
]);
const sensitiveConfigurationKey = /(?:secret|token|password|credential|api_key|authorization|private_key|env)/i;

export function relocateCodexHookStateSourcePaths(configuration: TomlTable, from: string, to: string) {
	const visit = (table: TomlTable) => {
		if (configurationTable(table.hooks) && configurationTable(table.hooks.state)) {
			table.hooks.state = Object.fromEntries(
				Object.entries(table.hooks.state).map(([key, value]) => [
					key.startsWith(`${from}/`) ? `${to}${key.slice(from.length)}` : key,
					value,
				]),
			);
		}
		if (configurationTable(table.profiles))
			for (const profile of Object.values(table.profiles)) if (configurationTable(profile)) visit(profile);
	};
	visit(configuration);
}

export function configurationFieldAddress(fieldKey: string): { fileName: string; keyPath: string[] } {
	const [fileName, ...keyPath] = JSON.parse(fieldKey) as string[];
	if (!fileName || !/^(?:config|[\w.-]+\.config)\.toml$/.test(fileName) || !keyPath.length)
		throw new Error("Codex 配置字段地址无效。");
	return { fileName, keyPath };
}

export function setConfigurationField(
	configuration: TomlTable,
	keyPath: string[],
	field: CodexConfigurationFieldValue | undefined,
) {
	let parent = configuration;
	for (const key of keyPath.slice(0, -1)) {
		if (!configurationTable(parent[key])) parent[key] = {};
		parent = parent[key] as TomlTable;
	}
	const key = keyPath.at(-1);
	if (!key) throw new Error("Codex 配置字段缺少键。");
	if (field === undefined) delete parent[key];
	else parent[key] = structuredClone(field.value) as TomlTable[string];
}

export async function readCodexHookDefinitionDigest(home: string, sourceHome: string, key: string) {
	const sourcePath = key.replace(/:[a-z_]+:\d+:\d+$/, "");
	if (sourcePath === key || key.includes("<session-flags>")) return undefined;
	try {
		let actualPath = sourcePath.startsWith(`${sourceHome}/`)
			? join(home, sourcePath.slice(sourceHome.length + 1))
			: sourcePath;
		let pluginSourceIdentity:
			| { pluginId: string; installedDirectoryPath: string; relativeSourcePath: string }
			| undefined;
		if (!isAbsolute(actualPath)) {
			const pluginSource = /^([^@:/\\]+)@([^@:/\\]+):(.+)$/.exec(sourcePath);
			if (!pluginSource) return undefined;
			const [, pluginName, marketplaceName, relativeSourcePath] = pluginSource;
			if (!pluginName || !marketplaceName || !relativeSourcePath) return undefined;
			if ([pluginName, marketplaceName].some((name) => name === "." || name === "..")) return undefined;
			const cacheDirectory = await realpath(join(home, "plugins", "cache", marketplaceName, pluginName));
			const installedVersions = (await readdir(cacheDirectory, { withFileTypes: true })).filter(
				(entry) => !entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink()),
			);
			// 原生升级会清理旧版本；多个候选时保留未知，不能猜测哪个版本属于当前来源。
			const [installedVersion] = installedVersions;
			if (installedVersions.length !== 1 || !installedVersion) return undefined;
			const installedDirectoryPath = await realpath(join(cacheDirectory, installedVersion.name));
			if (dirname(installedDirectoryPath) !== cacheDirectory) return undefined;
			let manifest: unknown;
			for (const manifestPath of [".codex-plugin/plugin.json", "plugin.json", ".claude-plugin/plugin.json"]) {
				try {
					manifest = JSON.parse(await readFile(join(installedDirectoryPath, manifestPath), "utf8"));
					break;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			}
			if (!configurationTable(manifest) || manifest.name !== pluginName || isAbsolute(relativeSourcePath))
				return undefined;
			actualPath = await realpath(resolve(installedDirectoryPath, relativeSourcePath));
			const relativeDefinitionPath = relative(installedDirectoryPath, actualPath);
			if (relativeDefinitionPath.startsWith("..") || isAbsolute(relativeDefinitionPath)) return undefined;
			pluginSourceIdentity = {
				pluginId: `${pluginName}@${marketplaceName}`,
				installedDirectoryPath,
				relativeSourcePath: relativeDefinitionPath,
			};
		}
		const text = await readFile(actualPath, "utf8");
		const definition = actualPath.endsWith(".toml") ? parse(text) : JSON.parse(text);
		const removeTrust = (value: unknown): unknown => {
			if (Array.isArray(value)) return value.map(removeTrust);
			if (!configurationTable(value)) return value;
			return Object.fromEntries(
				Object.keys(value)
					.sort()
					.filter((name) => name !== "state")
					.map((name) => [name, removeTrust(value[name])]),
			);
		};
		const profileHooks = configurationTable(definition.profiles)
			? Object.fromEntries(
					Object.entries(definition.profiles)
						.filter(([, profile]) => configurationTable(profile))
						.map(([name, profile]) => [name, (profile as TomlTable).hooks ?? {}]),
				)
			: {};
		return configurationDigest(
			removeTrust({ hooks: definition.hooks ?? {}, profiles: profileHooks, ...pluginSourceIdentity }),
		);
	} catch {
		return undefined;
	}
}

export async function projectCodexConfigurationFields(input: {
	home: string;
	sourceHome: string;
	fileNames: string[];
	previousFields?: CodexConfigurationFields;
	onHookDefinitionObservationProblem: (fieldKey: string) => void;
}): Promise<CodexConfigurationFields> {
	const fields: CodexConfigurationFields = {};
	const physicalHome = await realpath(input.home);
	const definitionDigests = new Map<string, string | undefined>();
	const hookDefinitionDigest = async (key: string) => {
		if (definitionDigests.has(key)) return definitionDigests.get(key);
		const digest = await readCodexHookDefinitionDigest(input.home, input.sourceHome, key);
		definitionDigests.set(key, digest);
		return digest;
	};
	for (const fileName of input.fileNames) {
		let configuration: TomlTable;
		try {
			configuration = parse(await readFile(join(input.home, fileName), "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		relocateCodexHookStateSourcePaths(configuration, physicalHome, input.sourceHome);
		const visit = async (table: TomlTable, path: string[]) => {
			for (const [key, value] of Object.entries(table)) {
				if (sensitiveConfigurationKey.test(key) || privateConfigurationRootKeys.has(key)) continue;
				const childPath = [...path, key];
				const hookStateIndex = childPath.indexOf("state");
				if (hookStateIndex >= 0 && childPath[hookStateIndex - 1] === "hooks") {
					if (childPath.length === hookStateIndex + 2) {
						if (key.includes("<session-flags>")) continue;
						const fieldKey = JSON.stringify([fileName, ...childPath]);
						const definitionDigest = await hookDefinitionDigest(key);
						if (definitionDigest)
							fields[fieldKey] = {
								value: JSON.parse(JSON.stringify(value)),
								definitionDigest,
							};
						else {
							input.onHookDefinitionObservationProblem(fieldKey);
							const previous = input.previousFields?.[fieldKey];
							if (previous) fields[fieldKey] = structuredClone(previous);
						}
					} else if (configurationTable(value)) await visit(value, childPath);
				} else if (configurationTable(value) && Object.keys(value).length) await visit(value, childPath);
				else fields[JSON.stringify([fileName, ...childPath])] = { value: JSON.parse(JSON.stringify(value)) };
			}
		};
		await visit(configuration, []);
	}
	return fields;
}

export function summarizeConfigurationField(fieldKey: string, field: CodexConfigurationFieldValue | undefined) {
	if (!field) return "已删除";
	const { keyPath } = configurationFieldAddress(fieldKey);
	if (keyPath.includes("state") && configurationTable(field.value)) {
		const state = field.value;
		return `${state.enabled === false ? "已禁用" : "已启用"}，${typeof state.trusted_hash === "string" ? "已保存信任决定" : "未信任"}`;
	}
	if (typeof field.value === "boolean") return field.value ? "开启" : "关闭";
	return "已设置（值已隐藏）";
}
