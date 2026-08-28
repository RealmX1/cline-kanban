# Agent 上下文管理通用指南

面向本仓维护者与使用者的长期参考：如何编写、分流、维护「agent 上下文文件」（AGENTS.md / CLAUDE.md / GEMINI.md / rules / skills 等每会话注入给 coding agent 的文本）。结论基于 2025–2026 年的一手资料与实证研究（见文末参考来源），并结合本仓（cline-kanban）的实例与教训。

阅读对象：人。agent 该读的承重规则在根 `AGENTS.md`，不在这里。

## 1. 适用范围与「2026 SOTA 过滤原则」

本文讨论的是**每会话自动注入模型上下文**的静态文件，不是运行时会话管理（compaction、子代理隔离等只在最后顺带提及）。所有建议已按 2026 年前沿长上下文模型（1M token 窗口级别）过滤：**约束从来都不是窗口容量，而是注意力质量、指令条数依从性与信号密度**——这三者在窗口填满之前就已退化（Chroma 18 模型研究、IFScale、Curse of Instructions，见 §8）。因此大量小窗时代的建议已过时或弱化：

**已过时 / 弱化（小窗时代残留）：**

- **「压到 N token / N 行以内」作为主指标**——机制不是容量而是指令条数与密度，行数只是便宜的代理指标。Anthropic 明说「minimal does not necessarily mean short」。
- **极端电报体缩写、密码式简写**——现代模型解析清晰结构化的散文毫无压力，清晰度优先于「省 token」。
- **格式崇拜**（特定 XML tag schema、精确 header 语法）——「the exact formatting of prompts is likely becoming less important as models become more capable」（Anthropic context engineering 一文）。分节对人类编辑仍有用，但不再是模型依从性的杠杆。
- **ALL-CAPS / IMPORTANT / YOU MUST 强调作为合规机制**——2026 模型上边际收益小且不随条数扩展；它是对「文件过长」的弱补丁。Claude Code 官方文档仍将其列为调优手段，故判「弱化」而非「死亡」；真正的解法是规则少而突出。
- **边界情形罗列 / few-shot 堆砌**——Anthropic 明确反推荐（改用「少量精心策划的典型样例」），且重复结构会诱发 Manus 报告的 mimicry 漂移（重复的规则句式会把模型「few-shot 进」僵化模式）。
- **「检索不可信所以预加载参考资料」**——agentic 检索（glob/grep/JIT 加载）已可靠，预加载转储从保险变成了反模式。
- **有损截断/摘要作为长任务生存策略**——已被「可恢复压缩（丢内容留指针，Manus 的 filesystem-as-context）+ 子代理隔离」取代；窗口溢出不再是主要失败模式，rot 在溢出之前发生。

**仍然成立（2026 证据明确重申，§2 逐条展开）：**

- 上下文衰减（context rot）与注意力预算——1M 窗口不解决，「a performance gradient rather than a hard cliff」；
- 指令条数依从性衰减——~150–200 条后指数级且不可预测；
- JIT / 渐进披露优于预加载；
- 确定性机制（hook/lint）优于散文规约；
- curated examples 优于边界情形清单；
- 上下文文件即代码（版本化、评审、修剪、行为验证）。

**总判断：2026 年的证据没有任何一条削弱「短、单源、指针密集的根上下文文件」的主张——更大的窗口反而强化了它**，因为容量借口被移除，而注意力与指令条数约束原封不动。（一个反向好奇点：Chroma 发现打乱顺序的 haystack 有时**优于**连贯叙述——把它当作「别过度信任自己对『组织良好』的审美直觉」的警告，而非写乱文件的许可证。）

## 2. 核心原则

1. **信号密度 > 容量。** Chroma 的 18 模型研究（控制任务难度、只变输入长度）显示所有前沿模型随输入变长非均匀退化：LongMemEval 上 ~113K token（远在窗口内）全模型在「全文 vs 聚焦输入」下显著变差；干扰项随长度危害加剧；连逐字复制这种平凡任务都退化。Anthropic 的表述：注意力是有限预算（n² pairwise 关系），目标是「the smallest possible set of high-signal tokens」。**每一行都要赚回自己的位置**——官方判据：「For each line, ask: 'Would removing this cause Claude to make mistakes?' If not, cut it.」
2. **指令条数有预算，且超预算后不可预测。** IFScale：最强前沿模型在 500 条同时指令下只有 ~68% 准确率，primacy bias（靠后的规则被静默丢弃）在 ~150–200 条出现。Curse of Instructions：整体准确率 ≈ 单条准确率^n，指数衰减。你无法预测**哪条**规则会被丢——所以长规则堆不是「部分有效」，是「随机失效」。
3. **JIT / 渐进披露优于预加载。** 上下文文件应当地图（指针），不当领土。Agent Skills 的三级披露是形式化范本：metadata（几十 token）常载 → SKILL.md 正文按相关性加载 → 捆绑参考文件按需加载。根上下文文件就是第 1 级：小而精的常载 + 大量指针。Claude Code 的混合模型即此：小 CLAUDE.md  upfront + glob/grep 运行时 JIT 检索。
4. **单一真相源。** 分片/矛盾的指令投递使模型表现退化 ~39%（Laban et al.，200K 模拟对话、15 模型；o3 从 98.1 掉到 64.1）。模型不会对矛盾取平均——Anthropic 的原话是「Claude may pick one arbitrarily」。重叠规则散落在多个文件 = 静态复现多轮分片病理。
5. **上下文有四种失效模式，上下文文件是四种风险的每会话常设注入**（Breunig 分类）：**poisoning**（文件里一条幻觉/陈旧「事实」被信任并反复引用）、**distraction**（文件长到让模型过度权衡文件本身而非手头任务）、**confusion**（多余内容会引导行为——context 里的每个 token 都会被 attend）、**clash**（两个来源不一致）。§4 的反模式目录逐条映射到这四类。
6. **确定性机制（hook / lint）> 散文规约。** CLAUDE.md 是以 user message 注入的，不是 system prompt，没有强制保证。官方原话：「An instruction like 'never edit .env' in CLAUDE.md or a skill is a request, not a guarantee… If a rule must hold every time, make it a hook rather than a prompt instruction.」安全攸关规则留在 prompt 层会「under pressure, in long sessions… or due to prompt injection」失效。推论：lint 已强制的边界（如本仓 biome/grit）不要再用散文复述——零新增信息。
7. **指令海拔要合适。** 在「脆弱的硬编码 if-else 剧本」与「假设共享上下文的空泛指导」之间：具体到能验证（"Run `npm test` before committing"，而非 "Test your changes"），但以灵活启发式而非穷举规则表达。模型越强，需要的规约式工程越少——过度规约的文件**设计上就注定老化**。
8. **典型样例 > 规则穷举。** 「diverse, canonical examples」是 Anthropic 对边界情形清单的官方替代——examples are "pictures worth a thousand words"。穷举既膨胀上下文又诱发 §1 所说的 mimicry。
9. **上下文文件即代码。** 版本化、进 PR 评审、定期修剪、通过观察 agent 行为是否变化来「测试」改动。ETH Zurich 的实证（arXiv:2602.11988）：即便人工写的上下文文件也是 +20% 推理成本换 ~4% 成功率；**LLM 生成的文件净收益为负**（详见 §4 反模式 1）。未修剪的文件是对每个任务常设的税。
10. **位置与稳定性技巧（仍然有效）。** 关键项放在短文件顶部利用 primacy bias（recitation/attention placement 有效）；常载前缀保持稳定——时间戳、计数、易变统计既破坏 KV-cache 又注定过期（Manus 的 KV-cache 纪律适用于一切每会话注入的内容）。会话设计侧的附带经验：保留错误在上下文里——擦除失败 = 移除模型赖以适应的证据。

## 3. 内容分流决策矩阵

先看官方的 include/exclude 判据（Claude Code best practices，原样适用于任何 harness 的上下文文件）：

- **该写**：猜不出来的 bash 命令；**与默认不同**的代码风格；测试指令/指定 runner；仓库礼节（分支命名、PR 约定）；项目专属架构决策；环境怪癖（必需的环境变量）；**常见坑 / 非显然行为**。
- **不该写**：读代码就能搞清楚的任何东西；语言标准约定；详细 API 文档（给链接）；频繁变化的信息；长篇解释/教程；逐文件的代码库描述；"write clean code" 式自明建议。

一条内容该去哪，按这个表裁决（依据 Anthropic features-overview 决策表与各 provider 文档）：

| 内容类型 | 归宿 | 机理 |
| --- | --- | --- |
| 每会话都需要的事实（猜不出来的命令、非默认约定、架构决策、always/never 请求） | 根上下文文件（AGENTS.md / CLAUDE.md） | 只有它保证每会话在场 |
| 只适用某个子树的约定（如本仓 web-ui 的 Tailwind/Radix 栈） | 嵌套 AGENTS.md 或 path-scoped rule（`.claude/rules/*.md` 的 `paths:` frontmatter） | 只在读该子树文件时加载，真正缩小每会话 footprint（`@import` 拆分**不**省上下文，见 §5） |
| 多步流程（>30 行的 procedure，如 RVF 流程） | skill | 渐进披露；「CLAUDE.md is for facts; skills are for procedures」 |
| 必须恒成立的规则（不许碰 `.env`、提交前必跑测试） | hook / lint / 测试 | 散文是请求不是保证；确定性机制才不会「在压力下」失效 |
| 细节文档：post-mortem、集成日志、runbook、ADR | `docs/` + 根文件一行指针 | agent 按需 Read；常载只会让承重规则淹没在噪音里 |
| 可从代码推导的事实（目录布局、依赖清单、脚本清单、架构概述） | **不写** | 零信息量 + 双源漂移 + `/doctor` trim 的官方修剪目标正是这类 |
| 中间产出会淹没主上下文的工作 | 子代理（返回摘要） | 会话策略而非文件问题，顺带提及 |

触发启发式：「Claude gets a convention or command wrong twice → add it to CLAUDE.md」（官方）；「If an entry is a multi-step procedure or only matters for one part of the codebase, move it to a skill or a path-scoped rule instead.」

## 4. 反模式目录（12 条，各附危害机理与本仓实例）

> 本节「本仓实例」描述的是 **2026-08 上下文重构前**的历史状态（行号指向该历史版本）；这些实例在重构中已修复，留作教学样本。

1. **/init 转储直接提交**——LLM 生成的上下文文件重述 agent 自己能发现的东西，付 +20% 成本买噪音；ETH 研究显示其比没有文件还差 ~3%。/init 产出是起点不是成品（旧版 `/init` 不读 AGENTS.md，这正是本仓 CLAUDE.md 丢失 `@AGENTS.md` 导入的背景之一）。本仓实例：根 `CLAUDE.md:1-3` 保留 /init 典型样板（"This file provides guidance to Claude Code…"），且含易漂移 inventory（App.tsx 行数已漂移、agent 名单必漂）。
2. **双源漂移**——同一内容两个副本必然分叉，然后 clash，模型任意和解。本仓实例：44 行 GitNexus 块在 `AGENTS.md:131` 与 `CLAUDE.md:147` 逐字重复；react-use 路径已分叉（`AGENTS.md:40` 写 `@/kanban/utils/react-use`，`CLAUDE.md:135` 是正确的 `@/utils/react-use`）。
3. **陈旧事实（路径/命令/行号引用）**——agent 跟随错误指针白白烧轮次；一处被发现的假话会让整个文件的可信度贬值。本仓实例：`AGENTS.md:40` 的 `@/kanban/utils/react-use`——实际模块在 `web-ui/src/utils/react-use.ts`，仓内 28 处 import 全部用 `@/utils/react-use`、旧路径 0 命中。
4. **文件间矛盾**——模型不对矛盾取平均，而是挑一个或整体退化（Laban：wrong-turn anchoring）。任何跨文件分歧都是存续缺陷，不是文档洁癖。本仓实例：`docs/architecture.md:9` 仍写「two different agent execution paths」，早于 ACP/omp 第三种 transport（`src/acp-client-session/`）。
5. **append-only 巨型 tribal 堆积**——过 ~150–200 条指令后依从性指数衰减且**不可预测**；每条低价值行都在稀释承重行。Anthropic 把它命名为 "the over-specified CLAUDE.md" 失效模式：「If your CLAUDE.md is too long, Claude ignores half of it because important rules get lost in the noise.」本仓实例：根 `AGENTS.md` 174 行但 39.4KB（`CLAUDE.md` 的 3 倍体积），11 条 ≥1000 字符的巨型 bullet 占全文 60%（facet 模型那条在 `AGENTS.md:111`，4509 字符 ≈ 700 词）。
6. **无例外的 ALWAYS/NEVER**——脆弱：合法例外没有判断空间，且绝对规则随文件增长互相碰撞。耐久写法是「prefer/avoid + 具名例外」。注意区分：有机制背书的绝对禁令（如本仓 facet 铁律背后是 zod superRefine 守卫）是成立的；stylistic 绝对化不成立。本仓实例：GitNexus 块（`CLAUDE.md:147+` / `AGENTS.md:131+`）的工具生成绝对指令（「NEVER edit a function… without first running impact」）无例外通道。
7. **复述仓库已声明的事实**（package.json scripts、tsconfig strictness、linter 已强制的风格）——零信息、双源真相，且 lint 已有散文无法增强的确定性兜底。本仓实例：`CLAUDE.md` 的逐目录文件清单与 agent 名单（必漂，正确出处是 `src/core/agent-catalog.ts`）。
8. **任务专属流程进常载文件**——40 行的迁移/发布流程会注入**每一个**会话（包括无关会话）；这正是 skill 渐进披露存在的理由。根文件只保留全局硬约束。本仓实例：根 `AGENTS.md` 头部的 RVF 工作流散文（机器可发现标记行 `RVF-ENTRY-SKILL:` 是必要的，但配套的整段流程解释属 skill 层）。
9. **空泛套话**（"write clean code"、"be careful"、"production-quality code"）——占用注意力、防不住任何错误、且计入指令条数预算。本仓实例：根 `AGENTS.md` Code quality 节的「Write production-quality code, not prototypes」「Follow DRY principles」等零信号条。
10. **不可自验的流程元指令**——「完成 X 时以模式 Y 调用 skill Z」这类长协议，模型无法可靠自我检查是否已合规；行为真要紧就用 hook/skill 触发器确定性强制。本仓实例：RVF 入口的「实现收尾、宣告完成、或进入 review 前必须先调用 skill …」约定，正是靠散文强制流程的典型（其机器可读标记行本身是对的——那是给工具读的）。
11. **易变快照进常载前缀**（计数、时间戳、"300 execution flows"）——破坏 KV-cache 稳定（Manus），且按构造必然过期。本仓实例：`CLAUDE.md:150` 的 GitNexus 统计快照「11964 symbols, 31422 relationships, 300 execution flows」。
12. **只增不减，无删除仪式**——上下文文件单调增长，因为添加无成本而删除「感觉有风险」；ETH 的成本发现意味着未修剪文件是对每个任务的常设税。本仓实例：双药丸 bug「被点修过三次仍复发」，修复方式是继续往 `AGENTS.md` append 取证细节（当时 `AGENTS.md:116-124` 的 26% 误显示取证全文），而非归层到 docs。

## 5. Provider 差异表

**先确立 AGENTS.md 标准本身的事实**（[agents.md](https://agents.md/)，现由 Linux Foundation 旗下 Agentic AI Foundation 托管）：无 schema、无必填字段，纯 Markdown；冲突规则是「**离被编辑文件最近的 AGENTS.md 胜出；用户聊天里的显式 prompt 高于一切**」；嵌套是一等特性（OpenAI 自家仓库有 88 个嵌套文件）；源自 OpenAI Codex、Amp、Google Jules、Cursor、Factory 的协作。对标准前旧文件的官方迁移建议：改名为 AGENTS.md 并把旧名 symlink 过来。「文件没有规范语言，一切重要行为（发现、优先级、回退、大小上限）都是 per-loader 的」（[Alex Dunlop](https://www.alexdunlop.com/writing/claude-md-vs-agents-md)）——服务多 harness 的仓库必须按最小公分母 loader 设计。

| Harness | 加载入口 | 嵌套行为 | 大小上限/建议 | 桥接/备注 |
| --- | --- | --- | --- | --- |
| Claude Code | `CLAUDE.md`（**不读 AGENTS.md，无 fallback**）；层级：managed policy → user `~/.claude/CLAUDE.md` → project → `CLAUDE.local.md` | 向上走全载；子目录文件**JIT**（读到该处文件时才加载）；`/compact` 后只有根文件重注入 | 目标 **<200 行/文件**，无硬上限；`@import` ≤4 跳、启动时全展开（拆分不省上下文） | 官方桥：CLAUDE.md 里一行 `@AGENTS.md`；`.claude/rules/*.md`（`paths:` frontmatter）；`/doctor` trim（v2.1.206+）；`/context` 验证加载结果 |
| OpenAI Codex | `AGENTS.md`；global 层 `$CODEX_HOME/AGENTS.override.md` 否则 `AGENTS.md`（只取第一个非空）；project 层每目录 `AGENTS.override.md` → `AGENTS.md` → `project_doc_fallback_filenames` 名单，**每目录最多一个** | 仅沿 git root → cwd 路径，每 run/session 启动时发现一次并拼接（root→下、空行连接，靠后的文件因出现在 prompt 后段而覆盖前者）；cwd 之下的嵌套文件**不发现** | **硬上限 `project_doc_max_bytes`，默认合并 32 KiB，静默截断**（[openai/codex#13386](https://github.com/openai/codex/issues/13386)，约 600–800 行处断掉、无任何警告）——高价值内容必须前置 | CLAUDE.md 仅在加进 `project_doc_fallback_filenames` 时才读 |
| Cursor | `.cursor/rules/*.mdc`（`description`/`globs`/`alwaysApply` frontmatter；**纯 `.md` 被忽略**）+ `AGENTS.md`（官方定位：「simple alternative to `.cursor/rules`」） | AGENTS.md 支持根 + 任意子目录，子树内自动应用、更具体者优先；规则类型优先级 Team → Project → User | 建议规则 **<500 行** | 官方反模式清单：复制 style guide（用 linter）、记录每条命令、边界情形指令、重复代码库内容；「reference files instead of copying their contents」 |
| Gemini CLI | `GEMINI.md`（global → project + 祖先） | JIT：工具访问某目录时发现；全部拼接后随每个 prompt 发送，更具体者覆盖 | 无文档化硬上限 | `context.fileName` 可配列表（如 `["AGENTS.md","GEMINI.md"]`）——AGENTS.md 是配置支持非原生默认；支持 `@file.md` import；`/memory show` 检查合并结果 |
| Factory droid | `AGENTS.md` 原生；兼容文件名**含 `CLAUDE.md`**（大小写变体也算） | cwd → git root 逐目录 + `.factory/`、`.agents/`、`.agent/` context dirs；读文件时动态发现嵌套 | **初始加载 80,000 字符、动态发现 40,000 字符**（"caps, not targets"） | 本表唯一原生读 Claude 文件的 harness：**并行 AGENTS.md + CLAUDE.md 会被双倍注入**（官方警告 "spends context without adding signal"）；官方内容劝诫：别粘 runbook（给链接或转 skill）、避免 secrets、避免陈旧目录 inventory、避免「跳过验证」类指令 |
| Amp | `AGENTS.md`（原 AGENT.md，已改标准名，有 fallback 文件名） | project / subtree / personal / organization 四层 | 未见硬上限文档 | 官方建议放 test/build 命令与 review 验收标准 |
| Aider | **不自动发现** | — | — | `/read`（只读 + 可 prompt-cache）或 `.aider.conf.yml` 里 `read: AGENTS.md` |
| Kimi Code | `AGENTS.md` 原生（`/init` 生成它）；层级：项目 `AGENTS.md` 或 `.kimi-code/AGENTS.md`、user `~/.agents/AGENTS.md`、global `$KIMI_CODE_HOME/AGENTS.md` | 文档仅载项目级，无嵌套 JIT | 未见硬上限文档 | 内容经 `${agents_md}` 模板变量注入主 agent system prompt——是**引用数据**，约束力弱于 system prompt 本体。**本仓 wrinkle**：Kanban 启动的 kimi 会话把 `KIMI_CODE_HOME` 重定向到 seeded home（`~/.cline/kanban/hooks/kimi/code-home`，见 `src/terminal/kimi-hook-config.ts:59`），因此 global 级 `~/.kimi-code/AGENTS.md` 在该类会话中**不加载**；项目根 `AGENTS.md` 不受影响 |

**Claude Code 记忆层级的常考错细节：**

- 各层全部**拼接**（从不覆盖）；managed policy 层（`/Library/Application Support/ClaudeCode/CLAUDE.md` 等）不可排除。
- 块级 HTML 注释在注入前被剥离——可以免费留维护者注记。
- `claudeMdExcludes` 设置可跳过 monorepo 里无关的嵌套文件。
- **Auto memory**（2025 末起默认开）：Claude 自写 learnings 到 `~/.claude/projects/<project>/memory/`（`MEMORY.md` 为索引），只有前 200 行/25KB 每会话加载；本机局部、跨 worktree 共享、**不注入子代理**。它吸收了「记住我上次的纠正」这个用例，是旧时「让 agent 记笔记」建议的替代机制。

**两文件并存时的优先级**：无跨工具标准，行为 per-loader——Claude Code 完全忽略 AGENTS.md（除非 import/symlink 桥）；Codex 忽略 CLAUDE.md（除非配 fallback）；droid 两个都读（双倍注入）；Gemini 看 `context.fileName` 名单。**没有任何 harness 会对同层两个文件做合并/去重**：两个根文件要么一个不可见，要么双双注入。流传的「Claude Code 会把 AGENTS.md 当 fallback」说法在现行官方文档下是错的（[agyn](https://agyn.io/blog/claude-md-agents-md-compatibility) 与 [yurukusa gist](https://gist.github.com/yurukusa/d36197848911f025add142abefcde685) 均已证伪）——此领域漂移很快，优先级设计应对照实际安装的 harness 版本验证。

## 6. 双文件单源化三方案对比及本仓选择

同时服务 Claude Code（只读 CLAUDE.md）与其它 harness（只读 AGENTS.md）的仓库，单一真相源有三条路：

1. **symlink（`ln -s AGENTS.md CLAUDE.md`）**——零漂移可能，但坑最多：
   - Claude Code 的 Write/Update 工具**拒绝写穿 symlink**（"Refusing to write through symlink… resolve and pass the real target path"，[claude-code#66559](https://github.com/anthropics/claude-code/issues/66559)）——Claude 会话永远无法更新自己的记忆文件；
   - Windows checkout 需 `core.symlinks=true` / Developer Mode；
   - 大小写敏感文件系统上，macOS 创建的链接可能静默断链；
   - symlink 类有安全前科：Claude Code `@import` 经仓库内提交的 symlink 解析到仓外导致文件外泄（CVE-2025-59829 谱系）。
2. **`@AGENTS.md` import（CLAUDE.md 里一行）**——官方推荐桥。允许在 import 下方追加 Claude 专属内容。坑：import 内容启动时**全额计入上下文**（无节省）；相对路径相对**导入文件**解析（与 cwd 无关）；仓外路径触发一次性批准对话（被拒绝后可能一直禁用）；递归 ≤4 跳；解析跳过行内代码与围栏代码块（想提及而不导入就用反引号包住）；**单向**——非 Claude 工具读 CLAUDE.md 不会展开 `@` 语法（那是 Claude 专属语法）。
3. **分叉各自维护 / 一次性拷贝**（`/import` 命令、生成器、同步脚本）——最差失败模式。Claude Code 的 `/import` 明说是一次性拷贝「append」，即拷贝完成那一刻漂移开始。学术证据（[arXiv:2606.15828](https://arxiv.org/html/2606.15828v2)，2026-01 对 100 个顶级仓库的审计）：91/100 的上下文文件有 ≥1 种 smell——Lint Leakage 62%、Context Bloat 42%（≥200 行）、Skill Leakage 35%、**Conflicting Instructions 28%**（16 例实锤）、Init Fossilization 24%、Blind References 16%；「矛盾指令 × 上下文膨胀」共现 lift 1.76。

**本仓选择：方案 2（`CLAUDE.md` = `@AGENTS.md` + 极短 Claude 专属节），AGENTS.md 为 canonical。** 理由：droid/kimi/Codex/Cursor 都原生读 AGENTS.md，Claude Code 是唯一需要桥的消费者；symlink 的写穿拒绝会直接破坏本仓「tribal knowledge 变更时更新 AGENTS.md」的惯例（Claude 会话将无法编辑该文件）；本仓开发环境虽为 macOS/Linux，symlink 的可移植性与安全记录仍然不佳。反面教训即本仓现状：commit `02abe1cb` 删掉了 `@AGENTS.md` 导入，结果 Claude Code 会话完全看不到 `AGENTS.md` 的承重规则，其它 harness 完全看不到 `CLAUDE.md` 的命令/测试告警，且两文件已实际漂移（react-use 路径、GitNexus 块双份）。

## 7. 维护生命周期

**何时加（官方四条 trigger，满足其一即可）：** agent 同一错误犯第二次；code review 抓到它本该知道的东西；你重新敲了一遍上会话的纠正；新队友需要这份上下文。加之前先问 §3 的矩阵：它真的该进每会话常载文件吗？

**何时删 / 降级：** agent 不看这条也已经做对（删掉，或转 hook）；内容可从代码推导；事实已失效；流程长成多步 procedure（转 skill）；只服务一个子树（转嵌套文件 / path rule）。官方对过长文件的修法原文：「Ruthlessly prune. If Claude already does something correctly without the instruction, delete it or convert it to a hook.」

**评审与修剪仪式：**

- 像评审代码一样评审上下文文件的 PR diff；给文件指定 owner。「Treat CLAUDE.md like code: review it when things go wrong, prune it regularly, and test changes by observing whether Claude's behavior actually shifts.」「Check CLAUDE.md into git so your team can contribute. The file compounds in value over time.」
- Claude Code 用户跑 `/doctor`（v2.1.206+）的 trim 检查——它专删 agent 可从代码推导的内容（目录布局、依赖清单、架构概述），保留坑、rationale、非默认约定；用 `/context` 验证实际加载了什么；`InstructionsLoaded` hook 可记录「何时加载了什么」的日志。
- 警惕 `/init` 与 `/import`：`/init` 产出是待精炼的起点（设 `CLAUDE_CODE_NEW_INIT=1` 的新流程会读 AGENTS.md/.clinerules/Cursor 规则等，提议 CLAUDE.md + skills + hooks 供评审后才写入）；`/import` 是一次性拷贝，用完即漂移。
- **`#` quick-add 已停用**（[claude-code#14743](https://github.com/anthropics/claude-code/issues/14743)、[#54747](https://github.com/anthropics/claude-code/issues/54747)）。现行路径：`/memory`（在编辑器打开记忆文件）、对话式「remember that X」（→ auto memory）、「add this to CLAUDE.md」（→ CLAUDE.md）。
- `/compact` 注意：只有项目根 CLAUDE.md 会在 compact 后重注入，嵌套文件与 path rule 要等下次读到匹配文件才重载；会话内口头交代的事会丢，重要的落文件。

**Drift 自查清单（定期跑）：**

- 全文 grep 一遍文件里引用的路径/命令/符号，逐一确认仍存在（本仓被抓到过时的 `@/kanban/utils/react-use` 就是这类）；
- 行数/字节预算检查：Claude Code 目标 <200 行/文件；合并总量对 Codex 32 KiB 硬上限留余量（截断是静默的）；
- 跨文件矛盾检查：同一主题在两个文件里的表述是否一致（或干脆单源化，见 §6）；
- 统计快照新鲜度：凡写进常载文件的计数/行数/名单，默认已过期；
- 「删掉会让 agent 犯错吗？」逐行过一遍——答「不会」的删。

## 8. 参考来源

**官方文档 / 官方博客：**

- Claude Code memory 文档（canonical）：<https://code.claude.com/docs/en/memory>（同内容：<https://docs.anthropic.com/en/docs/claude-code/memory>）
- Anthropic — Best practices for Claude Code（2026-08 重写版，含 include/exclude 表）：<https://www.anthropic.com/engineering/claude-code-best-practices>
- Anthropic — Effective context engineering for AI agents：<https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>
- Anthropic — Claude Code features overview（CLAUDE.md vs rules vs skills vs hooks 决策矩阵）：<https://code.claude.com/docs/en/features-overview>
- Anthropic — Equipping agents for the real world with Agent Skills（渐进披露三级模型）：<https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills>
- AGENTS.md 标准（Agentic AI Foundation / Linux Foundation）：<https://agents.md/>
- OpenAI Codex — AGENTS.md 指南：<https://developers.openai.com/codex/guides/agents-md>
- Cursor — Rules 文档：<https://cursor.com/docs/rules>
- Gemini CLI — 配置参考：<https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md>
- Factory droid — AGENTS.md 文档：<https://docs.factory.ai/harness/agents-md>
- Amp — Manual 与 AGENT.md 公告：<https://ampcode.com/manual>、<https://ampcode.com/news/AGENT.md>
- Aider — Conventions：<https://aider.chat/docs/usage/conventions.html>
- Kimi Code — Agents 自定义文档与 getting started：<https://moonshotai.github.io/kimi-code/en/customization/agents>、<https://www.kimi.com/en-cn/help/kimi-code/cli-getting-started>

**研究 / 深度文章：**

- Chroma — Context Rot（18 模型实证）：<https://research.trychroma.com/context-rot>
- IFScale — How Many Instructions Can LLMs Follow at Once?（arXiv:2507.11538）：<https://arxiv.org/abs/2507.11538>
- Curse of Instructions（ICLR 2025）：<https://openreview.net/pdf/848f1332e941771aa491f036f6350af2effe0513.pdf>
- Laban et al. — LLMs Get Lost in Multi-Turn Conversation（arXiv:2505.06120）：<https://arxiv.org/abs/2505.06120>
- Gloaguen et al.（ETH Zurich）— Evaluating AGENTS.md（arXiv:2602.11988）：<https://arxiv.org/abs/2602.11988>（附从业者的审慎批评：<https://github.com/WellDunDun/reins/blob/master/evaluating-agents-md-review.md>——AGENTbench 测的是上下文文件最不起作用的孤立 bug-fix 任务，应读作「坏/冗余文件有害」而非「所有文件有害」）
- Common Mistakes in Configuring Coding Agents（arXiv:2606.15828，100 仓 smell 目录）：<https://arxiv.org/html/2606.15828v2>
- Context files 互相引用现象研究（arXiv:2602.14690）：<https://www.arxiv.org/pdf/2602.14690>
- Manus — Context Engineering Lessons：<https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus>
- LangChain — Context Engineering for Agents（write/select/compress/isolate）：<https://blog.langchain.com/context-engineering-for-agents/>
- Drew Breunig — How long contexts fail（poisoning/distraction/confusion/clash 分类）：<https://www.dbreunig.com/2025/06/22/how-contexts-fail-and-how-to-fix-them.html>
- Alex Dunlop — CLAUDE.md vs AGENTS.md: It's the Loader, Not the File：<https://www.alexdunlop.com/writing/claude-md-vs-agents-md>
- 10 CLAUDE.md Mistakes（Termdock, 2026-03）：<https://www.termdock.com/en/blog/claude-md-common-mistakes>
- Steering Claude Code 的二手综述（原 anthropic.com 文章 404，仅作二手归因）：<https://explainx.ai/blog/steering-claude-code-claude-md-skills-hooks-subagents-rules-2026>
- Claude/AGENTS.md 兼容性考证：<https://agyn.io/blog/claude-md-agents-md-compatibility>、<https://gist.github.com/yurukusa/d36197848911f025add142abefcde685>
- 双文件同步实践：<https://getunblocked.com/blog/keeping-claude-md-agents-md-cursorrules-in-sync/>

**工具 issue / 安全记录：**

- openai/codex#13386（32 KiB 静默截断）：<https://github.com/openai/codex/issues/13386>
- claude-code#66559（拒绝写穿 symlink）：<https://github.com/anthropics/claude-code/issues/66559>
- claude-code#14743 / #54747（`#` quick-add 已停）：<https://github.com/anthropics/claude-code/issues/14743>、<https://github.com/anthropics/claude-code/issues/54747>
- symlink 经 `@import` 解析到仓外致文件外泄（CVE-2025-59829 谱系披露）：<https://mallory.ai/stories/019f9406-3e35-70ae-b440-2cf394a0b176>
