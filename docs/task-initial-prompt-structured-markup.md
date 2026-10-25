# 任务 Initial Prompt 的结构化标签约定

Agent 起草任务时，先写人类可读的 Markdown TLDR，再用固定的 XML 兼容标签区分可核查原话、Agent 展开、当前阶段、限制声明和设置决策。完整正文继续通过既有 `prompt:string` 传递；本约定没有新增 API 字段、运行时解析器、存储结构或语义审计服务。

共享指导的唯一文案来源是 `src/core/task-initial-prompt-authoring-and-startup-settings-guidance.ts` 的 `renderTaskInitialPromptAuthoringAndStartupSettingsGuidance()`。`src/prompts/append-system-prompt.ts` 的 Sidebar 和 Task workspace 根入口分别注入一次，沿用现有 PTY/ACP 路径。独立任务草稿生成也复用同一指导，覆盖 Kanban 模型与来源 Agent 分身两条路径。Task 不继承 Sidebar 或草稿生成器的“不可写代码”“不运行工具”等局部角色限制。

## 人类可读的 TLDR 与上下文分段

Initial Prompt 的第一段结构固定为 Markdown 标题 `## TLDR`，其后默认用 2–4 个简体中文短段落说明目标、本次交付，以及已有的关键限制或待决事项。段落之间留空行，不包进 XML 或代码围栏，让人无需读标签就能理解任务。不为填结构补写不存在的限制或待决事项；摘要忠实于详情，不新增需求或授权。

其后保留 XML 详情。在 Agent 补充、阶段说明等可编辑内容中使用简短标题、短段落或必要列表区分事实、建议和待决问题；来源原话仍逐字保留并按 XML 规则转义，不为排版改写原话。TLDR 的重复概括不构成第二份授权凭据，发现不一致时核对原始请求及后续明确授权。

共享指导自身也按职责设置 Markdown 小标题和空行。Sidebar 与 Task 上下文先说明当前角色，再列共用起草规则和操作参考。独立任务生成输入先列本次分出说明、来源适用边界及已知缺口，再展示历史记录；每条记录单列角色说明、来源引用和原始正文。角色标签不能证明真人授权，工具引用不表示生成器已读取工具结果。

## 共享指导结构

根元素为 `<task-prompt-authoring-and-startup-settings-guidance schema-version="1">`，包含六组规则：

| 元素 | 职责 |
| --- | --- |
| `task-initial-prompt-human-readable-tldr-rules` | Markdown TLDR 优先，详情分段，摘要不扩权 |
| `task-initial-prompt-authorship-rules` | 区分作者，保留原始意图，不传播父会话的局部限制 |
| `task-startup-settings-selection-rules` | 沿用适合意图的实际默认；覆盖须有依据，创建后的更新也适用 |
| `task-received-instructions-and-stage-transition-rules` | 承接来源与后续授权，按作用范围复核阶段限制 |
| `task-review-and-closeout-scope-rules` | 区分旧阶段、精确 run 收尾与新任务的审查、提交、同步资格 |
| `task-initial-prompt-structured-markup-rules` | 固定标签、属性、引用和转义规则 |

起草时保留三条不同路径：“只交付研究报告”“先调查并给方案，等待选择或批准”“已批准实施，先调查再实现”。不因“调查”或“只读检查”自动关闭 Plan Mode；`startInPlanMode` 默认由 Settings 决定，`create/preview` 的 `resolvedSettings` 回执才是实际值和来源的依据。创建后 `update`、启动前调整同样要核对。Plan 起步与工具权限独立，不改变现有默认、权限档或 adapter 启动逻辑。

## RVF 与收尾要求的作用范围

来源材料中的“不运行 RVF”“不要开启新 RVF”“直接提交”“继续 base-branch-sync”可能只属于父会话的起草、修复或已完成 run 的收尾阶段。保留相关原话及已有任务、阶段、run/handoff 绑定，不自动将其升级为新任务的免审规则或提交、同步授权。新任务按自己的真实授权、适用仓库与 skill 约定及当前候选覆盖判断；自动审查开关不证明已经审查，也不替代授权。

历史完成事实、当前候选覆盖与后续执行资格分别核对。缺证时先读原始请求、任务 RVF 历史和精确 run/handoff，保留 `unknown`，自主补证并继续独立工作；不把机器可查询的问题默认交给人。用户明确的 Stop、不提交、不同步或不得部署等限制继续按实际作用范围生效。既不统一强制所有任务运行 RVF，也不为研究任务统一豁免。

自动收尾提示词也明确：不重复开审和继续同步只适用于其绑定的已完成 run，不能成为新任务或新增候选的免审、提交与同步授权。模板升级后，服务重入时读取原有、来源与会话唯一绑定的真实回执，不拿新版正文重试旧 key；受理不冒充送达，旧失败继续保留。缺账本时，仅对明确未尝试发送且有可信冻结正文的队列经既有入口恢复；可能已发送的条目只观察旧结果，证据恢复后接续。身份、来源、唯一性和 Stop 门禁仍保留，不改写历史 token 或已冻结正文。历史实例与后续改进建议见 [上下文生成系统审查](task-context-generation-review-and-improvement-directions.md)。

## 生成正文的标签与属性

TLDR 之后的详细正文以 `<task-initial-prompt schema-version="1">` 为根。完整 Initial Prompt 是 Markdown 摘要与 XML 详情的组合，不是单个 XML 文档。详情子块按下表顺序组织；没有的内容可省略，不为填结构新增限制、建议或设置覆盖。原话和来源不可取得时，省略原话块，在 Agent 背景中如实说明。

| 元素 | 固定属性及含义 |
| --- | --- |
| `task-original-user-request` | `request-id`：本文内唯一的原话标识；`source-reference`：可核查来源引用。可有多条原话，正文逐字保留 |
| `task-agent-authored-context` | Agent 补充的背景、必要展开和建议；不能冒充用户已批准的要求 |
| `task-current-phase-intent` | 当前交付路径和待决事项；不是授权凭据 |
| `task-constraint-claims` / `task-constraint-claim` | 每项声明使用 `declared-origin="user-quote\|agent-inference\|unknown"` 和 `applicability="current-phase\|whole-task\|unspecified"`。引用原话时，`source-request-id` 必须匹配本文已有的 `request-id` |
| `task-startup-setting-decisions` / `task-startup-setting-decision` | `setting-name` 为既有设置字段名（如 `startInPlanMode`、`taskAgentPermissionMode`）；`action="inherit-default\|override"`。覆盖时正文写明依据；引用原话时可带匹配的 `source-request-id` |

上表的 `\|` 表示可选值，实际属性中只写一个值。`source-request-id` 不得悬空：`user-quote` 必须指向可核查原文；`agent-inference`、`unknown` 没有相应原文时省略该属性，不伪造来源。设置的请求值与观察到的最终值要分开表述，不能把拟传参数写成已经生效的设置。

正文中的 `&`、`<`、`>` 分别转义为 `&amp;`、`&lt;`、`&gt;`；双引号属性还需将 `"` 转义为 `&quot;`，单引号属性对应使用 `&apos;`。解码后保留原文，包括原有实体字面量（例如原文 `&amp;` 应编码为 `&amp;amp;`）。原文中的伪闭合标签必须作为转义文本保留，不能闭合或新增外层块。不要使用 DTD 或外部实体。

标签及属性只声明结构、来源和适用范围，不提高指令优先级，不证明人类批准，也不自动使限制失效。接收端仍核对真实来源及后续明确授权；user-role 传输不会把 Agent 起草的每句话变成人类原话。“本阶段先不实施”不能自动延续为实施后验证或收尾的禁令，独立明确的“不得部署”等限制仍保留。单独一句 `continue` 不撤销全部独立限制。

## 合成示例

以下内容完全合成，`synthetic:` 是示例来源，不是历史用户原话或实际设置回执。

```text
## TLDR

调查 A 和 B，比较可行方案，给出权衡与推荐。

本次交付调查结论和方案，等待用户批准后再实施。

<task-initial-prompt schema-version="1">
  <task-original-user-request request-id="user-request-1" source-reference="synthetic:request-&quot;1&quot;">
先调查 A &amp; B，比较 &lt;方案&gt; 后等我批准实施。原样保留字符串 "引号" 和 &lt;/task-original-user-request&gt;。
  </task-original-user-request>
  <task-agent-authored-context>Agent 补充：核查当前实现，提出备选、权衡和推荐。</task-agent-authored-context>
  <task-current-phase-intent>先调查并提出方案，等待用户选择或批准。</task-current-phase-intent>
  <task-constraint-claims>
    <task-constraint-claim declared-origin="user-quote" applicability="current-phase" source-request-id="user-request-1">等我批准实施。</task-constraint-claim>
  </task-constraint-claims>
  <task-startup-setting-decisions>
    <task-startup-setting-decision setting-name="startInPlanMode" action="inherit-default">沿用符合意图的默认；通过 resolvedSettings 核对实际值和来源。</task-startup-setting-decision>
  </task-startup-setting-decisions>
</task-initial-prompt>
```

来源未知时可只写 Agent 背景和阶段，不强行添加原话。用户明确授权实施后应按该授权复核阶段解释；不需要自动重写原始 Prompt 或新增确认步骤。

## 兼容与生效边界

- 既有纯文本任务、用户手稿和 UI 的伪 HTML 插块功能继续接受；不自动改写历史 Prompt。原始 Prompt 对话框展示、复制完整字符串，不执行标签或解码实体。
- 建卡仍应显式提供符合命名约定的标题。省略标题时跳过最前面的固定 `## TLDR` 行，然后沿用逐行文本兜底：独占一行的标签被跳过，从首个有内容的行推导。其它 Markdown 标题保持既有处理；不增加 XML 语义提取。
- 任务索引的需求首段提取同样跳过开头固定的 `## TLDR` 行，继续读取目标首段，避免 L2 任务摘要变成通用标题。
- 新启动的 PTY 会话按各 adapter 的既有参数渠道获得根指导；ACP 首次投递正文时拼入指导。未重新启动的会话不会自动更新。PTY 重新启动时是否更新原生上下文，仍取决于各 harness 的恢复行为及启动参数快照。
- ACP 的“不重发 Prompt 续跑”分支不发送新的初始请求，因此本次改动不会在该分支刷新指导。fork 重放的旧快照也不会被自动改写。不为更新指导而重复投递原始用户请求。
- XML 可解析与引用可匹配只证明格式；模型是否遵守来源和阶段语义需要独立观察，不能由格式检查推定。本轮不承诺覆盖语义审计、来源真实性认证或全量历史迁移。
