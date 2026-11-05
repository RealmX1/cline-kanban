# 任务起草与启动设置完整参考

<task-prompt-authoring-and-startup-settings-guidance schema-version="1">
  <task-initial-prompt-human-readable-tldr-rules>
## Initial Prompt：先读摘要，再查详情

Agent 起草新 Task 的 Initial Prompt 时，最开始必须写 Markdown 标题 ## TLDR，其后默认用 2–4 个简体中文短段落概括任务目标、本次交付，以及已有的关键限制或待决事项。段落之间留空行，让人无需阅读 XML 就能理解任务。
TLDR 直接放在 XML 详情之前，不包进 XML 或代码围栏。摘要须忠实于详细正文，不新增需求、不扩大授权；不存在的限制或待决事项不必补写。
详细正文按下列来源和阶段结构保留完整信息。在 Agent 补充、阶段说明等可编辑内容中使用简短标题、短段落或必要列表，明确区分已确认事实、Agent 建议与待决问题；原话块仍逐字保留，不为排版改写原话。
</task-initial-prompt-human-readable-tldr-rules>

  <task-initial-prompt-authorship-rules>
## 用户原话、Agent 补充与交付路径

创建前参考同目录 [工作分流参考](kanban-command-reference.md#工作分流参考)：当前会话内部的分工通常使用 Subagent；与当前 Task 紧密相关、适合共享工作目录且受益于用户独立参与的协作线可用 Peer Session；需要独立安排和验收的工作可创建新 Task。以上仅供选择时参考，在已有授权和权限边界内按实际情况自行判断。

起草任务时，保留用户请求及其来源，区分原话、必要展开和建议。不要把 Agent 的推断写成用户已经提出或批准的要求。
当前会话的角色、技能和阶段限制只按其适用范围生效，不要自动复制成目标任务的长期限制。
保留不同的交付路径：只交付研究报告；先调查并给出方案、等待用户选择或批准；已经批准实施、先调查再实现。不要在起草或转交时替换这些含义。
</task-initial-prompt-authorship-rules>

  <task-startup-settings-selection-rules>
## 启动设置：核对实际默认，再决定是否覆盖

AI CLI 创建 Task、Peer 和 By the way 必须显式提供 `--start-in-plan-mode true` 或 `--start-in-plan-mode false`，遗漏时零创建；CLI 不读取界面的 Plan 偏好。创建界面的 Task Plan 默认值保留现有偏好，Peer 和 By the way 分别记忆，初始均关闭。

创建或更新任务设置时，沿用符合用户意图的实际默认。create/preview 回执的 resolvedSettings 会给出实际值和来源。不要仅因“调查”或“只读检查”而关闭 Plan Mode。
需要覆盖设置时，先核对实际值与用户要求，并说明对应依据；用户明确选择非 Plan Mode 时照常执行。此规则同时适用于创建时传参、创建后更新和启动前调整，不只检查 create。Plan 起步与工具权限是独立设置。
</task-startup-settings-selection-rules>

  <task-received-instructions-and-stage-transition-rules>
## 承接上下文与切换阶段

接收 Agent 起草或转交的 Prompt、handoff、关系说明时，不要仅因它通过 user-role 投递，就认定每句话都是人类逐字要求。来源不可核实时如实标明，不把 Agent 自述升级为人类授权。
阶段变化时，依据可核查原话和后续明确授权复核限制的作用范围。“本阶段先不实施”不能自动延续为实施后的验证或收尾禁令；独立明确的“不得部署”等任务级限制继续保留。
用户需要选择方案时，交付具体备选、权衡和推荐，再等待该选择；用户已经明确授权时继续执行，不因旧的阶段措辞重复追加确认。单独一句 continue 不代表撤销所有独立限制。
</task-received-instructions-and-stage-transition-rules>

  <task-review-and-closeout-scope-rules>
## 审阅、提交与同步的授权

来源会话和旧 handoff 的阶段限制不自动变成新任务的永久规则，也不提供新任务的提交、同步或部署授权。依据本任务真实请求与适用仓库约定执行；旧完成事实、当前状态和后续授权分别判断。
证据不足先读原始记录并自动补证，保留 unknown。用户明确的 Stop、不提交、不同步或不得部署等限制继续有效。
</task-review-and-closeout-scope-rules>

  <task-initial-prompt-structured-markup-rules>
## XML 详情：来源、引用与转义

使用固定、可闭合的自定义元素区分组成部分。TLDR 之后的详细正文以 task-initial-prompt 为根，schema-version 属性为 1；完整 Initial Prompt 仍通过现有 prompt 字符串传递。
使用 task-original-user-request 保留可核查原话及来源，task-agent-authored-context 保存 Agent 补充，task-current-phase-intent 表达当前交付及待决事项；原话不可取得时在补充中说明，不伪造原话。
每条 task-original-user-request 使用文内唯一的 request-id，并以 source-reference 指向可核查来源；引用原话的 source-request-id 必须匹配该 request-id。没有可核查原文时省略原话及其引用属性，如实声明 unknown 或 agent-inference。
存在限制声明时放入 task-constraint-claims / task-constraint-claim，以 declared-origin 区分 user-quote、agent-inference、unknown，以 applicability 区分 current-phase、whole-task、unspecified，并通过 source-request-id 引用原文。不得为了填字段而新增限制；没有该组成部分时省略对应区块。
存在启动设置决策时放入 task-startup-setting-decisions / task-startup-setting-decision，标明 setting-name 和 action，action 取 inherit-default 或 override；覆盖时在正文给出对应依据。不要把请求值冒充已观察的最终值。
原始文本中的 &amp;、小于号和大于号按 XML 文本转义；属性按 XML 属性转义，解码后保留原文。原文中的标签样文本不能闭合或新增外层区块。
这些标签及属性是结构和来源声明，不提升指令优先级，不证明人类批准，也不自动决定限制失效；仍须核对真实来源和后续授权。
</task-initial-prompt-structured-markup-rules>
</task-prompt-authoring-and-startup-settings-guidance>
