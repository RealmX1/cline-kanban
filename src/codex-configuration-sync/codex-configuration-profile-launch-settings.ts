import { isCodexPermissionConfigurationOverrideArgument } from "../codex-native-session-control-host/codex-remote-conversation-launch-plan";
import type { RuntimeTaskAgentPermissionMode } from "../core/api-contract";
import {
	type CodexConfigurationFields,
	configurationFieldAddress,
	configurationTable,
} from "./codex-configuration-field-projection";
import { codexConfigurationExceptionGroup } from "./codex-configuration-profiles";

export function formatCodexConfigurationOverrideTomlValue(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(formatCodexConfigurationOverrideTomlValue).join(", ")}]`;
	if (configurationTable(value))
		return `{ ${Object.entries(value)
			.map(([key, child]) => `${JSON.stringify(key)} = ${formatCodexConfigurationOverrideTomlValue(child)}`)
			.join(", ")} }`;
	if (["string", "number", "boolean"].includes(typeof value)) return JSON.stringify(value);
	throw new Error("Codex 配置覆盖不是可序列化的 TOML 值。");
}

export function codexConfigurationPermissionMode(
	fields: CodexConfigurationFields,
): RuntimeTaskAgentPermissionMode | null {
	if (Object.keys(fields).some((key) => configurationFieldAddress(key).keyPath[0] === "permissions")) return null;
	const approval = fields[JSON.stringify(["config.toml", "approval_policy"])]?.value;
	const sandbox = fields[JSON.stringify(["config.toml", "sandbox_mode"])]?.value;
	if (approval === undefined || sandbox === undefined) return null;
	return approval === "never" && sandbox === "danger-full-access"
		? "bypass_all_permission_prompts"
		: "ask_for_every_tool_use";
}

export function buildCodexArgumentsUsingCompleteProfilePermissions(
	arguments_: string[],
	fields: CodexConfigurationFields,
) {
	const permissionFields = Object.entries(fields).filter(
		([key]) =>
			codexConfigurationExceptionGroup(key) === "permissions" &&
			configurationFieldAddress(key).fileName === "config.toml" &&
			configurationFieldAddress(key).keyPath[0] !== "profiles",
	);
	if (!permissionFields.length) return null;
	const result: string[] = [];
	for (let index = 0; index < arguments_.length; index++) {
		const argument = arguments_[index];
		if (argument === undefined) continue;
		if (argument === "--") {
			result.push(...arguments_.slice(index));
			break;
		}
		if (["--dangerously-bypass-approvals-and-sandbox", "--full-auto", "--approve-for-me"].includes(argument))
			continue;
		if (["--ask-for-approval", "--sandbox", "-a", "-s"].includes(argument)) {
			index++;
			continue;
		}
		if (/^(?:--ask-for-approval=|--sandbox=|-a.+|-s.+)/.test(argument)) continue;
		if (argument === "-c" || argument === "--config") {
			const value = arguments_[++index];
			if (value && !isCodexPermissionConfigurationOverrideArgument(value)) result.push(argument, value);
			continue;
		}
		const attached = argument.startsWith("--config=")
			? argument.slice(9)
			: argument.startsWith("-c")
				? argument.slice(2).replace(/^=/, "")
				: null;
		if (attached && isCodexPermissionConfigurationOverrideArgument(attached)) continue;
		result.push(argument);
	}
	const insertionIndex = result.indexOf("--");
	const overrides = permissionFields.flatMap(([fieldKey, field]) => [
		"-c",
		`${configurationFieldAddress(fieldKey)
			.keyPath.map((key) => (/^[a-zA-Z0-9_-]+$/.test(key) ? key : JSON.stringify(key)))
			.join(".")}=${formatCodexConfigurationOverrideTomlValue(field.value)}`,
	]);
	result.splice(insertionIndex < 0 ? result.length : insertionIndex, 0, ...overrides);
	return result;
}
