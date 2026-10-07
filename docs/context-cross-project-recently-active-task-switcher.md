# Cross-Project Recently-Active Task Switcher — Domain Language

本 context 收录「跨项目最近活跃任务切换面板」引入的领域术语。它的目的是让人**只开一个浏览器标签页**就能管全部项目：一个 runtime（3484）本来就管着全部项目，但过去只能「一个仓库开一个标签页」，因为左栏、通知、跳转都只认当前项目。

面板是 Focus View 左栏在 **Board Scope** 下的内容：范围由顶栏项目切换器选（表格首行「All projects」= Board Scope，其余行 = 单个项目），左栏不再有自己的范围切换。数据来自全局的 `projects_updated` 广播，切项目时不清空。

## Language

**Selected Board Or Single Project Scope（范围）**：
顶栏项目切换器选中的范围，`board_scope_all_projects`（首行 All projects）或 `single_project_scope`（选了某个项目），只有一份状态（`web-ui/src/hooks/use-selected-board-or-single-project-scope.ts`，App 持有、经宿主 context 下发）。看板页据此在 Board Overview 与项目看板之间切换，Focus View 左栏据此在本面板与当前项目的 stage 列表之间切换。从面板里跨项目打开任务时范围不变，变的只是当前项目（焦点任务所属的项目，触发按钮后面接一个「› 项目名」按钮）；只有用户明确选了某个项目才收窄到单项目：切换器、数字槽热键（Board Scope 下按到当前项目也收窄，不是 no-op）、首页侧栏、概览里点 stage、点「› 项目名」、或 `⌘E`。旧键 `kanban.focus-view-left-column-task-list-scope.v1` 一次性迁移后删除。
- **每个标签页各存一份**（2026-10-05）：实际范围存 sessionStorage（重载、Chrome 丢弃后恢复都保留），localStorage 同名键只是新开标签页的默认值。共用 localStorage 时，重载会让每个标签页继承「最后写入者」的范围，多标签页下表现为「没操作就跳了」。
- **`⌘E`（非 mac 为 Ctrl+E）**：Board Scope ⇄ 焦点任务所属项目（看板页没有焦点任务时是当前项目）。选它的理由：左手单手可按、不与本应用及 Chrome / macOS 的常用键重合；mac 上终端不吃 ⌘ 组合。非 mac 的 Ctrl+E 会盖掉终端 readline 的「行尾」，与 mod+j / k / g 同样处理。对话框开着时不响应。备选 `mod+shift+e`（`EXPERIMENT_NODE`）。
- **探测范围**：范围决定状态流要哪些任务的 git 元数据，见下方 **Workspace Metadata Probe Scope**。
_Avoid_: dashboard, global view, left column scope toggle

**Cross-Project Task Switcher Entry（切换面板条目）**：
`RuntimeProjectSummary.crossProjectTaskSwitcherEntries` 里的一条，是 Board Overview 的 in_progress 明细的超集，由同一个 per-card 构造函数产出（`src/server/in-progress-task-detail-projection.ts`）。取景判据是 `src/core/cross-project-recently-active-task-switcher-section-assignment.ts` 的 `isTaskCardWithinCrossProjectTaskSwitcherActivityScope`（服务端投影与前端合并共用，不得两边各写一份）：置顶的卡不论哪一列都进；其余只取非 Done 列、且 agent 正持有回合或「最后被碰」在 7 天内的卡。会话事实覆盖三种 transport；未加载项目读 sessions.json（按文件戳缓存，单个可达数 MB）。
_Avoid_: card（它不是 board 卡片，没有 prompt / 动作按钮）

**Pinned（置顶区）**：
各项目 Task Pinboard 的汇总，只有一种 pin（不另设「面板专用 pin」）。**允许**与下面三区重复；点击后打开任务，并把它在下方区里的那一行滚进视野、脉冲高亮。可折叠（默认展开，`kanban.cross-project-task-switcher-pinned-section-collapsed.v1`，与 This project 置顶分段各自一个键）。置顶 / 取消置顶 / 改原因一律走 `taskCardAction.setTaskPinboardPinStateOfTaskCard`：当前项目的卡由宿主弹原因对话框、带 overlay；其他项目的卡由面板弹同一个对话框、不带 overlay（结果随广播回来）。

**Running（运行区）**：
`turnOwner === "agent"` 且（近 5 分钟有 PTY 输出，或已 park 在等自己派发的后台工作）。默认收起成一行「Running N」：在跑的任务暂时不需要人。
与 Board Overview 的 **Active In-Progress Task** 用同一个输出窗口判据，但**不按列取**：review 列里被误放、其实还在跑的任务也算 Running。
排序：按**本轮 agent 回合开始时刻升序**（先进入的在前、后进入的在后；summary sidecar `agentResponseGenerationTurnStarted`，在 `mergeSummaryWithFacets` 的「非 agent → agent」边沿上盖章，与 `agentResponseGenerationStopped` 对偶）。缺字段时回落到 agent 进程启动时刻，再缺排到末尾；同一时刻按 (workspaceId, taskId) 兜底。比较器 `compareRunningSectionEntriesByCurrentAgentTurnStartAscendingThenStableKey`，Board Overview 的 Active 组共用同一工厂。**绝不按 `lastOutputAt` 排**：spinner 每次重绘都推进它，2026-10-04 在 3484 上实测成员不变的相邻样本 30/38 次顺序变了（用户报为闪烁）。
- 离开 Running 再回来的位置：交出回合（Stop、权限 / 提问 / 计划审批、idle_stall）后再进入 agent 回合是新边沿，排到**末尾**（`EXPERIMENT_NODE`：模态决策往返后是否保留原位）；同一 agent 回合内 5 分钟无输出掉出、输出恢复后回来，没有新边沿，回到原相对位置；park 期间仍在 Running，位置不变。
_Avoid_: In Progress（那是 board 列名，列里允许停着已中断的任务）, active task

**Prompt Cache Warm Awaiting User（缓存倒计时区，UI 名 Cache warm · your turn）**：
agent 没在持有回合、且按 agent 的实测 TTL 估算**主对话** prompt cache 仍热的任务，按**失效时刻升序**排（最快失效的在最前）。**不看是否已读**：读过但没回复的任务，缓存照样在流失。估算在 `estimateMainAgentConversationPromptCacheWarmthForTaskOutsideAgentTurn`：
- 计时起点 = 主对话最后一次向模型发请求的时刻：summary sidecar `lastMainAgentConversationModelRequestDispatchObservation`，由 hooks-api 在「harness 紧接着就会发请求」的 hook（未被恢复守卫拦下的 UserPromptSubmit、主对话的 PostToolUse / PostToolUseFailure，Gemini 的 BeforeAgent / AfterTool）上以 ingest 时刻记下（判据 `main-agent-conversation-model-request-dispatch-hook-event-classification.ts`）。子代理内的事件（hook stdin 带 `agent_id`，2026-10-03 用 Claude Code 2.1.288 实测确认只在子代理事件上出现）不记；用户回合里到来的工具事件（主 agent 已 Stop、后台子代理还在跑）不记，例外是工具调用自己引出的提问 / 计划审批 / 授权答完之后。
- **绝不读 `agentResponseGenerationStopped`**：会话恢复（换 incarnation）也算一次停止边沿，起点会被刷成恢复时刻（2026-10-03 实测三个 Claude 任务显示「18 分钟前」，真实最后请求在 11~21 小时前）。
- Cursor 没有回合类 hook，起点读最近一次实质输出（有恢复重播保护）。其余 agent 没有发请求观测时不进 Cache warm 区；对话推进观测只参与剩余区排序。
- 列资格：只收 **In progress / Review** 列（`isTaskCardBoardColumnEligibleForPromptCacheWarmAwaitingUserSection`）。已移入 Validation 的任务即使缓存仍热也下放到剩余区，由剩余区的排序模式与时间窗决定显不显示（2026-10-04 用户反馈：移入 Validation / Done 就是不打算再接这一轮对话）；Done 本来就在分区前排除。Validation 里 agent 正在干活照样进 Running，置顶照样在 Pinned。
- 资格按缓存所在位置分：服务端缓存（Claude / Cursor）只要求 `turnOwner !== "agent"`，runtime 重启、会话被回收后照样在区内；同进程缓存（Codex / Kimi）要求 `liveness === "live"` 且起点不早于当前进程的启动时刻，恢复出来的新进程不算。
- 倒计时药丸的 tooltip 写明起点的绝对时间与来源。
- **压缩**（2026-10-05 用户拍板 B′）：Claude / Codex / Kimi 的 `PostCompact` 经专用 hook 事件 `main_agent_conversation_context_compaction_completed` 推进起点（不复用 `activity`，故不推进对话推进、不进通知捕获；Codex 刻意不用 SessionStart(compact)，它要等到下一次请求前才触发）。
  - 自动压缩（agent 回合中，`trigger=auto`）：续写请求紧随其后，按普通发请求计。
  - 手动 `/compact`（用户回合）：任务**留在区内但不显示倒计时**，行上显示「Compacted」，tooltip 写明压缩时刻与「下一条回复要重写压缩后的上下文」。理由（ccflare 逐请求实测）：压缩请求只按 5 分钟档读了被替换前的旧前缀、写入为 0；压缩后下一条请求不论早晚都要重写 86k–103k，只有 system + 项目上下文层（34k–47k）还能命中。留区时长按该 agent 的 TTL 下界（`EXPERIMENT_NODE`：A 续期 / B 退出 / B′ 留区、以及留区时长）。下一次真实请求后恢复普通倒计时。
  - 「回复需重写约 N k」只在 harness 自己报了压缩后大小时显示（目前只有 Kimi 的 `estimatedTokenCount`，载荷拼写未经真机核对）。Claude / Codex 不报，按摘要长度或 transcript 内容估算与实测相差 3–10 倍，故不造数字。
  - 残余：Cursor 没有 postCompact（它的起点读 TUI 实质输出，压缩时是否推进未验证）；子代理自己的自动压缩带 `agent_id`，不记；omp / Cline 没有压缩事件，也不在 TTL 表里。
- 已知残余：会话恢复后到 idle_stall 之前（2026-10-04 实测 12 秒到约 80 秒）facet 是 agent 回合，这段时间任务显示在 Running 区（排在末尾，不扰动别的行）。部署重启自动续跑、点终端的重启按钮、从 Done 恢复都会触发。修法要动 Claude / Kimi / Codex 共用的 prompt-ready 状态机，另起任务。
TTL 表在 `src/core/coding-agent-prompt-cache-retention-measured-ttl-lower-bounds.ts`（2026-10-02 本机实测下限，带 `EXPERIMENT_NODE`）。表里没有的 agent 不进这一区。
_Avoid_: hot tasks, urgent

**Row（面板行）**：
紧凑行：第 1 行状态点 / agent 图标 / 标题（+ 倒计时药丸），第 2 行项目名 / stage 标签（仅置顶区）与三颗时长药丸（创建、停止生成、对话推进，与卡片同源），置顶区另有第 3 行置顶理由。元信息行 `flex-wrap`：窄宽度下药丸整组折到下一行，不截断、不挑着显示。
元信息行还显示 worktree 的 git 元数据（2026-10-05 用户要求，与 This project 卡片目录行同一套显隐规则）：相对 base 分支的 ahead / behind 与已集成提交数，以及未提交改动「(N files +A -D)」。Backlog 不显示；没有可说的提交关系、且未提交改动全为 0 时整组隐藏。取数唯一入口 `useTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntry`：
- 当前项目的精简行与完整卡（hover / Keep open）：优先读 `workspace_metadata_updated` 推流 store；Board Scope 下推流只探焦点任务与 auto-review 的 Review 列任务，其余任务在推流里没有数据，回落到下面的轮询 store。完整卡由展开宿主显式传入项目 ID，普通看板卡继续只订阅推流。
- 全部非 Backlog 的行（含当前项目）：面板挂载且页面可见时，每 5 秒（`EXPERIMENT_NODE`）轮询 `projects.readTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries`（每次最多 100 条），结果进按 (workspaceId, taskId) 复合键的 store。服务端 `cross-project-task-worktree-git-metadata-cache.ts` 按键缓存，复用 `workspace-metadata-monitor` 的同一个探针（`src/workspace/task-worktree-git-metadata-probe.ts`）：fs-stat 门控、10 秒兜底、全局 git spawn 并发上限 4、同键单飞、base tip 每次请求每项目每 baseRef 只解析一次，5 分钟没被请求的键淘汰。baseRef / worktreeMode 以服务端 board 为准，不信任客户端。
- 不并入 `projects_updated`：未提交改动在 agent 写文件时几秒一变，会让 100 KB 级的整份广播变频繁。

**Full Task Card Hover Overlay / Keep Open（hover 浮层与 Keep open）**：
2026-10-05 起取代原来的 chevron 展开（chevron 常驻占位、在 title 前留白边；展开后在精简行下方再画一张完整卡，内容重复）。
- hover 一行约 350ms（`EXPERIMENT_NODE`），与 This project 同一个紧凑 `TaskCardBody` 以浮层盖在该行原位（同左沿、同宽，portal 到 body，靠近视口底部时向上翻），不推挤下方的行；离开约 150ms 收起，指针可以移进浮层点动作；Esc、滚动、点浮层以外都收起。触屏没有 hover，改用长按约 500ms，抬手那一下的点击被吞掉、不会打开任务。hover 意图期间浮层已隐形挂载，借此预取其他项目的卡；每张卡上一次读到的快照留在内存里，再 hover 时先显示它再刷新。
- 浮层上方一条显示项目名、未读交接圆点、Cache warm 药丸（完整卡片本身不显示这些），以及「**Keep open**」（tooltip「Keep this task open in the list」）。点了之后这一行在列表里**原地换成**完整卡片（推挤下方的行，用户主动触发所以可以接受），可以同时固定多张；固定后那一条的按钮变成「Collapse」，已固定的卡不再弹浮层。不叫 Pin：Pin 是 Pinboard 的专名。
- 固定状态按任务记（Pinned 与下方区同一个任务一起换），存在 `cross-project-task-switcher-panel-view-continuity-store`（字段 `crossProjectTaskSwitcherEntryKeysKeptOpenAsFullTaskCardByUser`）：过渡外壳重挂载时保留，按标签页隔离，刷新即清，不进 localStorage。
- 卡体渲染角色 `expanded_card_copy_in_cross_project_task_switcher_row`：不可拖、不持有 `data-task-id`，交互与本体一致。门控同 This project（`buildTaskCardBusinessProps`）。
- 残余：键盘用户还没有打开浮层 / Keep open 的入口（原 chevron 可以 Tab 到）。
- 当前项目：直接用 Focus View 左栏手里的数据与动作（带 overlay 的 board、推流 session、同一套 handler），与 This project 那张卡逐字一致。
- 其他项目：按需只读 `taskCardAction.readTaskCardWithBoardColumn`，条目变了去抖重读（重读期间保留上一份）。卡体经 `taskCardOwnedByOtherProjectWorkspaceId` 不读只按 taskId 分键的当前项目 store（git 元数据改读上面的跨项目轮询 store；资源占用与排队 prompt 只对当前项目推流，不显示）。动作调同一组 `taskCardAction.*` 命令、同样的删除 / 跳过 Validation 确认框，不带 overlay、不切项目，期间显示在途 spinner（`use-task-card-action-handlers-for-other-project-cards-in-cross-project-task-switcher.tsx`）。

**Backlog Row In-Place Edit（backlog 行原地编辑）**：
点 backlog 行（问题 5）在 Focus View 之上原地打开那张卡的编辑对话框，不切项目、焦点任务不动，与 This project 点 backlog 卡同语义（`use-backlog-task-editor-opening-in-any-project.ts`）。其他项目的卡：草稿按那个项目记，分支列表只读那个项目的 `workspace.getState`，保存只发改过的字段、不带 overlay，Save & Start 直接对那个项目发启动命令；对话框显示只读的「Project」标签。

**Create Task In Board Scope（Board Scope 建卡）**：
面板顶部「Create task (c)」、热键 `c`、Board Overview 的「New task」打开带目标项目字段的建卡框（**Task Creation Target Project**，见 `docs/context-stage-first-overview.md`），默认上下文项目，往别的项目建卡不切项目、弹提示，新卡随广播出现在面板里。

**Remaining Section（剩余区，UI 名 Recent）**：
不在 Running、也不在缓存倒计时区的其余条目，三种排序模式可切（per-browser）：
- `most_recently_touched_by_conversation_progress_or_user_open_or_description_edit`（默认）：max(对话推进, 我最后打开, Description 编辑)。刻意不用 `card.updatedAt`——列自动流转移列也会推进它。
- `unread_handoffs_then_recently_opened_by_user`：未读交接 + 我最近打开（约 10 条）两个子区。
- `most_recent_conversation_progress_only`：只按对话推进。
默认 7 天窗；「Show older」按需查询 30 天窗（`projects.listCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizon`，不进广播）。快照只补广播取景范围**之外**的旧任务：落在取景范围内却不在广播里的快照条目已失效（取消置顶 / 移入 Done / 已删除），不补回；扩展期间随面板 30 秒 tick 重新拉取快照，范围外任务的变化在一个 tick 内收敛。

**Section Exclusivity（三区互斥）**：
Running / 缓存倒计时 / 剩余三区互斥，优先级 Running > 缓存倒计时 > 剩余。区归属**只读 session facet 与时间戳，不读 board 列**（例外两处：排除 Done；Validation 不进缓存倒计时区）：列自动流转只在打开着该项目的浏览器里跑，没人看的项目列会滞后。回合一交出，`turnOwner` 就翻转，任务在同一帧从 Running 进入缓存倒计时区。区归属是纯函数（`src/core/cross-project-recently-active-task-switcher-section-assignment.ts`），前端每 30 秒按 now 重算。

**Unread Handoff（未读交接）**：
通知中心里该 (workspaceId, taskId) 还有 `visitedAt` 为空的条目，与铃铛同源。三种模式下都用圆点标出。

**Last Opened By User（我最后打开）**：
用户最近一次在任一浏览器 origin 里打开该任务的时刻，记在 runtime（`task-last-opened-by-user-records.json`，每个 workspace 一个），因为 127.0.0.1 / localhost / Tailscale 是不同 origin，localStorage 不共享。只在 board 已是当前项目的完整快照时记——taskId 跨项目会撞号。

**In-Place Cross-Project Task Open（原地跨项目打开）**：
`use-cross-project-task-open-in-project.ts`：同项目直接选中；跨项目先切 workspace，目标 board 加载出该任务后再打开。在途态的收尾决策（选中 / 开 backlog 编辑器 / 提示找不到）一律等 `isCurrentProjectBoardSettled`——快照到达那一帧 board 仍是上一个项目的，taskId 跨项目会撞号；落定在别的项目（导航被其它入口改走、或切换失败回落）即取消在途态。Board Overview、Spotlight、切换面板、通知点击（找不到开着目标项目的标签页时）共用这一条路径。

从 Focus View 发起时（2026-10-03 修掉「整屏闪烁 + 偶发终端白屏」之后的约束）：
- 在途**全程**只渲染过渡外壳 `FocusViewCrossProjectTaskOpenInTransitShell`，不渲染详情页；顶栏保持详情模式（不出现首页侧栏、看板不挂载，项目相关的顶栏动作与路径隐藏）。一次打开的帧序列是「旧详情 → 外壳 → 新详情」，e2e 逐帧断言过没有任何一帧露出看板。外壳左栏就是本面板，滚动位置 / 展开全部置顶 / 「显示更早」快照经 `cross-project-task-switcher-panel-view-continuity-store` 跨重挂载接上。
- 详情页（含 agent 终端）只在 board 装的确实是当前项目的数据时挂载（`useWorkspaceSync` 的 `projectIdOwningHydratedBoard`）：快照到达那一帧 `currentProjectId` 已换、board 还是旧的，拿旧卡配新 workspaceId 挂终端会在新项目里给同号任务建出幽灵终端，还可能把终端 LRU 里新项目已停放的热终端挤掉。
- 换项目时 sessions 以新快照为底**整体替换**，不与上一个项目合并（同号任务的旧摘要会残留、让终端误判会话重启清屏）；新项目已推来的摘要按原件带回。终端因会话重启清屏后立即向服务端 mirror 重拉快照，不再出现清完不补的永久白屏。
- 外壳上的 Cancel 回到**发起时打开着的任务**（快照未到时撤销在途切换，已切过去则反向打开）；在途期间点当前项目的任务同样先撤销在途切换。`handleSelectProject` 选回当前项目 = 撤销在途切换。

**Workspace Metadata Probe Scope（git 元数据探测范围）**：
2026-10-05 用户观察：All projects 里打开其他项目的任务要等很久。成因：服务端发快照前要等目标项目**每张非 backlog 卡**（含 Done）的 git 元数据首轮刷新跑完（每卡 5 条 git、全局并发 4，cline-kanban 224 个 worktree 约 6.5 秒），且最后一个连接断开时缓存直接删掉，单标签页切回来必然全量冷探。修法（用户提议）：Board Scope 下屏幕上只有焦点任务要逐卡 git 状态，就只探它。
- 每个状态流连接声明范围（`src/core/runtime-state-stream-workspace-metadata-probe-scope-declaration.ts` 组装，浏览器与服务端共用）：单项目范围 = 整个项目；Board Scope = 焦点任务（跨项目打开在途时是目标任务）。服务端自己并上 Review 列开了 auto-review 的卡（自动提交 / 自动 PR 要看它们有没有未提交改动）。不声明的旧客户端按整个项目。
- 初值在 WS URL 参数 `workspaceMetadataProbeScope`（JSON）里，首轮探测就只探它；之后经浏览器 → 服务端消息 `declare_workspace_metadata_probe_scope` 更新（状态流里唯一一种上行消息），不阻塞、探完照常推 `workspace_metadata_updated`。跨项目打开在切项目**之前**同步登记目标任务（`workspace-metadata-probe-scope-declaration-inputs-of-browser-tab-store`），所以新连接的 URL 已带上它。握手期间到达的声明在注册进广播名单之后才补探，否则补探的推送到不了这个连接。
- 同一项目多个连接取并集，任一要整个项目就探整个项目；快照只放范围内的任务。范围外仍跟踪的任务保留上次的结果，`⌘E` 收窄到单项目时补探整个项目，没变的 worktree 只需一条 `git status` 复核。
- 最后一个连接断开后缓存保留 5 分钟（`EXPERIMENT_NODE`）、期间不轮询，切回来不必全量冷探。
- 代价：落地检测（`refreshTaskCommitIntegrationProvenance`）挂在同一个探针上，Board Scope 下没被探的卡要等它被看到（面板轮询或切到单项目）才更新，与其他项目现状一致。

**Cross-Project Ready Notification（跨项目就绪通知）**：
`task_ready_for_review` 投给所有在场客户端，不只是该项目的连接；前端只对**当前项目**按前台可见让位，别的项目照样弹 OS 通知 / 提示音 / 播报。多标签页之间靠 `claimDelivery` 领取（每个 candidate 只有一个客户端领得到）与「有可见标签页正开着该项目」让位去重。连接握手时按全部项目重放最近 60 秒未领取的通知（单标签页切项目会重连 WS）。
- 应用内通知点击别的项目的任务：SW 先找开着目标项目的标签页并尝试聚焦；浏览器不许页面切标签页（当前 Chromium 的常态）时**不再**把选中消息投给后台的那个标签页，改由发起页原地打开（2026-10-05：后台标签页自己跳进 Focus View 是「没操作就跳了」的成因之一）。旧 SW 还会回 `task-selected-in-background-tab`，页面照旧弹 toast。

## 不在本功能内

- 把列自动流转搬到服务端（修 review / in_progress 的列错位）。面板不读列，与它正交。
- 快捷键弹窗切换器（可复用同一个区归属纯函数）。
- Board Overview 仍按 ADR-0001 按列归属判定成员；它的 in_progress 明细与本面板条目共用同一个 per-card 构造函数与会话事实来源。


### 2026-10-07：单项目首帧与终端预热（54602）

- 单项目、All projects 均先以缓存或空元数据发送 `snapshot`，再登记 workspace 广播订阅并启动 git 刷新；首轮结果经 `workspace_metadata_updated` 补推。缓存直到通知读取结束、发帧前才读取，避免这段等待期间的元数据更新被漏掉。空缓存不代表没有任务；Done 的持久元数据投影照常保留。
- 跨项目打开进入在途态时，用已有只读卡片 API 查询会话；仅已有且明示为 PTY 的会话预热终端。完整目标 board 水合之前仍只显示过渡外壳。隐藏预热禁止输入、粘贴与自动续跑，直到可见挂载才释放；画面重同步对该次恢复的续跑抑制也保留到挂载之后。终端键仍为 workspace + task，上限仍是 2 个 parked 终端。取消导航后迟到的查询不会创建终端。
- 独立实验未采纳整板 HTTP 去重和只读详情预览：均未达到约定的 100ms p50 收益门槛。provenance 相同内容免写已由共享 `locked-file-system` 实现，未重复添加；git 插队与 Done 首轮延后也不再是首帧等待的解法。
