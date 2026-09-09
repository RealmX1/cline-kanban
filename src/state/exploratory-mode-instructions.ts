// Exploratory Mode：落盘一份「探索礼仪 + findings 建议工作流」的指令 markdown，并提供其绝对路径。
//
// 设计蓝图：.plan/docs/exploratory-mode-session-map-and-findings-store.md §A.2 / §D.2.2；会话结构
// 部分已改由独立包 agent-conversation-exploration-thread-graph 的 work-branch 作业自动维护（宿主胶水
// 见 docs/exploratory-mode-host-integration.md）——agent 不再埋 marker、不再手写结构，指令正文只剩
// 「怎么把探索过程说清楚」与「怎么沉淀 finding」。
// 机制镜像 network-interruption-continuation-instructions.ts：Kanban 把自己托管的指令文件
// 稳定落在运行目录下（~/.cline/kanban/agent-exploratory-mode-instructions/），幂等写入
// （仅当文件缺失或内容过期时才重写），exploratory 会话启动时把 agent 指向它。
// 改正文会触发幂等写入重写旧文件。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const RUNTIME_HOME_PARENT_DIR = ".cline";
const RUNTIME_HOME_DIR = "kanban";
const EXPLORATORY_MODE_INSTRUCTIONS_DIR = "agent-exploratory-mode-instructions";
const EXPLORATORY_MODE_INSTRUCTIONS_FILENAME = "exploratory-mode-conversation-etiquette-and-findings.md";

// 指令正文。改动这里会触发幂等写入逻辑重写已存在的旧文件。
const EXPLORATORY_MODE_INSTRUCTIONS = `# Exploratory Mode：探索礼仪与 findings 沉淀

这个会话是一个**探索/研究型任务**：会话过程产出的结构与结论本身就是资产。Kanban 会为这次探索
自动维护一张 **exploration thread graph**（git-graph 语义的会话结构图：thread = 分支，turn = 提交，
话题的分叉 / 回归 / 收口画成分支与合流线）。维护工作由一个从本会话 fork 出的后台分身作业完成——
**你不需要、也不应该手写这张图**：不要在回复里埋任何标记或注释，不要调用写结构的 CLI，不要在
回复里复述结构。

你唯一要做的，是把探索过程**说清楚**：分身读的是与你完全相同的对话，你在对话里怎么表达话题的
分叉与收口，图就长成什么样。

## 一、探索礼仪（决定 thread graph 质量的四件事）

1. **切换话题时明说。** 从当前线索岔开去看别的东西时，用一句话点明：「这里先岔开看一下 X」
   「顺带（by the way）确认一下 Y」「换个方向：Z」。不要在同一段回复里悄悄从 A 滑到 B。
2. **回到先前的线索时点名。** 「回到刚才第 3 轮的存储方案问题」「继续之前中断的 X」。分身据此把
   这一轮接回正确的分支，而不是开一条新线。
3. **收口时明说。** 一条线索有了结论或决定放弃时，用一句话收束：「X 到此有结论：……」「Y 这条线
   先搁置 / 放弃，原因是……」。收口的表达会被画成合流线。
4. **关键结论用一句可独立引用的话写出来。** 每到一个阶段性结论、明确取舍、悬而未决的问题，都用
   一句自足的话收束（分身会把它们标成 milestone / decision_point / open_question 事件）。

宁可措辞直白，不要为了行文流畅把话题切换藏进过渡句。你可能会在 Focus View 侧栏看到这张图；
如果图把你的话题归错了线，说明表达还不够明确——在下一轮直接说清即可，**不要去改图**。

## 二、findings：沉淀结论资产

探索中得到的可复用结论（调查结论、坑与对策、关键事实）可以沉淀为 **finding**——一份带
标题、正文与出处链接的持久资产，独立于会话生命周期存活。你只有**建议权**：经 CLI 提交的
finding 一律落为「待确认」（\`suggested_pending_confirmation\`），由人确认后才生效——不要
替人宣布结论是最终事实，也不要为交差硬凑建议。

### 提交前先查重

\`\`\`bash
kanban exploratory get-findings
#    → { "findings": [ { "findingId": "...", "findingTitle": "...", "findingStatus": "..." } ] }
\`\`\`

同主题已有 finding（任意状态）就不要再提一条近似的；确有新增信息时在正文里写明与既有条目的差别。

### 提交建议

\`\`\`bash
kanban exploratory ingest-finding-candidate --payload @finding.json
\`\`\`

- scope 传参：多数情况下**不用显式传**——Kanban 已通过环境变量注入会话身份（PTY 终端
  agent），CLI 会自动读取。如果你的运行环境没有注入，CLI 会报缺少 \`KANBAN_HOOK_TASK_ID\` /
  \`KANBAN_HOOK_WORKSPACE_ID\`——此时显式传：\`--task\` 用启动提示里给你的任务 id；workspace 用
  \`--project-path\` 指向**主仓路径**（在任务 worktree 里执行 \`git rev-parse --git-common-dir\` 取其
  父目录，一行：\`--project-path "$(dirname "$(git rev-parse --git-common-dir)")"\`）。显式值与
  环境变量不一致会被拒绝（单任务作用域纪律），别混用两个任务的标识。
- \`--payload\` 支持三种形态：内联 JSON 字符串、\`@<文件路径>\`、\`-\`（stdin）。长 JSON 用文件或 stdin。
- payload 形状：

\`\`\`json
{
  "clientProposalId": "<每次建议生成一个 uuid；重试复用同一个>",
  "findingTitle": "≤120 字符的结论标题",
  "findingBodyMarkdown": "≤4000 字符的正文（markdown）",
  "provenanceLinks": [
    {
      "linkKind": "turn_anchor",
      "conversationSessionTaskId": "<来源会话的任务 id，通常就是本会话>",
      "turnNumber": 3,
      "turnCheckpointCommit": null
    }
  ]
}
\`\`\`

- \`provenanceLinks\` 至少一条、至多 8 条。\`turn_anchor\` 链接三元要真实：\`turnNumber\` 必填
  （\`null\` 会被 schema 直接拒收），且超过该会话最新轮次会被整份拒绝；\`turnCheckpointCommit\`
  不知道就填 \`null\`（仅时间锚），填了但不可解析会被降级为 \`null\`，不会拒绝。指不出具体
  轮次时用 \`session_level\`（\`turnNumber\` 与 \`turnCheckpointCommit\` 必须都填 \`null\`，
  挂了值同样被 schema 拒收），不要伪造锚。
- 提交成功返回 \`ingested:true\`，\`finding.findingId\` 是服务端派生的稳定 id
  （\`agent-<clientProposalId>\`）——重试用同一个 \`clientProposalId\` 不会落地两条。
- 返回 \`ingested:false\` 时按 \`rejectionReason\` 处理：\`anchor_turn_number_unresolvable\`
  （锚到不存在的轮次）→ 修正后重提；\`provenance_conversation_session_unresolvable\`
  （出处会话不存在）→ 修正 \`conversationSessionTaskId\` 后重提；
  \`findings_cap_overflow\`（findings 达每 workspace 上限且被待确认建议占满）→ 停止再提
  新建议，提醒用户先去确认/拒绝既有待确认建议腾位。
- 人**拒绝**一条建议后它会被删除；重要结论请在对话正文里保持自足，不要只存在于 finding 里。
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
