// 启动参数快照（fork 重放用）。exploration thread graph 的维护作业要从主会话 fork 一个分身
// （`claude -p --resume <nativeSessionId> --fork-session`），本模块在会话启动那一刻把分身要逐字复用的
// argv 三项摘下来存进 summary sidecar。
//
// 为什么必须在启动时快照、而不能在作业触发时重算：唯一可靠的真相是「启动那一刻真正传出去的 argv」。
// `--append-system-prompt` 的文案是仓库代码的一部分，会随版本变化（exploratory 那段刚刚就改过一次），
// 一个旧版本启动、至今还活着的会话，用新版本代码重算出来的值与它实际在跑的那份根本不是一回事——而重算
// 的错误完全静默，分身照常跑出结果，只是跑在了错误的前提上。
//
// **关于 prompt cache 的事实修正**（2026-09-09 核心包 Pass A 实测，记在这里免得后人再推一遍）：本模块
// 最初的立论是「三项逐字一致 ⇒ fork 命中主会话 prompt cache」，实测把它证伪了两处 ——（a）`--resume`
// 时 `--append-system-prompt` 根本不参与请求（差一字节、乃至完全不传，都照样 100% 命中）；（b）Claude
// Code 的 `--fork-session` 在真实 Kanban 会话上**恒不命中**父会话 cache，成因是上游 open bug
// anthropics/claude-code#77306：fork 会铸造新 session id，而 session id 被嵌在 system prompt 的 scratchpad
// 路径里，前缀在 system 层就已经字节不一致（实测 446k 的 opus 会话 fork 一次 cache read = 0、$4.46）。
// 规则本身不变，因为它的承重理由不止 cache：model 必须逐字一致，分身才跑在同一个模型上；settings 路径
// 决定分身的 hook 行为；而 #77306 一旦修好，字节一致性的前提立刻恢复——届时不必回头补建快照。
//
// model 一律保留 **argv 里的字面值**（通常是浮动别名 `default`），绝不存解析后的具体模型 id：别名的含义
// 由 Claude Code 在运行时解析且随上游换代漂移，固化解析结果会让 fork 在换代后用错模型（另见 AGENTS.md
// 的浮动 ref 规则，以及 agent-session-adapters.ts 里 `--model default` 那段注释记录的 1M→200k 事故）。

// v1 只覆盖 Claude Code：它是 exploration thread graph 的第一 harness，也是唯一已核实 fork 语义的 harness。
// 其余 agent 返回 null（不写 sidecar），等各自的 fork 执行器落地后再逐个接入。
const AGENT_IDS_WITH_FORK_REPLAY_LAUNCH_ARGUMENT_CAPTURE = new Set<string>(["claude"]);

export interface AgentSessionForkReplayLaunchArguments {
	// 哪个 harness 的参数（与 summary 其余 agent 字段同一口径）。
	sourceAgentId: string;
	// argv 里 `--model` / `-m` 的字面值；未显式传则为 null。
	modelArgumentLiteral: string | null;
	// `--append-system-prompt` 的全文，逐字保留（含换行与内部空白）。
	appendSystemPromptText: string | null;
	// `--settings` 指向的 settings.json 路径（决定分身继承同一份 hooks 配置）。
	settingsFilePath: string | null;
	capturedAt: number;
}

// 快照要摘的三个选项各自的落点字段。
type ForkReplayCapturedLaunchArgumentField = "modelArgumentLiteral" | "appendSystemPromptText" | "settingsFilePath";

type ForkReplayCapturedLaunchArgumentValues = Record<ForkReplayCapturedLaunchArgumentField, string | null>;

interface ForkReplayCliOptionWithRequiredValueSpec {
	readonly capturedField: ForkReplayCapturedLaunchArgumentField;
	// 同一语义的选项别名（Claude Code 的 model 既可写 `--model` 也可写 `-m`）。
	readonly optionNames: readonly string[];
}

// 这三个在 Claude CLI 里都是**必须带值**的选项：紧跟其后的那个 token 无条件就是它的值。
const FORK_REPLAY_CLI_OPTIONS_WITH_REQUIRED_VALUE: readonly ForkReplayCliOptionWithRequiredValueSpec[] = [
	{ capturedField: "modelArgumentLiteral", optionNames: ["--model", "-m"] },
	{ capturedField: "appendSystemPromptText", optionNames: ["--append-system-prompt"] },
	{ capturedField: "settingsFilePath", optionNames: ["--settings"] },
];

interface ForkReplayCliOptionTokenMatch {
	readonly capturedField: ForkReplayCapturedLaunchArgumentField;
	// 等号式（`--model=default`）已经自带值；分离式（`--model default`）为 null，值要从下一个 token 取。
	readonly inlineValueFromEqualsForm: string | null;
}

function matchForkReplayCliOptionToken(argument: string): ForkReplayCliOptionTokenMatch | null {
	for (const optionSpec of FORK_REPLAY_CLI_OPTIONS_WITH_REQUIRED_VALUE) {
		for (const optionName of optionSpec.optionNames) {
			if (argument === optionName) {
				return { capturedField: optionSpec.capturedField, inlineValueFromEqualsForm: null };
			}
			if (argument.startsWith(`${optionName}=`)) {
				return {
					capturedField: optionSpec.capturedField,
					inlineValueFromEqualsForm: argument.slice(optionName.length + 1),
				};
			}
		}
	}
	return null;
}

// 一次扫完 argv，把三个选项各自**最后一次**出现的值读出来：adapter 会先 push 再由后续分支覆盖，
// 最后一个才是真正生效的那个。分离式与等号式两种写法都收。
//
// 分离式一律**无条件**把下一个 token 当作值——值的形状说明不了任何事：以 `-` 开头的 append-system-prompt
// 正文（比如以 markdown 列表起头的 `- Be concise`）完全合法，早先按「首字符是 -」判边界会把整段 prompt
// 判成无值丢成 null，分身就拿不到主会话实际在跑的那段 prompt——而完整保住这三项正是本模块存在的唯一理由。
// 只有选项落在 argv 末尾、确实没有后继 token 时，这次出现才算无值。
//
// 被消费掉的值 token 连同跳过，不再参与后续的选项匹配：否则一段形似 `--model=opus …` 的 prompt 正文
// 会在下一轮循环里被当成 model 选项，污染 modelArgumentLiteral。
function readForkReplayCliOptionValues(launchArguments: readonly string[]): ForkReplayCapturedLaunchArgumentValues {
	const capturedValues: ForkReplayCapturedLaunchArgumentValues = {
		modelArgumentLiteral: null,
		appendSystemPromptText: null,
		settingsFilePath: null,
	};
	for (let index = 0; index < launchArguments.length; index += 1) {
		const argument = launchArguments[index];
		if (argument === undefined) {
			continue;
		}
		const optionMatch = matchForkReplayCliOptionToken(argument);
		if (optionMatch === null) {
			continue;
		}
		if (optionMatch.inlineValueFromEqualsForm !== null) {
			capturedValues[optionMatch.capturedField] = optionMatch.inlineValueFromEqualsForm;
			continue;
		}
		const separatedFormValue = launchArguments[index + 1];
		if (separatedFormValue === undefined) {
			// 选项就在 argv 末尾、没有后继 token ⇒ 这次出现无值，不覆盖已读到的。
			continue;
		}
		capturedValues[optionMatch.capturedField] = separatedFormValue;
		index += 1;
	}
	return capturedValues;
}

// 快照本次启动 argv 里与 fork 重放相关的三项。三项全缺 ⇒ 返回 null（没有值得记的东西，不写 sidecar）。
export function captureAgentSessionForkReplayLaunchArguments(input: {
	agentId: string;
	launchArguments: readonly string[];
	capturedAt: number;
}): AgentSessionForkReplayLaunchArguments | null {
	if (!AGENT_IDS_WITH_FORK_REPLAY_LAUNCH_ARGUMENT_CAPTURE.has(input.agentId)) {
		return null;
	}
	const { modelArgumentLiteral, appendSystemPromptText, settingsFilePath } = readForkReplayCliOptionValues(
		input.launchArguments,
	);
	if (modelArgumentLiteral === null && appendSystemPromptText === null && settingsFilePath === null) {
		return null;
	}
	return {
		sourceAgentId: input.agentId,
		modelArgumentLiteral,
		appendSystemPromptText,
		settingsFilePath,
		capturedAt: input.capturedAt,
	};
}

// 值相等判定：只有真变了才写 summary（与 N0a 身份 sidecar 同一纪律，避免每次心跳都触发广播）。
export function isSameAgentSessionForkReplayLaunchArguments(
	left: AgentSessionForkReplayLaunchArguments | null | undefined,
	right: AgentSessionForkReplayLaunchArguments | null | undefined,
): boolean {
	if (!left || !right) {
		return left === right || (!left && !right);
	}
	return (
		left.sourceAgentId === right.sourceAgentId &&
		left.modelArgumentLiteral === right.modelArgumentLiteral &&
		left.appendSystemPromptText === right.appendSystemPromptText &&
		left.settingsFilePath === right.settingsFilePath
	);
}
