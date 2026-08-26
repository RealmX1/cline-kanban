// Exploratory Mode：落盘一份「会话导航锚约定」的指令 markdown，并提供其绝对路径。
//
// 设计蓝图：.plan/docs/exploratory-mode-session-map-and-findings-store.md §A.2 / §C.1。
// 机制镜像 network-interruption-continuation-instructions.ts：Kanban 把自己托管的指令文件
// 稳定落在运行目录下（~/.cline/kanban/agent-exploratory-mode-instructions/），幂等写入
// （仅当文件缺失或内容过期时才重写），exploratory 会话启动时把 agent 指向它。
//
// M0 范围：只含 marker 格式约定与埋锚纪律（§C.1）。agent 写回协议（§B.2 的
// `kanban exploratory` CLI）随 M1 落地——届时扩充正文，幂等写入会自动重写旧文件。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const RUNTIME_HOME_PARENT_DIR = ".cline";
const RUNTIME_HOME_DIR = "kanban";
const EXPLORATORY_MODE_INSTRUCTIONS_DIR = "agent-exploratory-mode-instructions";
const EXPLORATORY_MODE_INSTRUCTIONS_FILENAME = "exploratory-mode-session-map.md";

// 指令正文。改动这里会触发幂等写入逻辑重写已存在的旧文件（M1 扩充写回协议段落即走此路径）。
const EXPLORATORY_MODE_INSTRUCTIONS = `# Exploratory Mode：会话导航锚（session map anchor）约定

这个会话是一个**探索/研究型任务**：会话过程产出的结构与结论本身就是资产。Kanban 会为这次会话
维护一份「session map」——一张可点击导航的会话结构图。你的职责之一是在对话推进中**埋设导航锚**。

## 锚标记格式

在你自己的助手消息正文里，用**行内 HTML 注释**埋锚，独占一行、前后各留一个空行（独立成块，
不要贴在段落/表格/列表/代码块行间）：

    <!-- kanban:map-anchor <mapNodeId> -->

- \`<mapNodeId>\` 只是节点的标识符，**不要在标记里携带任何标题、正文或其他文本**——锚的显示
  内容恒由 Kanban 从 session map store 按 id 查询渲染，标记内嵌的内容永远不会被渲染。
- 标记对不支持的渲染器天然不可见（HTML 注释），所以它可以安全地留在转录里，被复制、被旧版本
  UI 渲染都不会出现垃圾文本。

## 何时埋锚（维护节律）

只在对话的**结构性节点**埋锚，宁缺毋滥：

- **milestone**：达成了一个阶段性结论或突破。
- **decision_point**：做了明确的取舍（选定方案 A、放弃方案 B）。
- **open_question**：浮现了一个悬而未决、值得回头的问题。
- **digression**：有意识地岔开主线去探索支线。
- **finding_reference**：这里产出了一条值得沉淀的 finding。

不要在每个回合都埋锚。一张好的 session map 应该让人 10 秒钟看清这次探索的骨架。

## 埋锚与节点登记成对

锚标记是 session map 节点的**指针**：marker 里的 id 必须对应 map 里真实存在的节点，未配对的
marker 不会被渲染成导航元素。节点写回通道随 Kanban 的 exploratory 写入协议提供。
`;

export function getExploratoryModeInstructionsPath(): string {
	return join(
		homedir(),
		RUNTIME_HOME_PARENT_DIR,
		RUNTIME_HOME_DIR,
		EXPLORATORY_MODE_INSTRUCTIONS_DIR,
		EXPLORATORY_MODE_INSTRUCTIONS_FILENAME,
	);
}

let ensurePromise: Promise<string> | null = null;

// 幂等确保指令文件存在且内容为最新，返回其绝对路径。
// 多次并发调用复用同一个 in-flight Promise，避免竞争写入。
export function ensureExploratoryModeInstructionsFile(): Promise<string> {
	if (ensurePromise === null) {
		ensurePromise = writeInstructionsFileIfNeeded().catch((error) => {
			// 写入失败不应阻断会话启动；清空缓存以便下次重试。
			ensurePromise = null;
			throw error;
		});
	}
	return ensurePromise;
}

async function writeInstructionsFileIfNeeded(): Promise<string> {
	const filePath = getExploratoryModeInstructionsPath();
	let existing: string | null = null;
	try {
		existing = await readFile(filePath, "utf8");
	} catch {
		existing = null;
	}
	if (existing === EXPLORATORY_MODE_INSTRUCTIONS) {
		return filePath;
	}
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, EXPLORATORY_MODE_INSTRUCTIONS, "utf8");
	return filePath;
}
