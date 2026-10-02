# Cross-Project Recently-Active Task Switcher — Domain Language

本 context 收录「跨项目最近活跃任务切换面板」引入的领域术语。它的目的是让人**只开一个浏览器标签页**就能管全部项目：一个 runtime（3484）本来就管着全部项目，但过去只能「一个仓库开一个标签页」，因为左栏、通知、跳转都只认当前项目。

面板是 Focus View 左栏的第二种模式（顶部分段切换 `This project | All projects`），数据来自全局的 `projects_updated` 广播，切项目时不清空。

## Language

**Left Column Task List Scope（左栏列表范围）**：
Focus View 左栏显示什么——`current_project_stage_list`（当前项目的 Pinned + 各 stage 列表）或 `all_projects_recently_active_task_switcher`（本面板）。per-browser 便利项，存 localStorage。
_Avoid_: dashboard, global view

**Cross-Project Task Switcher Entry（切换面板条目）**：
`RuntimeProjectSummary.crossProjectTaskSwitcherEntries` 里的一条，是 Board Overview 的 in_progress 明细的超集，由同一个 per-card 构造函数产出（`src/server/in-progress-task-detail-projection.ts`）。取景判据是 `src/core/cross-project-recently-active-task-switcher-section-assignment.ts` 的 `isTaskCardWithinCrossProjectTaskSwitcherActivityScope`（服务端投影与前端合并共用，不得两边各写一份）：置顶的卡不论哪一列都进；其余只取非 Done 列、且 agent 正持有回合或「最后被碰」在 7 天内的卡。会话事实覆盖三种 transport；未加载项目读 sessions.json（按文件戳缓存，单个可达数 MB）。
_Avoid_: card（它不是 board 卡片，没有 prompt / 动作按钮）

**Pinned（置顶区）**：
各项目 Task Pinboard 的汇总，只有一种 pin（不另设「面板专用 pin」）。**允许**与下面三区重复；点击后打开任务，并把它在下方区里的那一行滚进视野、脉冲高亮。对非当前项目的卡置顶走 runtime 的 `workspace.setTaskPinboardPinStateOfTaskCard`，与浏览器 setBoard 共用 `src/core/task-pinboard-pinning.ts`。

**Running（运行区）**：
`turnOwner === "agent"` 且（近 5 分钟有 PTY 输出，或已 park 在等自己派发的后台工作）。默认收起成一行「Running N」：在跑的任务暂时不需要人。
与 Board Overview 的 **Active In-Progress Task** 用同一个输出窗口判据，但**不按列取**：review 列里被误放、其实还在跑的任务也算 Running。
_Avoid_: In Progress（那是 board 列名，列里允许停着已中断的任务）, active task

**Prompt Cache Warm Awaiting User（缓存倒计时区，UI 名 Cache warm · your turn）**：
轮到用户（`isNotifiableUserTurn`）、且按 agent 的实测 TTL 估算 prompt cache 仍热的任务，按**失效时刻升序**排（最快失效的在最前）。计时起点是本轮停止生成的时刻（`agentResponseGenerationStopped.stoppedAt`），runtime 重启后它被清空，回落到对话上次推进的时刻。Codex / Kimi 的缓存只在同一进程内有效，要求 `liveness === "live"`。**不看是否已读**：读过但没回复的任务，缓存照样在流失。
TTL 表在 `src/core/coding-agent-prompt-cache-retention-measured-ttl-lower-bounds.ts`（2026-10-02 本机实测下限，带 `EXPERIMENT_NODE`）。表里没有的 agent 不进这一区。
_Avoid_: hot tasks, urgent

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
`use-cross-project-task-open-in-project.ts`：同项目直接选中；跨项目先切 workspace，目标 board 加载出该任务后再打开。在途态的收尾决策（选中 / 开 backlog 编辑器 / 提示找不到）一律等 `isCurrentProjectBoardSettled`——快照到达那一帧 board 仍是上一个项目的，taskId 跨项目会撞号；落定在别的项目（导航被其它入口改走、或切换失败回落）即取消在途态。从 Focus View 发起时，在途期间渲染 `FocusViewCrossProjectTaskOpenInTransitShell`，左栏不闪退成看板。Board Overview、Spotlight、切换面板、通知点击（找不到开着目标项目的标签页时）共用这一条路径。

**Cross-Project Ready Notification（跨项目就绪通知）**：
`task_ready_for_review` 投给所有在场客户端，不只是该项目的连接；前端只对**当前项目**按前台可见让位，别的项目照样弹 OS 通知 / 提示音 / 播报。多标签页之间靠 `claimDelivery` 领取（每个 candidate 只有一个客户端领得到）与「有可见标签页正开着该项目」让位去重。连接握手时按全部项目重放最近 60 秒未领取的通知（单标签页切项目会重连 WS）。

## 不在本功能内

- 把列自动流转搬到服务端（修 review / in_progress 的列错位）。面板不读列，与它正交。
- 快捷键弹窗切换器（可复用同一个区归属纯函数）。
- Board Overview 仍按 ADR-0001 按列归属判定成员；它的 in_progress 明细与本面板条目共用同一个 per-card 构造函数与会话事实来源。
