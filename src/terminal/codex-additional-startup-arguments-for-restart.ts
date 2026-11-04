// 这里只识别覆盖关系；未识别的参数逐字交给原生 CLI，绝不作为白名单使用。
const CODEX_VALUE_OPTION_CANONICAL_NAMES: Record<string, string> = {
	"-m": "model",
	"--model": "model",
	"-p": "profile",
	"--profile": "profile",
	"-C": "cd",
	"--cd": "cd",
	"-s": "sandbox",
	"--sandbox": "sandbox",
	"-a": "approval",
	"--ask-for-approval": "approval",
	"-c": "config",
	"--config": "config",
	"--remote": "remote",
	"--remote-auth-token-env": "remote-auth-token-env",
	"--local-provider": "local-provider",
	"-i": "image",
	"--image": "image",
	"--enable": "enable",
	"--disable": "disable",
	"--add-dir": "add-dir",
};
const CODEX_REPEATABLE_VALUE_OPTIONS = new Set(["image", "enable", "disable", "add-dir"]);
const CODEX_AUTOMATIC_PERMISSION_FLAGS = new Set([
	"--full-auto",
	"--approve-for-me",
	"--dangerously-bypass-approvals-and-sandbox",
]);
const CODEX_SINGLE_OCCURRENCE_FLAGS = new Set([
	"--strict-config",
	"--oss",
	"--search",
	"--no-alt-screen",
	"--no-daemon",
	"--worktree",
	"--dangerously-bypass-hook-trust",
	"--all",
	"--last",
	"--include-non-interactive",
	"--help",
	"--version",
]);
const CODEX_SINGLE_VALUE_CONFIGURATION_EQUIVALENTS: Record<string, string> = {
	model: "model",
	sandbox_mode: "sandbox",
	approval_policy: "approval",
	approvals_reviewer: "approvals-reviewer",
};

interface CodexStartupArgumentSegment {
	arguments: string[];
	overrideKeys: string[];
	permissionOverrideKey?: string;
	isPositional?: boolean;
	isStartupImageAttachment?: boolean;
	selectsConversation?: boolean;
	requiresNativeCliParsing?: boolean;
}

function segmentCodexStartupArguments(arguments_: readonly string[]): CodexStartupArgumentSegment[] {
	if (arguments_.some((argument) => argument.includes("\0"))) throw new Error("启动参数不能包含空字符。");
	const segments: CodexStartupArgumentSegment[] = [];
	for (let index = 0; index < arguments_.length; index++) {
		const argument = arguments_[index];
		if (argument === "--") {
			segments.push({ arguments: arguments_.slice(index), overrideKeys: [] });
			break;
		}
		const attachedShortOption = ["-c", "-m", "-p", "-C", "-s", "-a", "-i"].find(
			(option) => argument.startsWith(option) && argument.length > option.length,
		);
		const equalsIndex = argument.startsWith("--") ? argument.indexOf("=") : -1;
		const option = attachedShortOption ?? (equalsIndex > 0 ? argument.slice(0, equalsIndex) : argument);
		const canonicalName = Object.hasOwn(CODEX_VALUE_OPTION_CANONICAL_NAMES, option)
			? CODEX_VALUE_OPTION_CANONICAL_NAMES[option]
			: undefined;
		if (canonicalName) {
			const value = attachedShortOption
				? argument.slice(attachedShortOption.length).replace(/^=/u, "")
				: equalsIndex > 0
					? argument.slice(equalsIndex + 1)
					: arguments_[++index];
			if (value === undefined || (!attachedShortOption && equalsIndex < 0 && value.startsWith("-") && value !== "-"))
				throw new Error(`Codex ${option} 缺少参数值。`);
			const configurationKey =
				canonicalName === "config"
					? value
							.split("=", 1)[0]
							.trim()
							.replace(/^["']|["']$/gu, "")
					: undefined;
			const overrideKey = configurationKey
				? Object.hasOwn(CODEX_SINGLE_VALUE_CONFIGURATION_EQUIVALENTS, configurationKey)
					? CODEX_SINGLE_VALUE_CONFIGURATION_EQUIVALENTS[configurationKey]
					: `config:${configurationKey}`
				: canonicalName;
			const optionArguments = attachedShortOption || equalsIndex > 0 ? [argument] : [argument, value];
			if (canonicalName === "image" && !attachedShortOption && equalsIndex < 0) {
				// 分离形式的 -i/--image 接受多个路径；紧连形式只消费其附带值。
				while (index + 1 < arguments_.length && !arguments_[index + 1].startsWith("-"))
					optionArguments.push(arguments_[++index]);
			}
			segments.push({
				arguments: optionArguments,
				overrideKeys: CODEX_REPEATABLE_VALUE_OPTIONS.has(canonicalName) ? [] : [overrideKey],
				// 点路径保持按键覆盖，但仍需移除会压过整个审批配置的旗标。
				permissionOverrideKey: configurationKey?.startsWith("approval_policy.") ? "approval" : undefined,
				requiresNativeCliParsing: canonicalName === "image",
				isStartupImageAttachment: canonicalName === "image",
			});
		} else {
			const flag = argument === "-h" ? "--help" : argument === "-V" ? "--version" : argument;
			const requiresNativeCliParsing =
				argument.startsWith("-") &&
				!CODEX_SINGLE_OCCURRENCE_FLAGS.has(flag) &&
				!CODEX_AUTOMATIC_PERMISSION_FLAGS.has(flag);
			segments.push({
				arguments: requiresNativeCliParsing ? arguments_.slice(index) : [argument],
				overrideKeys: CODEX_AUTOMATIC_PERMISSION_FLAGS.has(argument)
					? ["sandbox", "approval", "approvals-reviewer"]
					: CODEX_SINGLE_OCCURRENCE_FLAGS.has(flag)
						? [`flag:${flag}`]
						: [],
				isPositional: !argument.startsWith("-"),
				selectsConversation: argument === "resume" || argument === "fork" || argument === "--last",
				requiresNativeCliParsing,
			});
			// 未知选项的取值个数也未知；后缀整体不透明，不能再推断覆盖、身份或连接。
			if (requiresNativeCliParsing) break;
		}
	}
	return segments;
}

export function hasExplicitCodexConversationSelectionForRestart(arguments_: readonly string[]): boolean {
	return segmentCodexStartupArguments(arguments_).some((segment) => segment.selectsConversation);
}

// 自动恢复只使用当前观测身份，不能重放旧 resume/fork 目标或启动正文；未知后缀仍交给原生 CLI。
export function removeCodexConversationSelectionAndPromptFromStartupArguments(arguments_: readonly string[]): string[] {
	return segmentCodexStartupArguments(arguments_)
		.filter(
			(segment) =>
				!segment.selectsConversation &&
				!segment.isPositional &&
				!segment.isStartupImageAttachment &&
				segment.arguments[0] !== "--all" &&
				segment.arguments[0] !== "--",
		)
		.flatMap((segment) => segment.arguments);
}

export function hasExplicitCodexRemoteConnectionForRestart(arguments_: readonly string[]): boolean {
	return segmentCodexStartupArguments(arguments_).some((segment) => segment.overrideKeys.includes("remote"));
}

// 无目标的恢复选择器与多值图片无法由受管恢复计划表达；未知选项也须交给原生 CLI。
export function hasCodexStartupArgumentsRequiringNativeCliParsing(arguments_: readonly string[]): boolean {
	const segments = segmentCodexStartupArguments(arguments_);
	if (segments.some((segment) => segment.requiresNativeCliParsing)) return true;
	const subcommandIndex = segments.findIndex(
		(segment) => segment.selectsConversation && segment.arguments[0] !== "--last",
	);
	return (
		subcommandIndex >= 0 &&
		!segments.slice(subcommandIndex + 1).some((segment) => segment.isPositional || segment.arguments[0] === "--last")
	);
}

export function mergeCodexAdditionalStartupArgumentsForRestart(
	defaultArguments: readonly string[],
	additionalArguments: readonly string[],
): string[] {
	if (additionalArguments.length === 0) return [...defaultArguments];
	let defaults = segmentCodexStartupArguments(defaultArguments);
	const additionalSegments = segmentCodexStartupArguments(additionalArguments);
	if (additionalSegments.some((segment) => segment.selectsConversation)) {
		const replacesSubcommand = additionalSegments.some(
			(segment) => segment.selectsConversation && segment.arguments[0] !== "--last",
		);
		let followsConversationSubcommand = false;
		defaults = defaults.filter((segment) => {
			if (segment.arguments[0] === "resume" || segment.arguments[0] === "fork") {
				followsConversationSubcommand = true;
				return !replacesSubcommand;
			}
			if (segment.arguments[0] === "--last" || segment.arguments[0] === "--all") return false;
			return !(followsConversationSubcommand && segment.isPositional);
		});
	}
	const keptAdditionalSegments: CodexStartupArgumentSegment[] = [];
	for (const segment of additionalSegments) {
		const conflicts = (other: CodexStartupArgumentSegment) =>
			other.overrideKeys.some(
				(key) => segment.overrideKeys.includes(key) || key === segment.permissionOverrideKey,
			) ||
			(other.permissionOverrideKey !== undefined && segment.overrideKeys.includes(other.permissionOverrideKey));
		defaults = defaults.filter((other) => !conflicts(other));
		for (let index = keptAdditionalSegments.length - 1; index >= 0; index--)
			if (conflicts(keptAdditionalSegments[index])) keptAdditionalSegments.splice(index, 1);
		keptAdditionalSegments.push(segment);
	}
	return [...defaults, ...keptAdditionalSegments].flatMap((segment) => segment.arguments);
}
