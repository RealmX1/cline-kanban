// Exploratory Mode：落盘一份「会话导航锚约定 + session map 写回协议」的指令 markdown，并提供其绝对路径。
//
// 设计蓝图：.plan/docs/exploratory-mode-session-map-and-findings-store.md §A.2 / §B.2 / §C.1。
// 机制镜像 network-interruption-continuation-instructions.ts：Kanban 把自己托管的指令文件
// 稳定落在运行目录下（~/.cline/kanban/agent-exploratory-mode-instructions/），幂等写入
// （仅当文件缺失或内容过期时才重写），exploratory 会话启动时把 agent 指向它。
//
// 内容覆盖：marker 格式约定与埋锚纪律（§C.1）+ map 写回读-改-写协议（§B.2 的
// `kanban exploratory` CLI）+ 维护节律 + findings 建议/引用工作流（§D.2.2，M2）。
// 改正文会触发幂等写入重写旧文件。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const RUNTIME_HOME_PARENT_DIR = ".cline";
const RUNTIME_HOME_DIR = "kanban";
const EXPLORATORY_MODE_INSTRUCTIONS_DIR = "agent-exploratory-mode-instructions";
const EXPLORATORY_MODE_INSTRUCTIONS_FILENAME = "exploratory-mode-session-map.md";

// 指令正文。改动这里会触发幂等写入逻辑重写已存在的旧文件。
const EXPLORATORY_MODE_INSTRUCTIONS = `# Exploratory Mode：session map 导航锚与写回协议

这个会话是一个**探索/研究型任务**：会话过程产出的结构与结论本身就是资产。Kanban 会为这次会话
维护一份「session map」——一张可点击导航的会话结构图。你的职责之一是**在对话推进中埋设导航锚，
并把锚对应的节点写回 map**。

## 一、锚标记格式

在你自己的助手消息正文里，用**行内 HTML 注释**埋锚，独占一行、前后各留一个空行（独立成块，
不要贴在段落/表格/列表/代码块行间）：

    <!-- kanban:map-anchor <mapNodeId> -->

- \`<mapNodeId>\` 只是节点的标识符，**不要在标记里携带任何标题、正文或其他文本**——锚的显示
  内容恒由 Kanban 从 session map store 按 id 查询渲染，标记内嵌的内容永远不会被渲染。
- 标记对不支持的渲染器天然不可见（HTML 注释），所以它可以安全地留在转录里，被复制、被旧版本
  UI 渲染都不会出现垃圾文本。

## 二、节点 id 派生约定

map 节点的稳定 id 由 Kanban 按规则派生（不是自由命名）：

    turn-<anchorTurnNumber>-<nodeKind>

例如第 3 个用户轮次的一处里程碑：\`turn-3-milestone\`。marker 里的 id 必须与写回节点的 id 完全一致，
未配对的 marker 不会被渲染成导航元素。同一轮次同一种类只会有一个节点（重复提交幂等归并）。

\`<nodeKind>\` 取其一：\`milestone\`（阶段性结论/到达点）、\`decision_point\`（做了取舍的位置）、
\`open_question\`（悬而未决的问题）、\`digression\`（有意识的岔路/支线）、\`finding_reference\`
（该锚点产出了一条 finding——\`referencedFindingId\` 必填，工作流见第五节）。

## 三、写回协议（读-改-写）

map 的写入走 Kanban CLI，**整份提案**（不是增量）：先读现状，在本地改成目标态，再整份提交。

\`\`\`bash
# 1. 读：拿到当前节点集合 + 投影签名 + 最新轮次
kanban exploratory get-session-map
#    → { "mapCollection": ..., "harnessSource": ..., "turnProjectionSignature": "...",
#        "latestTurnNumber": N }

# 2. 改：在拿到的节点集合上编辑成你的目标态（新增/修改/删除节点）

# 3. 写：整份提交
kanban exploratory ingest-map-update --payload @payload.json
\`\`\`

- scope 传参：多数情况下**不用显式传**——Kanban 已通过环境变量注入会话身份（PTY 终端
  agent），CLI 会自动读取。如果你的运行环境没有注入（例如 Cline 会话），CLI 会报缺少
  \`KANBAN_HOOK_TASK_ID\` / \`KANBAN_HOOK_WORKSPACE_ID\`——此时显式传：\`--task\` 用启动提示
  里给你的任务 id；workspace 用 \`--project-path\` 指向**主仓路径**（在任务 worktree 里执行
  \`git rev-parse --git-common-dir\` 取其父目录，一行：
  \`--project-path "$(dirname "$(git rev-parse --git-common-dir)")"\`）。显式值与环境变量
  不一致会被拒绝（单任务作用域纪律），别混用两个任务的标识。
- \`--payload\` 支持三种形态：内联 JSON 字符串、\`@<文件路径>\`、\`-\`（stdin）。长 JSON 用文件或 stdin。
- payload 形状：

\`\`\`json
{
  "clientProposalId": "<每次提案生成一个 uuid；重试复用同一个>",
  "sourceTurnProjectionSignature": "<第 1 步读到的签名，原样带回>",
  "nodes": [
    {
      "anchorTurnNumber": 3,
      "anchorTurnCheckpointCommit": null,
      "nodeKind": "milestone",
      "nodeTitle": "≤80 字符的节点标题",
      "nodeSummaryMarkdown": "≤400 字符的摘要，可为 null",
      "referencedFindingId": null
    }
  ]
}
\`\`\`

- \`anchorTurnNumber\` 不能超过第 1 步读到的 \`latestTurnNumber\`（锚不存在的轮次 = 整份拒绝）。
- \`anchorTurnCheckpointCommit\` 不知道就填 \`null\`（仅时间锚）；填了但已不可解析会被降级为
  \`null\` 并把 map 标记为落后，不会拒绝。
- 现有集合里 \`nodeGenerationSource\` 为 \`user_manual_edit\` 的节点是用户手动修正——**必须原样
  带回**（缺漏或改写 = 整份拒绝）。其余节点你可以自由增改删。
- \`clientProposalId\` 是幂等键：网络重试用同一个 id 不会落地两次；新提案必须换新 id。
- 返回 \`applied:false\` 时按 \`rejectionReason\` 处理：\`stale_source_turn_projection_signature\`
  （签名已旧）→ 重新从第 1 步开始；\`anchor_turn_number_unresolvable\`（锚到不存在的轮次）→
  修正后重提；\`user_manual_edit_conflict\` → 把用户节点原样补回再重提；
  \`referenced_finding_unresolvable\` → \`finding_reference\` 节点引用的 finding 不存在，
  先经第五节工作流确认 findingId 再重提；
  \`projection_source_unavailable\` → 本会话类型不支持写 map，停止尝试。

## 四、维护节律（何时埋锚、何时写回）

只在对话的**结构性节点**埋锚，宁缺毋滥：

- **milestone**：达成了一个阶段性结论或突破。
- **decision_point**：做了明确的取舍（选定方案 A、放弃方案 B）。
- **open_question**：浮现了一个悬而未决、值得回头的问题。
- **digression**：有意识地岔开主线去探索支线。

- 埋锚与节点登记**成对出现**：埋了锚的轮次必须在同一次写回里登记对应节点（id 相同）。
- **回合收尾时同步 map**：一段有结构的探索结束时，跑一次上面的读-改-写，把新锚点登记入图。
  不要在每个回合都写回。
- 你可能收到一条 \`[Kanban] Session map 已落后于本会话\` 的提醒消息——按第三节协议重跑即可；
  如果这段会话没有值得登记的结构节点，回复确认即可，**不要为交差硬造锚点**。
- 一张好的 session map 应该让人 10 秒钟看清这次探索的骨架。

## 五、findings：沉淀结论资产

探索中得到的可复用结论（调查结论、坑与对策、关键事实）可以沉淀为 **finding**——一份带
标题、正文与出处链接的持久资产，独立于会话生命周期存活。你只有**建议权**：经 CLI 提交的
finding 一律落为「待确认」（\`suggested_pending_confirmation\`），由人确认后才生效——不要
替人宣布结论是最终事实，也不要为交差硬凑建议。

### 提交建议

\`\`\`bash
kanban exploratory ingest-finding-candidate --payload @finding.json
\`\`\`

payload 形状（scope 传参与第三节相同）：

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

### 从 map 节点引用 finding

\`finding_reference\` 节点的 \`referencedFindingId\` 必须引用**已存在**的 finding——否则整份
map 提案被拒（\`referenced_finding_unresolvable\`）。引用前先列出现有 finding：

\`\`\`bash
kanban exploratory get-findings
#    → { "findings": [ { "findingId": "...", "findingTitle": "...", "findingStatus": "..." } ] }
\`\`\`

- 你刚提交的建议（\`findingStatus\` 为 \`suggested_pending_confirmation\`）也可以被引用；但请
  注意：人**拒绝**该建议后它会被删除，map 节点上的引用随之悬空（UI 会容错展示，不炸）——
  重要结论请在节点摘要里保持自足。
- 已 \`archived\` 的 finding 仍可被引用（map 是历史叙事，归档不抹除历史）。
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
