# 任务 Initial Prompt 的结构化标签约定

Agent 起草任务时，用固定的 XML 兼容标签区分可核查原话、Agent 展开、当前阶段、限制声明和设置决策。正文继续通过既有 `prompt:string` 传递；本约定没有新增 API 字段、运行时解析器、存储结构或语义审计服务。

共享指导的唯一文案来源是 `src/core/task-initial-prompt-authoring-and-startup-settings-guidance.ts` 的 `renderTaskInitialPromptAuthoringAndStartupSettingsGuidance()`。`src/prompts/append-system-prompt.ts` 的 Sidebar 和 Task workspace 根入口分别注入一次，沿用现有 PTY/ACP 路径。Task 不继承 Sidebar 的“不可写代码”角色限制。

## 共享指导结构

根元素为 `<task-prompt-authoring-and-startup-settings-guidance schema-version="1">`，包含四组规则：

| 元素 | 职责 |
| --- | --- |
| `task-initial-prompt-authorship-rules` | 区分作者，保留原始意图，不传播父会话的局部限制 |
| `task-startup-settings-selection-rules` | 沿用适合意图的实际默认；覆盖须有依据，创建后的更新也适用 |
| `task-received-instructions-and-stage-transition-rules` | 承接来源与后续授权，按作用范围复核阶段限制 |
| `task-initial-prompt-structured-markup-rules` | 固定标签、属性、引用和转义规则 |

起草时保留三条不同路径：“只交付研究报告”“先调查并给方案，等待选择或批准”“已批准实施，先调查再实现”。不因“调查”或“只读检查”自动关闭 Plan Mode；`startInPlanMode` 默认由 Settings 决定，`create/preview` 的 `resolvedSettings` 回执才是实际值和来源的依据。创建后 `update`、启动前调整同样要核对。Plan 起步与工具权限独立，不改变现有默认、权限档或 adapter 启动逻辑。

## 生成正文的标签与属性

根元素为 `<task-initial-prompt schema-version="1">`。子块按下表顺序组织；没有的内容可省略，不为填结构新增限制、建议或设置覆盖。原话和来源不可取得时，省略原话块，在 Agent 背景中如实说明。

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

```xml
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
- 建卡仍应显式提供符合命名约定的标题。省略标题时沿用逐行文本兜底：独占一行的标签被跳过，从首个有内容的行推导；不增加对嵌套 XML 的语义提取，也不保证单行嵌套结构的标题清理。
- 新启动的 PTY 会话按各 adapter 的既有参数渠道获得根指导；ACP 首次投递正文时拼入指导。未重新启动的会话不会自动更新。PTY 重新启动时是否更新原生上下文，仍取决于各 harness 的恢复行为及启动参数快照。
- ACP 的“不重发 Prompt 续跑”分支不发送新的初始请求，因此本次改动不会在该分支刷新指导。fork 重放的旧快照也不会被自动改写。不为更新指导而重复投递原始用户请求。
- XML 可解析与引用可匹配只证明格式；模型是否遵守来源和阶段语义需要独立观察，不能由格式检查推定。本轮不承诺覆盖语义审计、来源真实性认证或全量历史迁移。
