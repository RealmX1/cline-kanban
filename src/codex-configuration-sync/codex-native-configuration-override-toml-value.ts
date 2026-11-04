import { configurationTable } from "./codex-configuration-field-projection";

export function formatCodexConfigurationOverrideTomlValue(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(formatCodexConfigurationOverrideTomlValue).join(", ")}]`;
	if (configurationTable(value))
		return `{ ${Object.entries(value)
			.map(([key, child]) => `${JSON.stringify(key)} = ${formatCodexConfigurationOverrideTomlValue(child)}`)
			.join(", ")} }`;
	if (["string", "number", "boolean"].includes(typeof value)) return JSON.stringify(value);
	throw new Error("Codex 配置覆盖不是可序列化的 TOML 值。");
}
