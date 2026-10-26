# 可视化产物位置统计与统一建议

Task：`cline-kanban/7494b`。统计快照：2026-10-25 11:53:25 UTC。

## 结论

存在三类生成源位置：task worktree、Kanban 持久交接目录、全局 `~/.ai-viz/`。Kanban 的发布存储是第四类位置，保存不可变发布副本。源文件和发布副本同时存在是正常行为，不代表重复生成。

建议统一**一次性说明图的默认源目录和发布入口**，同时保留项目文档、图库及产品自身生成报告的归属。统一的收益是明确任务归属、跨 worktree 清理保留可编辑源、减少 Git 工作区杂物，并让续接会话能找回原图。把所有历史文件、项目文档和发布版本搬到一个物理目录，会破坏这些不同的生命周期，收益不足以抵消迁移成本。

本次交付统计与建议，未迁移历史文件，也未改动外部技能仓。

## 统计口径与可复查证据

扫描本机现存 `.cline/worktrees/`、`cross-task-handoff-artifacts/`、`~/.ai-viz/` 及 `persistent-task-visualization-artifacts/`。这是文件存量调查，不是历史创建事件审计：已删除文件、临时目录中的历史文件及其他未扫描目录不能据此推断。

先排除依赖、产品源码/构建目录、测试夹具、浏览器包和部分隔离验证目录，再以图示标记或明确的片段文件名识别候选。worktree 中与 canonical checkout 内容相同的文档副本单列排除；按 SHA256 识别完全相同的内容。没有明确归属的旧路径保留 `workspaceId=null`，不凭短 taskId 推断项目。

持久证据目录：

`~/.cline/kanban/cross-task-handoff-artifacts/cline-kanban/7494b/visualization-location-assessment/`

- `collect-visualization-location-inventory.py`：只读采集脚本；仅向上述证据目录写结果。
- `visualization-location-inventory-20261025T115325.658953Z.json`：本报告绑定的不可变快照，包含逐文件路径、角色、已知归属、标题、SHA256、大小、修改时间及排除规则。无时间戳文件名是最近一次结果。
- 快照中人工核对了 15 个交接片段均无完整 HTML 文档外壳，并将一个 worktree 构建快照从生成源候选中分开。

重采集命令如下；新结果会反映采集当时的存量，不覆盖本报告标明的历史统计事实。

```sh
python3 /Users/bominzhang/.cline/kanban/cross-task-handoff-artifacts/cline-kanban/7494b/visualization-location-assessment/collect-visualization-location-inventory.py
```

## 现存样本

| 位置与角色 | 文件数 | 不同内容数 | 含义 |
| --- | ---: | ---: | --- |
| `.ai-viz/sessions/` 标准会话页 | 93 | 93 | 跨 harness、跨项目的全局存量；一页可有多张卡 |
| 同目录手写 HTML | 3 | 3 | `task-effe6-openanalysis-research-*` |
| 会话目录的附属说明页 | 1 | 1 | 位于子目录，不是第 94 个标准会话 |
| worktree 说明文档候选 | 3 | 3 | 本仓研究阅读副本、PSE 说明页、RVF 演示文档 |
| worktree 构建快照 | 1 | 1 | 独立于说明图源统计 |
| 持久交接目录的 HTML 片段 | 15 | 15 | 待插入会话页的卡片正文 |
| 持久交接目录的历史版本/备份 | 5 | 5 | 修改前的会话页或片段，不视为五次独立生成 |
| 持久交接目录的独立报告候选 | 1 | 1 | `investigation-and-improvements.html` |
| 看板已发布版本副本 | 2 | 2 | 同一产物的两个版本 |
| 对应固化发布包中的副本 | 2 | 2 | 与已发布版本重复保存，不增加产物数 |

看板两个版本均归属 `cline-kanban/92093` 的同一产物，不能计作两个任务或两张独立图。扫描还排除了 351 个与 canonical 文档相同的 worktree 副本、12 个相同的交接文档副本及 9 个保存的应用 DOM 页面。

这些分类的项目范围不同，且会话页包含多张卡、备份可能是同图的不同版本，因此不把表格相加当作“生成了多少张图”，也不计算跨类别使用占比。保守候选法不能证明纯图片或无标记 HTML 的历史使用情况。

三个有代表性的真实生成位置是：

- worktree：`d55ee/cline-kanban/docs/research/cross-repository-test-system-assessment/test-system-research-reading-copy.html`。
- 交接目录：`task-1c2da-remaining-performance-investigation/investigation-and-improvements.html`；另有以 `*-card.html`、`*-fragment.html` 保存的内容片段。
- 全局平台：`~/.ai-viz/sessions/session-*.html`。其发布时间、当前文件位置和生成所属任务是不同事实，不能互相代替。

## 为什么会分散

1. 当前安装的 `visualization-platform` 通过 `scripts/lib/runtime-paths.mjs` 固定使用 `~/.ai-viz/`，会话、主题、共享资源分别有自己的子目录；不是 Kanban 在每个 task 中随机选目录。
2. 通用 `task visualization publish` 接受任意已声明的本机 HTML 源路径，只规范发布后的存储和浏览器交付。它不会替 agent 选择生成目录。发布时默认以源绝对路径确定产物身份。
3. 持久交接规则要求产物熬过 worktree 清理或机器重启，agent 因而会把片段、备份和临时说明放到交接目录。片段和完整会话页同时存在可以是必要的编辑输入与输出。
4. 用户需要随代码演进、审阅或提交的 HTML 文档，本就适合留在仓库。上表中研究报告和演示文档不应全部改成仓库外的一次性产物。

另有两项接线问题值得在统一实施时处理：

- 看板注入说明提到技能的自动发布协议，但本机 `~/.codex/skills/visualization-platform` 与 `~/.claude/skills/visualization-platform` 都软链到 `my-ai-setup` 的当前主 checkout；检查到的技能及脚本仍输出 `file://`，没有接入 Kanban 发布。看板支持发布，不等于当前技能已经安装了匹配实现。应先与 `7cae2` 已交付内容核对安装漂移，避免重做托管服务。
- 该脚本的活动会话指针是全局 `.active-session.json`，恢复复用条件包含八小时窗口。源码提示并行任务丢失显式页面路径时可能复用其他会话页；本次没有用用户真实任务复现这个风险，不能把它写成已发生的事故。统一入口时应让恢复寻址包含 workspace、task 和 conversation，而不是仅依赖全局最近页。

## 统一方案比较与推荐

| 方案 | 好处 | 代价与限制 | 建议 |
| --- | --- | --- | --- |
| 只统一看板发布入口 | 已有远端预览、持久版本和统一清单，改动最少 | 可编辑源与恢复指针仍可能分散 | 作为现有基础 |
| 增加按任务/会话分配的默认持久源目录，沿用发布入口 | 归属明确、易找回源、减少 worktree 杂物，并行会话可隔离 | 需同步 Kanban 指令与技能适配，处理共享资源相对路径 | 推荐后续实施 |
| 全量搬迁旧图、项目文档、图库和发布包 | 物理位置看似统一 | 容易破坏相对资源、书签、图库历史、默认路径身份及 Git 审阅 | 不推荐 |

推荐方案的具体边界：

- Kanban 分配持久生成根目录，再按 workspace、task、conversation 隔离；agent 和技能消费返回路径，避免各自猜目录。可采用 `<runtimeHome>/task-visualization-source-files/<workspace>/<task>/<conversation>/` 这一归属形态，最终路径转义由运行时负责。
- 一次性说明图、卡片片段和更新过程的输入默认放在该目录。项目源码文档、显式启用的 `.visualization-library/` 及产品自身的分析报告继续使用项目约定。
- 看板会话统一通过 `publish` / `request-preview` 交付；独立终端继续支持 `~/.ai-viz/` 的本机协议。`awaiting_runtime_acceptance` 继续表示待接受，不能写成发布成功。
- 每个 conversation 保存自己的恢复指针。发布时使用稳定的逻辑产物身份，避免仅因源路径变化就重复建产物；现有路径身份与旧链接保留兼容。
- 第一阶段只约束新产物；旧产物继续读原位置。确需迁移时，显式处理资源引用、内容校验、来源记录和重复发布，另作迁移设计。
- 技能接线属于 `my-ai-setup`，后续应在该仓自己的任务中修改；本仓已有 hosted visualization 能力继续复用。Task `491af` 负责自动署名，目录统一应消费其归属信息。

后续验收应自动覆盖：两个项目的相同 taskId、主/侧会话并行、上下文压缩后恢复寻址、资源离线加载、worktree 删除后可编辑源与发布版本仍在、断线重试不重复发布，以及旧路径可继续查看。
