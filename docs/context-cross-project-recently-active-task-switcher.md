# Cross-Project Recently-Active Task Switcher — Domain Language

本 context 收录「跨项目最近活跃任务切换面板」引入的领域术语。它的目的是让人**只开一个浏览器标签页**就能管全部项目：一个 runtime（3484）本来就管着全部项目，但过去只能「一个仓库开一个标签页」，因为左栏、通知、跳转都只认当前项目。

面板是 Focus View 左栏在 **Board Scope** 下的内容：范围由顶栏项目切换器选（表格首行「All projects」= Board Scope，其余行 = 单个项目），左栏不再有自己的范围切换。数据来自全局的 `projects_updated` 广播，切项目时不清空。

## Language

**Selected Board Or Single Project Scope（范围）**：
顶栏项目切换器选中的范围，`board_scope_all_projects`（首行 All projects）或 `single_project_scope`（选了某个项目），只有一份状态（`web-ui/src/hooks/use-selected-board-or-single-project-scope.ts`，App 持有、经宿主 context 下发；react-use 的 localStorage hook 各实例互不同步，不能各处各读）。看板页据此在 Board Overview 与项目看板之间切换，Focus View 左栏据此在本面板与当前项目的 stage 列表之间切换。从面板里跨项目打开任务时范围不变，变的只是当前项目（焦点任务所属的项目，触发按钮显示成「All projects › 项目名」）；只有用户明确选了某个项目（切换器、数字槽热键、首页侧栏、概览里点 stage）才收窄到单项目。旧键 `kanban.focus-view-left-column-task-list-scope.v1` 一次性迁移后删除。
_Avoid_: dashboard, global view, left column scope toggle

**Cross-Project Task Switcher Entry（切换面板条目）**：
`RuntimeProjectSummary.crossProjectTaskSwitcherEntries` 里的一条，是 Board Overview 的 in_progress 明细的超集，由同一个 per-card 构造函数产出（`src/server/in-progress-task-detail-projection.ts`）。取景判据是 `src/core/cross-project-recently-active-task-switcher-section-assignment.ts` 的 `isTaskCardWithinCrossProjectTaskSwitcherActivityScope`（服务端投影与前端合并共用，不得两边各写一份）：置顶的卡不论哪一列都进；其余只取非 Done 列、且 agent 正持有回合或「最后被碰」在 7 天内的卡。会话事实覆盖三种 transport；未加载项目读 sessions.json（按文件戳缓存，单个可达数 MB）。
_Avoid_: card（它不是 board 卡片，没有 prompt / 动作按钮）

**Pinned（置顶区）**：
各项目 Task Pinboard 的汇总，只有一种 pin（不另设「面板专用 pin」）。**允许**与下面三区重复；点击后打开任务，并把它在下方区里的那一行滚进视野、脉冲高亮。可折叠（默认展开，`kanban.cross-project-task-switcher-pinned-section-collapsed.v1`，与 This project 置顶分段各自一个键）。对非当前项目的卡置顶走 runtime 的 `workspace.setTaskPinboardPinStateOfTaskCard`（现已转发到 `taskCardAction.setTaskPinboardPinStateOfTaskCard`；浏览器卡片动作迁到 `taskCardAction.*` 后改直调新入口并删掉旧入口），当前项目的卡仍走浏览器 setBoard，两条路共用 `src/core/task-pinboard-pinning.ts`。

**Running（运行区）**：
`turnOwner === "agent"` 且（近 5 分钟有 PTY 输出，或已 park 在等自己派发的后台工作）。默认收起成一行「Running N」：在跑的任务暂时不需要人。
与 Board Overview 的 **Active In-Progress Task** 用同一个输出窗口判据，但**不按列取**：review 列里被误放、其实还在跑的任务也算 Running。
_Avoid_: In Progress（那是 board 列名，列里允许停着已中断的任务）, active task

**Prompt Cache Warm Awaiting User（缓存倒计时区，UI 名 Cache warm · your turn）**：
agent 没在持有回合、且按 agent 的实测 TTL 估算**主对话** prompt cache 仍热的任务，按**失效时刻升序**排（最快失效的在最前）。**不看是否已读**：读过但没回复的任务，缓存照样在流失。估算在 `estimateMainAgentConversationPromptCacheWarmthForTaskOutsideAgentTurn`：
- 计时起点 = 主对话最后一次向模型发请求的时刻：summary sidecar `lastMainAgentConversationModelRequestDispatchObservation`，由 hooks-api 在「harness 紧接着就会发请求」的 hook（未被恢复守卫拦下的 UserPromptSubmit、主对话的 PostToolUse / PostToolUseFailure，Gemini 的 BeforeAgent / AfterTool）上以 ingest 时刻记下（判据 `main-agent-conversation-model-request-dispatch-hook-event-classification.ts`）。子代理内的事件（hook stdin 带 `agent_id`，2026-10-03 用 Claude Code 2.1.288 实测确认只在子代理事件上出现）不记；用户回合里到来的工具事件（主 agent 已 Stop、后台子代理还在跑）不记，例外是工具调用自己引出的提问 / 计划审批 / 授权答完之后。
- **绝不读 `agentResponseGenerationStopped`**：会话恢复（换 incarnation）也算一次停止边沿，起点会被刷成恢复时刻（2026-10-03 实测三个 Claude 任务显示「18 分钟前」，真实最后请求在 11~21 小时前）。
- Cursor 没有回合类 hook，起点读最近一次实质输出（有恢复重播保护）。还没观测到发请求事件的存量会话回落到高置信的对话推进观测，低置信 TUI 猜测不用。
- 资格按缓存所在位置分：服务端缓存（Claude / Cursor）只要求 `turnOwner !== "agent"`，runtime 重启、会话被回收后照样在区内；同进程缓存（Codex / Kimi）要求 `liveness === "live"` 且起点不早于当前进程的启动时刻，恢复出来的新进程不算。
- 倒计时药丸的 tooltip 写明起点的绝对时间与来源。
- 已知残余：会话恢复后到 idle_stall 之前（约 1.5 分钟）facet 是 agent 回合，这段时间任务显示在 Running 区。
TTL 表在 `src/core/coding-agent-prompt-cache-retention-measured-ttl-lower-bounds.ts`（2026-10-02 本机实测下限，带 `EXPERIMENT_NODE`）。表里没有的 agent 不进这一区。
_Avoid_: hot tasks, urgent

**Row（面板行）**：
紧凑行：第 1 行状态点 / agent 图标 / 标题（+ 倒计时药丸），第 2 行项目名 / stage 标签（仅置顶区）与三颗时长药丸（创建、停止生成、对话推进，与卡片同源），置顶区另有第 3 行置顶理由。元信息行 `flex-wrap`：窄宽度下药丸整组折到下一行，不截断、不挑着显示。

**Remaining Section（剩余区，UI 名 Recent）**：
不在 Running、也不在缓存倒计时区的其余条目，三种排序模式可切（per-browser）：
- `most_recently_touched_by_conversation_progress_or_user_open_or_description_edit`（默认）：max(对话推进, 我最后打开, Description 编辑)。刻意不用 `card.updatedAt`——列自动流转移列也会推进它。
- `unread_handoffs_then_recently_opened_by_user`：未读交接 + 我最近打开（约 10 条）两个子区。
- `most_recent_conversation_progress_only`：只按对话推进。
默认 7 天窗；「Show older」按需查询 30 天窗（`projects.listCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizon`，不进广播）。快照只补广播取景范围**之外**的旧任务：落在取景范围内却不在广播里的快照条目已失效（取消置顶 / 移入 Done / 已删除），不补回；扩展期间随面板 30 秒 tick 重新拉取快照，范围外任务的变化在一个 tick 内收敛。

**Section Exclusivity（三区互斥）**：
Running / 缓存倒计时 / 剩余三区互斥，优先级 Running > 缓存倒计时 > 剩余。区归属**只读 session facet 与时间戳，不读 board 列**（唯一例外是排除 Done）：列自动流转只在打开着该项目的浏览器里跑，没人看的项目列会滞后。回合一交出，`turnOwner` 就翻转，任务在同一帧从 Running 进入缓存倒计时区。区归属是纯函数（`src/core/cross-project-recently-active-task-switcher-section-assignment.ts`），前端每 30 秒按 now 重算。

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

**Cross-Project Ready Notification（跨项目就绪通知）**：
`task_ready_for_review` 投给所有在场客户端，不只是该项目的连接；前端只对**当前项目**按前台可见让位，别的项目照样弹 OS 通知 / 提示音 / 播报。多标签页之间靠 `claimDelivery` 领取（每个 candidate 只有一个客户端领得到）与「有可见标签页正开着该项目」让位去重。连接握手时按全部项目重放最近 60 秒未领取的通知（单标签页切项目会重连 WS）。

## 不在本功能内

- 把列自动流转搬到服务端（修 review / in_progress 的列错位）。面板不读列，与它正交。
- 快捷键弹窗切换器（可复用同一个区归属纯函数）。
- Board Overview 仍按 ADR-0001 按列归属判定成员；它的 in_progress 明细与本面板条目共用同一个 per-card 构造函数与会话事实来源。
