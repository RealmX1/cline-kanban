// 命令行文本落盘前的截断与脱敏——资源占用采集里所有「命令文本」进 journal 前的唯一出口。
//
// 两条来源共用本模块：
//   - ps 读到的进程 argv（agent 跑的命令里可能内联 token）；
//   - hooks CLI 从 PreToolUse/PostToolUse 的 `tool_input.command` 取到的 Bash 命令。
//
// 命令的粒度是用户选定的「截断全文 + 常见密钥脱敏」：保留能看出「具体跑了哪个测试 / 哪个构建目标」的分辨率，
// 代价是正则脱敏总有漏网——所以顺序固定为**先脱敏、再截断**：截断点落在一个 secret 中间时，先截断会
// 让它的可见半截逃过整段匹配的正则。
//
// agent harness 自身的进程（根进程、嵌套 harness、包装脚本 re-exec 出来的真正 harness，以及 Kanban 重启后经 env
// 找回的孤儿 harness 与它 re-exec 出的子进程）不走这条：它们的 argv 装着 task prompt / 注入的系统提示词，只能记
// 可执行文件名 + 参数字符数，见 summarizeAgentHarnessProcessCommandLineWithAllArgumentsElided。

export const PROCESS_COMMAND_LINE_TEXT_MAXIMUM_JOURNALED_CHARACTER_COUNT = 240;

const REDACTED_SECRET_PLACEHOLDER = "[REDACTED]";

// EXPERIMENT_NODE: 脱敏正则集合——当前覆盖「形态可识别」的常见密钥；是否需要按真实 journal 漏网样本扩充，待积累数据后评估。
const SECRET_SHAPED_SUBSTRING_REDACTION_RULES: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
	// URL userinfo：scheme://user:password@host
	{ pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:'"]+:[^\s/@'"]+@/gi, replacement: `$1${REDACTED_SECRET_PLACEHOLDER}@` },
	// URL 查询参数里的凭据。必须先于下面的环境变量赋值规则：`?access_token=` 也长得像赋值。
	{
		pattern: /([?&](?:access_token|token|api_key|apikey|key|secret|password|client_secret|auth)=)[^&\s'"]+/gi,
		replacement: `$1${REDACTED_SECRET_PLACEHOLDER}`,
	},
	// HTTP Bearer 头。
	{ pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, replacement: `$1${REDACTED_SECRET_PLACEHOLDER}` },
	// 显式的凭据类 CLI 参数：`--password=x`、`--api-key x`、`--with-token x`。
	{
		pattern:
			/(--(?:token|password|passwd|secret|api-key|apikey|access-key|with-token|auth-token|client-secret)(?:\s+|=))(?:'[^']*'|"[^"]*"|[^\s'"]+)/gi,
		replacement: `$1${REDACTED_SECRET_PLACEHOLDER}`,
	},
	// 行内环境变量赋值：名字里带 TOKEN / SECRET / PASSWORD / API_KEY 等。只认「词首」的赋值，
	// 避免把 URL 参数、`--flag=` 之类的片段当成赋值再吞掉后面的内容。
	{
		pattern:
			/(^|[\s;&|(])([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL)[A-Za-z0-9_]*=)(?:'[^']*'|"[^"]*"|[^\s;&|)]+)/gi,
		replacement: `$1$2${REDACTED_SECRET_PLACEHOLDER}`,
	},
	// 前缀可识别的厂商 token。
	{
		pattern:
			/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16}|glpat-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{30,})/g,
		replacement: REDACTED_SECRET_PLACEHOLDER,
	},
];

export function redactSecretShapedSubstringsInCommandLineText(commandLineText: string): string {
	let redactedCommandLineText = commandLineText;
	for (const { pattern, replacement } of SECRET_SHAPED_SUBSTRING_REDACTION_RULES) {
		redactedCommandLineText = redactedCommandLineText.replace(pattern, replacement);
	}
	return redactedCommandLineText;
}

export interface ProcessCommandLineDiagnosticJournalSummary {
	commandLineTextForJournal: string;
	originalCommandLineCharacterCount: number;
	commandLineTextWasTruncated: boolean;
}

// ps 把 argv 里的换行 / 制表显示成八进制转义（`\012`、`\011`）。
function decodePsOctalEscapes(commandLineText: string): string {
	return commandLineText.replace(/\\(0[0-7]{2})/g, (_escape, octalDigits: string) =>
		String.fromCharCode(Number.parseInt(octalDigits, 8)),
	);
}

// 命令文本里内联的 harness 系统提示词（如 agent 用 Bash 跑 `claude -p --append-system-prompt …`）对资源
// 分析毫无用处，却会占满截断预算：整段省略，只留字符数。即便后面还有别的参数，也一并省略（截断本来也会
// 丢掉它们）。这只是命令文本的尽力而为；harness 进程自己的 argv 走下面「参数全部省略」那条，不依赖认 flag。
const HARNESS_SYSTEM_PROMPT_ARGUMENT_PATTERN = /(--(?:append-system-prompt|system-prompt))(?:\s+|=)([\s\S]+)$/;

function elideHarnessSystemPromptArgumentValue(commandLineText: string): string {
	return commandLineText.replace(
		HARNESS_SYSTEM_PROMPT_ARGUMENT_PATTERN,
		(_match, flag: string, systemPromptText: string) => `${flag} [系统提示词已省略 ${systemPromptText.length} 字符]`,
	);
}

export function summarizeProcessCommandLineForDiagnosticJournal(
	commandLineText: string,
): ProcessCommandLineDiagnosticJournalSummary {
	const readableCommandLineText = elideHarnessSystemPromptArgumentValue(decodePsOctalEscapes(commandLineText));
	// 一条 journal 记录必须是一行：多行 heredoc 命令折成单行，空白串压成一个空格。
	const singleLineCommandLineText = readableCommandLineText.replace(/\s+/g, " ").trim();
	const redactedCommandLineText = redactSecretShapedSubstringsInCommandLineText(singleLineCommandLineText);
	const commandLineTextWasTruncated =
		redactedCommandLineText.length > PROCESS_COMMAND_LINE_TEXT_MAXIMUM_JOURNALED_CHARACTER_COUNT;
	return {
		commandLineTextForJournal: commandLineTextWasTruncated
			? `${redactedCommandLineText.slice(0, PROCESS_COMMAND_LINE_TEXT_MAXIMUM_JOURNALED_CHARACTER_COUNT - 1)}…`
			: redactedCommandLineText,
		originalCommandLineCharacterCount: commandLineText.length,
		commandLineTextWasTruncated,
	};
}

// agent harness 进程的 argv：各家放 task prompt / 系统提示词的位置互不相同——Claude / Droid 用
// `--append-system-prompt`，Codex 用 `-c developer_instructions=…`，OpenCode 用 `--prompt`，Gemini 用 `-i`，
// Claude / Codex / Cursor / omp 还把 task prompt 作为最后一个位置参数。逐个认 flag 永远追不上新接入的 harness，
// 所以参数一个字符都不落盘：只记可执行文件名（不含目录）与参数的字符数。agentId 另有字段，足够认出是谁。
export function summarizeAgentHarnessProcessCommandLineWithAllArgumentsElided(
	commandLineText: string,
): ProcessCommandLineDiagnosticJournalSummary {
	const trimmedCommandLineText = commandLineText.trim();
	const executableToken = /^\S*/.exec(trimmedCommandLineText)?.[0] ?? "";
	const executableBasename = executableToken.slice(executableToken.lastIndexOf("/") + 1);
	const elidedArgumentCharacterCount = trimmedCommandLineText.slice(executableToken.length).trim().length;
	return {
		commandLineTextForJournal:
			elidedArgumentCharacterCount > 0
				? `${executableBasename} [harness 参数已省略 ${elidedArgumentCharacterCount} 字符]`
				: executableBasename,
		originalCommandLineCharacterCount: commandLineText.length,
		commandLineTextWasTruncated: elidedArgumentCharacterCount > 0,
	};
}

// Claude Code 的 Bash 工具把命令包进一个固定外壳：
//   /bin/zsh -c source <shell-snapshot> … && eval '<命令>' < /dev/null && pwd -P >| /tmp/claude-…-cwd
// 命令里的单引号被写成 `'"'"'`，换行在 ps 里显示为八进制转义 `\012`。
const CLAUDE_CODE_SHELL_TOOL_WRAPPER_EVAL_ARGUMENT_PATTERN =
	/\beval '((?:[^']|'"'"')*)'(?:\s*<\s*\/dev\/null)?(?:\s*&&\s*pwd -P\b[\s\S]*)?$/;
// 其余 harness（Codex 等）通常直接 `<shell> -c|-lc <命令>`。
const PLAIN_SHELL_DASH_C_INVOCATION_PATTERN = /^(?:\S*\/)?(?:sh|bash|zsh|dash|fish)\s+-l?c\s+([\s\S]+)$/;

function decodeShellWrapperEscapes(wrappedCommandText: string): string {
	return decodePsOctalEscapes(wrappedCommandText.replaceAll(`'"'"'`, "'"));
}

// 取回「agent 实际要求执行的那条命令」，而不是外壳。认不出是 shell 外壳时返回 null。
export function extractAgentShellToolInnerCommandFromWrapperCommandLine(commandLine: string): string | null {
	if (commandLine.includes("shell-snapshots/")) {
		const claudeWrapperMatch = CLAUDE_CODE_SHELL_TOOL_WRAPPER_EVAL_ARGUMENT_PATTERN.exec(commandLine);
		if (claudeWrapperMatch?.[1] !== undefined) {
			return decodeShellWrapperEscapes(claudeWrapperMatch[1]);
		}
	}
	const plainShellMatch = PLAIN_SHELL_DASH_C_INVOCATION_PATTERN.exec(commandLine);
	if (plainShellMatch?.[1] !== undefined) {
		return decodeShellWrapperEscapes(plainShellMatch[1]);
	}
	return null;
}
