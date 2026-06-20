// 网络中断自动续跑：落盘一份「简短」的续跑指令 markdown，并提供其绝对路径。
//
// 为什么是文件引用而不是长 prompt：网络断开时可能发生多次续跑注入，若每次都注入
// 长文本，会在 agent 上下文里不断累积。因此注入体只引用本文件的绝对路径（恒定、简短），
// 真正的自查 / 恢复步骤放在文件里，由 agent 自行读取。
//
// 文件落在 Kanban 运行目录下的稳定路径（~/.cline/kanban/agent-continuation-instructions/），
// 幂等写入：仅当文件缺失或内容过期时才重写。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const RUNTIME_HOME_PARENT_DIR = ".cline";
const RUNTIME_HOME_DIR = "kanban";
const CONTINUATION_INSTRUCTIONS_DIR = "agent-continuation-instructions";
const NETWORK_INTERRUPTION_RESUME_FILENAME = "network-interruption-resume.md";

// 续跑指令正文。改动这里会触发幂等写入逻辑重写已存在的旧文件。
const NETWORK_INTERRUPTION_RESUME_INSTRUCTIONS = `# 网络中断后的续跑自查

你之前的工作可能因为网络波动（VPN 抖动、连接被中断等）被打断，刚才那条 API / 连接错误就是信号。
在继续任何新工作之前，请先按下面的步骤自查并恢复：

1. **判断上一步是否被打断。** 回顾你最近一次正在进行的操作（编辑文件、运行命令、调用工具、生成回复等），
   判断它是否因为连接中断而**没有真正完成**或**结果不确定**。
2. **若被打断：先恢复，再继续。** 重新执行 / 续做那一步，并确认其结果与你的预期一致
   （例如：文件改动确实写入、命令确实执行成功、没有半截的状态）。确认状态一致后，再继续后续工作。
3. **若其实已经完成：直接继续。** 如果上一步在中断前已经成功完成，不要重复执行，直接继续推进原本的任务。

完成自查后，按原计划继续完成任务，不需要等待进一步指示。
`;

// 注入体：一条**简短且恒定**的行，引用续跑指令文件的绝对路径。刻意保持短小，
// 避免多次续跑注入在 agent 上下文里累积长文本。
export function buildNetworkInterruptionContinuationLine(instructionsPath: string): string {
	return `继续：你上一轮可能被网络中断打断，请先阅读并按 ${instructionsPath} 的步骤自查并恢复，确认状态一致后再继续。`;
}

export function getNetworkInterruptionResumeInstructionsPath(): string {
	return join(
		homedir(),
		RUNTIME_HOME_PARENT_DIR,
		RUNTIME_HOME_DIR,
		CONTINUATION_INSTRUCTIONS_DIR,
		NETWORK_INTERRUPTION_RESUME_FILENAME,
	);
}

let ensurePromise: Promise<string> | null = null;

// 幂等确保续跑指令文件存在且内容为最新，返回其绝对路径。
// 多次并发调用复用同一个 in-flight Promise，避免竞争写入。
export function ensureNetworkInterruptionResumeInstructionsFile(): Promise<string> {
	if (ensurePromise === null) {
		ensurePromise = writeInstructionsFileIfNeeded().catch((error) => {
			// 写入失败不应阻断续跑（注入体仍会引用该路径）；清空缓存以便下次重试。
			ensurePromise = null;
			throw error;
		});
	}
	return ensurePromise;
}

async function writeInstructionsFileIfNeeded(): Promise<string> {
	const filePath = getNetworkInterruptionResumeInstructionsPath();
	let existing: string | null = null;
	try {
		existing = await readFile(filePath, "utf8");
	} catch {
		existing = null;
	}
	if (existing === NETWORK_INTERRUPTION_RESUME_INSTRUCTIONS) {
		return filePath;
	}
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, NETWORK_INTERRUPTION_RESUME_INSTRUCTIONS, "utf8");
	return filePath;
}
