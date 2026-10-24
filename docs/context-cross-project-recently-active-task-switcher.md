# Cross-Project Recently-Active Task Switcher — Domain Language

本 context 收录「跨项目最近活跃任务切换面板」引入的领域术语。它的目的是让人**只开一个浏览器标签页**就能管全部项目：一个 runtime（3484）本来就管着全部项目，但过去只能「一个仓库开一个标签页」，因为左栏、通知、跳转都只认当前项目。

面板是 Focus View 左栏在 **Board Scope** 下的内容：范围由顶栏项目切换器选（表格首行「All projects」= Board Scope，其余行 = 单个项目），左栏不再有自己的范围切换。数据来自全局的 `projects_updated` 广播，切项目时不清空。同一组分区在 Board Scope 的首页横排成列（见下方 **Board Scope Home Page Section Columns**）。

## Language

**Adjacent Task Keyboard Navigation（相邻任务快捷键）**：
Focus View 的 `Option/Alt + ↑/↓` 在 All projects 下按左栏 Pinned → Running → Cache warm → Recent 的显示顺序跨项目循环切换；折叠、筛选及「显示更多」隐藏的行不参与，滚出视口的行仍参与。Backlog 打开的是编辑器，不参与详情切换。任务身份同时包含 workspaceId 和 taskId；置顶副本不额外占位，优先采用可见主分组行的位置。当前任务因折叠而保留的定位行仍可作为导航起点，分组外顶部焦点区向下进首项、向上进末项。

按住 Option 连续切换期间，Recent 的显示与导航顺序一起锁定，内容和打开时间照常更新；新项追加到末尾，失效项立即移除。松开 Option、失焦、页面隐藏、退出 Focus View、切换范围或改变排序/筛选后恢复实时排序。导航所有者常驻 App，跨项目加载期间以在途目标为当前位置，不依赖详情组件是否挂载。单项目范围保留当前阶段列内的原有循环顺序。

**Selected Board Or Single Project Scope（范围）**：
顶栏项目切换器选中的范围，`board_scope_all_projects`（首行 All projects）或 `single_project_scope`（选了某个项目），只有一份状态（`web-ui/src/hooks/use-selected-board-or-single-project-scope.ts`，App 持有、经宿主 context 下发）。看板页据此在 All projects 首页（分区列看板）与项目看板之间切换，Focus View 左栏据此在本面板与当前项目的 stage 列表之间切换。从面板里跨项目打开任务时范围不变，变的只是当前项目（焦点任务所属的项目，触发按钮后面接一个「› 项目名」按钮）；只有用户明确选了某个项目才收窄到单项目：切换器、数字槽热键（Board Scope 下按到当前项目也收窄，不是 no-op）、首页侧栏、点「› 项目名」、`⌘⇧E` 或顶栏 Layers 按钮（与 `⌘⇧E` 同一个处理器）。旧键 `kanban.focus-view-left-column-task-list-scope.v1` 一次性迁移后删除。
- **每个标签页各存一份**（2026-10-05）：实际范围存 sessionStorage（重载、Chrome 丢弃后恢复都保留），localStorage 同名键只是新开标签页的默认值。共用 localStorage 时，重载会让每个标签页继承「最后写入者」的范围，多标签页下表现为「没操作就跳了」。
- **`⌘⇧E`（非 mac 为 Ctrl+Shift+E）**：Board Scope ⇄ 焦点任务所属项目（看板页没有焦点任务时是当前项目）。精确匹配平台修饰键，保留 Ctrl+E 的原生行尾移动。捕获阶段接管新组合，终端有焦点时也能切换且不向 agent 发送字符；长按只切换一次。对话框内或没有可切换项目时不响应、不吞键。
- **探测范围**：范围决定状态流要哪些任务的 git 元数据，见下方 **Workspace Metadata Probe Scope**。
_Avoid_: dashboard, global view, left column scope toggle

**Cross-Project Task Switcher Entry（切换面板条目）**：
`RuntimeProjectSummary.crossProjectTaskSwitcherEntries` 里的一条，是 `inProgressTaskDetails`（in_progress 列明细，现只供顶栏切换器的 live 计数）的超集，由同一个 per-card 构造函数产出（`src/server/in-progress-task-detail-projection.ts`）。取景判据是 `src/core/cross-project-recently-active-task-switcher-section-assignment.ts` 的 `isTaskCardWithinCrossProjectTaskSwitcherActivityScope`（服务端投影与前端合并共用，不得两边各写一份）：置顶的卡不论哪一列都进；agent 正持有回合的卡进入以供 Running 判定；其余阶段（含 Backlog / Validation / Done）统一按最近触达截取近 7 天，不使用停止生成时刻扩展范围。会话事实覆盖三种 transport；未加载项目读 sessions.json（按文件戳缓存，单个可达数 MB）。
_Avoid_: card（它不是 board 卡片，没有 prompt / 动作按钮）

**Pinned（置顶区）**：
各项目 Task Pinboard 的汇总，只有一种 pin（不另设「面板专用 pin」）。**允许**与下面三区重复；点击后打开任务，并把它在下方区里的那一行滚进视野、脉冲高亮。可折叠（默认展开，`kanban.cross-project-task-switcher-pinned-section-collapsed.v1`，与 This project 置顶分段各自一个键）。置顶 / 取消置顶 / 改原因一律走 `taskCardAction.setTaskPinboardPinStateOfTaskCard`：当前项目的卡由宿主弹原因对话框、带 overlay；其他项目的卡由面板弹同一个对话框、不带 overlay（结果随广播回来）。

**Running（运行区）**：
`turnOwner === "agent"` 且（`liveness` 为 `live` / `retrying`，或已 park 在等自己派发的后台工作）。默认收起成一行「Running N」：当前回合尚未结束的任务暂时不需要人。真实重连继续留在区内，精简行显示「重连中」。
判据不读取 PTY 输出新鲜度，也不按列取：Review / Validation 中实际仍由 Agent 持有的存活回合同样进入 Running。
排序：按**本轮 agent 回合开始时刻升序**（先进入的在前、后进入的在后；summary sidecar `agentResponseGenerationTurnStarted`，在 `mergeSummaryWithFacets` 的「非 agent → agent」边沿上盖章，与 `agentResponseGenerationStopped` 对偶）。缺字段时回落到 agent 进程启动时刻，再缺排到末尾；同一时刻按 (workspaceId, taskId) 兜底。比较器 `compareRunningSectionEntriesByCurrentAgentTurnStartAscendingThenStableKey`（由 `createComparatorByCurrentAgentTurnStartAscendingThenStableKey` 工厂产出）。**绝不按 `lastOutputAt` 排**：spinner 每次重绘都推进它，2026-10-04 在 3484 上实测成员不变的相邻样本 30/38 次顺序变了（用户报为闪烁）。
- 离开 Running 再回来的位置：交出回合（Stop、权限 / 提问 / 计划审批、idle_stall）后再进入 Agent 回合是新边沿，排到**末尾**（`EXPERIMENT_NODE`：模态决策往返后是否保留原位）；同一回合内的静默、`live ↔ retrying` 和 park 均保留原相对位置。
_Avoid_: In Progress（那是 board 列名，列里允许停着已中断的任务）, active task

**Prompt Cache Warm Awaiting User（缓存倒计时区，UI 名 Cache warm · your turn）**：
agent 没在持有回合、且按 agent 的实测 TTL 估算**主对话** prompt cache 仍热的任务，按**失效时刻升序**排（最快失效的在最前）。**不看是否已读**：读过但没回复的任务，缓存照样在流失。估算在 `estimateMainAgentConversationPromptCacheWarmthForTaskOutsideAgentTurn`：
- 计时起点 = 主对话最后一次向模型发请求的时刻：summary sidecar `lastMainAgentConversationModelRequestDispatchObservation`，由 hooks-api 在「harness 紧接着就会发请求」的 hook（未被恢复守卫拦下的 UserPromptSubmit、主对话的 PostToolUse / PostToolUseFailure，Gemini 的 BeforeAgent / AfterTool）上以 ingest 时刻记下（判据 `main-agent-conversation-model-request-dispatch-hook-event-classification.ts`）。子代理内的事件（hook stdin 带 `agent_id`，2026-10-03 用 Claude Code 2.1.288 实测确认只在子代理事件上出现）不记；用户回合里到来的工具事件（主 agent 已 Stop、后台子代理还在跑）不记，例外是工具调用自己引出的提问 / 计划审批 / 授权答完之后。
- **绝不读 `agentResponseGenerationStopped`**：会话恢复（换 incarnation）也算一次停止边沿，起点会被刷成恢复时刻（2026-10-03 实测三个 Claude 任务显示「18 分钟前」，真实最后请求在 11~21 小时前）。
- Cursor 没有回合类 hook，起点读最近一次实质输出（有恢复重播保护）。其余 agent 没有发请求观测时不进 Cache warm 区；对话推进观测只参与剩余区排序。
- 列资格：只收 **In progress / Review** 列（`isTaskCardBoardColumnEligibleForPromptCacheWarmAwaitingUserSection`）。已移入 Validation 的任务即使缓存仍热也下放到剩余区，由剩余区的排序模式与时间窗决定显不显示（2026-10-04 用户反馈：移入 Validation / Done 就是不打算再接这一轮对话）；Done 也进入 Recent 的时间窗与筛选判定。Validation 里 agent 正在干活照样进 Running，置顶照样在 Pinned。
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
紧凑行：第 1 行前导点（Running 脉动点 / 未读交接点）/ agent 图标 / 标题，第 2 行项目名 / stage 标签（仅置顶区），右侧依次是倒计时药丸（仅 Cache warm 区）、三颗时长药丸（创建、停止生成、对话推进，与卡片同源）、置顶标记（置顶且不在 Pinned 区），置顶区另有第 3 行置顶理由。hover 动作组（Edit pin reason / Pin / 展开开关）叠在第 1 行**上方**（见下方「hover 动作组位置」），倒计时药丸与置顶标记放第 2 行，与完整卡片元信息行右侧同一组、同一顺序。元信息行 `flex-wrap`：窄宽度下药丸整组折到下一行，不截断、不挑着显示。
元信息行还显示 worktree 的 git 元数据（2026-10-05 用户要求，与 This project 卡片目录行同一套显隐规则）：相对 base 分支的 ahead / behind 与已集成提交数，以及未提交改动「(N files +A -D)」。Backlog 不显示；没有可说的提交关系、且未提交改动全为 0 时整组隐藏。取数唯一入口 `useTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntry`：
- 当前项目的精简行与完整卡（hover 展开 / 固定展开）：优先读 `workspace_metadata_updated` 推流 store；Board Scope 下推流只探焦点任务与 auto-review 的 Review 列任务，其余任务在推流里没有数据，回落到下面的轮询 store。完整卡由展开宿主显式传入项目 ID，普通看板卡继续只订阅推流。
- 全部非 Backlog 的行（含当前项目）：面板挂载且页面可见时，每 5 秒（`EXPERIMENT_NODE`）轮询 `projects.readTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries`（每次最多 100 条），结果进按 (workspaceId, taskId) 复合键的 store。服务端 `cross-project-task-worktree-git-metadata-cache.ts` 按键缓存，复用 `workspace-metadata-monitor` 的同一个探针（`src/workspace/task-worktree-git-metadata-probe.ts`）：fs-stat 门控、10 秒兜底、全局 git spawn 并发上限 4、同键单飞、base tip 每次请求每项目每 baseRef 只解析一次，5 分钟没被请求的键淘汰。baseRef / worktreeMode 以服务端 board 为准，不信任客户端。
- 不并入 `projects_updated`：未提交改动在 agent 写文件时几秒一变，会让 100 KB 级的整份广播变频繁。

**Hover Expansion In Place / Keep Expanded In List（hover 原地展开与固定展开）**：
2026-10-05 起取代原来的 chevron 展开；2026-10-07 把 hover 浮层改成原地展开（task 6527d，用户：浮层会盖住下一个任务，往下挪鼠标切到下一个任务不直观；浮层顶条把标题往下挤、左侧留白变大，Keep open 难点）；2026-10-08 部署后撤掉交接补偿、改为列表顶边固定，动作组挪到首行上方（同一 task，见下）。实现：`use-cross-project-task-switcher-row-hover-expansion-in-place.ts`。
- 三态同一几何：精简行、hover 展开、固定展开的标题首行左上角一像素不动（实测 0px），多出来的内容只向下长。框没有内边距与边框（描边是不占布局的 ring），卡体首行用精简行同一个前导点（替换 In progress 的 Spinner；「在跑 / 失败」由会话活动行表达）与同一套度量（`…-task-row-first-line.tsx`）。精简行上的项目名、未读点、Cache warm 药丸并进卡体已有的位置（`TaskCardBodyCrossProjectTaskSwitcherRowElements`），不在卡上方另叠一条。
- hover 一行约 350ms（`EXPERIMENT_NODE`）后这一行在列表里原地换成与 This project 同一个紧凑 `TaskCardBody`，把下面的行往下推。同一时刻只有一行因 hover 展开（按行，不按任务）。hover 意图期间完整卡片已隐藏挂载在行里，借此预取其他项目的卡；展开时就是这个实例，不重读。触屏改用长按约 500ms，抬手那一下的点击被吞掉。
- 往下挪到下一行：
  - **交接**：指针离开展开的行不收起，下一行停够意图时长时两行在同一次提交里换过来；指针离开整个面板约 300ms（`EXPERIMENT_NODE`）、Esc、在面板外按下，才收起。「面板外」按面板的 React 子树判断：卡上弹出的 portal 弹窗（如原始 prompt 弹窗）DOM 挂在 body 下，但在里面按下不算面板外，否则一按就收起这一行、连卡带弹窗卸载；键盘焦点在弹窗里（Esc 的事件目标在 `role=dialog` 内）时 Esc 只关弹窗、不收起；不读 `defaultPrevented`，因为 App 常驻的 Esc 热键（react-hotkeys-hook，`preventDefault: true`）对每次 Esc 都先 preventDefault，读它就永远收不起（2026-10-12 评审发现）。离开即收起会让列表在指针移动途中上移几十像素，指针脚下换成更下面的行。
  - **列表顶边固定（经典手风琴）**：收起的行在上方时，新行跟着上移那一行多出的高度，指针一般落在新行下半部；上一张卡比这张高时指针会落到再下一行（新行显示在指针上方，手再动才去展开那一行）。不补 `scrollTop`、不垫顶部空白；面板容器 `overflow-anchor: none`，免得浏览器的 scroll anchoring 在面板滚动过时自己补。唯一例外：交接把新行顶边（连同伸出顶边的动作组）带出了面板可视区上沿，就回滚到刚好露出，最多回滚它被带上去的距离。面板已滚到底、内容变矮时，浏览器会把 `scrollTop` 夹到新的最大值，列表随之下移一点，没有处理。
  - 2026-10-08 用户否掉了此前的「锚定指针下的行」（新行停在指针下，上移的距离先用 `scrollTop` 补，不够就垫面板顶部空白）：指针上方的整列被往下拖，面板在顶部时露出空白，且每往下交接一次空白就累加一次。三种取舍只能选一：上方往下拖（否掉）、新卡上跳（选定）、扫过的行留着展开直到离开面板（未选：列表会越扫越长）。
  - **只认真实移动**：意图只由坐标真的变了的 pointermove 发起，布局 / 滚动造成的同坐标指针事件不算，不会连锁展开；滚轮滚完停下也不会自己展开。
  - 展开顶边不动、只向下长，展开的行不会把自己挤离指针，不会出现「展开→挤走指针→收起→再展开」的循环。
- **hover 动作组位置**：精简行、卡体（铅笔、置顶、原始 prompt、移列、删除……）、卡体兜底三处都叠在首行**上方**（`-top-3`，伸出行顶边 12px，底边落在首行字形之上），与标准密度卡片把动作组伸出上边框同一个思路。2026-10-08 用户反馈：一般紧凑密度的 `top-1` 压在首行右端、盖住后半截标题；也不要让首行在被盖住的地方提前折行（会抖、标题可用宽度变窄）。代价：行间只有 2px，动作组上半截伸进上一行的右下角，hover 时盖住那里几像素。分区第一行上方是分区 header（Pinned / Running 的折叠按钮铺满宽度，Recent 右侧是排序下拉框），伸进去会盖住它们的右下沿、指针从首行往上移时截走点击，所以紧挨 header 的第一行有 16px 上外边距（行根节点 `first:mt-4` = 动作组伸出量 12px + 动作组最右一格展开开关命中区伪元素 `after:-top-1` 再向上扩的 4px），开关命中区顶边正好落在 header 底边上。只让出 12px 时动作组盒子顶边虽落在 header 底边，开关命中区仍高出 4px，伸进 Pinned / Running 折叠按钮（h-9 header 里居中的 h-8，底边距 header 底边 2px）底沿约 2px、截走点击（2026-10-11 评审发现）；改伸出量或命中区向上扩展量中任何一项都要同步这里，真实浏览器集成测试阶段 6 先置顶一个任务让 Pinned 分区有行，hover 各分区首行后用 `elementFromPoint` 在 header 底沿与各控件底边内侧取点守着。三态共用行根节点，仍同一坐标，非首行不变（开关命中区仍是 24×24）。All projects 首页每列也一样：列 header 固定在滚动区外，行是列滚动容器的直接子节点，首行同样靠 `first:mt-4` 让位于列 header，动作组恰好不被滚动容器上沿裁掉。首行前是 Recent「Unread + opened」的小标题或空态提示时不生效（不紧挨 header，也不多出空白）。共享常量 `CROSS_PROJECT_TASK_SWITCHER_ROW_HOVER_ACTION_GROUP_VERTICAL_POSITION_ABOVE_FIRST_LINE_CLASS_NAME` 与 `CROSS_PROJECT_TASK_SWITCHER_FIRST_ROW_DIRECTLY_BELOW_SECTION_HEADER_TOP_MARGIN_CLEARING_HOVER_ACTION_GROUP_OVERHANG_AND_EXPANSION_TOGGLE_HIT_AREA_UPWARD_EXTENSION_CLASS_NAME`（`task-card-body.tsx`）；Focus View 左栏的一般紧凑密度仍是 `top-1`。
- 展开开关：⌄ / ⌃ 图标，三态都在同一坐标（hover 动作组最右一格：距右 6px、叠在首行上方，20×20），点完以后下一个状态的开关正好在光标下。精简行上的开关常驻 DOM（只切透明度），键盘 Tab 得到。tooltip「Keep expanded in list」/「Collapse to compact row」。不叫 Open（面板里「打开」是打开任务），也不叫 Pin（Pinboard 的专名）。点精简行上的开关不等 hover 意图，直接固定展开；收起后指针离开这一行之前不再 hover 展开。
- 固定状态按任务记（Pinned 与下方区同一个任务一起换），存在 `cross-project-task-switcher-panel-view-continuity-store`（字段 `crossProjectTaskSwitcherEntryKeysKeptExpandedInListAsFullTaskCardByUser`）：过渡外壳重挂载时保留，按标签页隔离，刷新即清，不进 localStorage。All projects 首页与本面板读写同一个字段：首页固定展开的卡，进了 Focus View 左栏同样展开。
- 点卡片任何非按钮位置 = 点精简行：同一个行激活函数（backlog 原地编辑框 / 打开任务 / Pinned 行跳到下方区那一行）。卡体渲染角色 `expanded_card_copy_in_cross_project_task_switcher_row` 下单击不延迟、不接双击改标题（铅笔照旧可改）、Done 卡也能点开；在行上按下指针就取消待发的意图（否则按下与抬起之间行变成卡片，click 丢失）。点完不收起 hover 展开（收起会让列表在指针下移动）。
- 卡体在 hover 展开的第一帧就以 hover 态呈现（动作组、底色）：展开发生在静止的光标下，卡体收不到 mouseenter，否则精简行上刚看到的开关会闪没。
- 卡体渲染角色不可拖、不持有 `data-task-id`。门控同 This project（`buildTaskCardBusinessProps`）。面板自己提供紧凑密度（过渡外壳里也一样）。
- 卡快照还没到 / 读失败时，展开的卡先画与精简行同一个首行，提示放在下面，标题不整行消失。
- 键盘：按开关切换形态时旧形态连同它的开关整块卸载，提交后焦点交给**触发那一行**新形态下同一坐标的开关（含卡快照到达、兜底换成卡体那一次），不落到 body。只接力 `:focus-visible` 的焦点：鼠标点开关照旧不留焦点，否则 focus-within 会让动作组在指针离开后常显（`use-cross-project-task-switcher-row-in-list-expansion-toggle-keyboard-focus-handoff.ts`）。展开后「打开任务」的键盘入口是卡体标题（兜底态是首行）：可聚焦，Enter / Space 走同一个行激活函数；只在该渲染角色下生效，标题里没有可交互元素（不形成嵌套），几何不变。
- 验证：真实浏览器隔离检查（`test/integration/cross-project-task-switcher-server-card-actions-real-browser.integration.test.ts` 阶段 6 量本面板、阶段 7 量 All projects 首页的列）量三态几何、动作组是否压首行、分区首行动作组是否伸进本分区 header、交接后上方的行与 scrollTop 是否不动、新行位移与是否连锁。
- 当前项目：直接用 Focus View 左栏手里的数据与动作（带 overlay 的 board、推流 session、同一套 handler），与 This project 那张卡逐字一致。
- 其他项目：按需只读 `taskCardAction.readTaskCardWithBoardColumn`，条目变了去抖重读（重读期间保留上一份）。卡体经 `taskCardOwnedByOtherProjectWorkspaceId` 不读只按 taskId 分键的当前项目 store（git 元数据改读上面的跨项目轮询 store；资源占用与排队 prompt 只对当前项目推流，不显示）。动作调同一组 `taskCardAction.*` 命令、同样的删除 / 跳过 Validation 确认框，不带 overlay、不切项目，期间显示在途 spinner（`use-task-card-action-handlers-for-other-project-cards-in-cross-project-task-switcher.tsx`）。

**Backlog Row In-Place Edit（backlog 行原地编辑）**：
点 backlog 行（问题 5）在 Focus View 之上原地打开那张卡的编辑对话框，不切项目、焦点任务不动，与 This project 点 backlog 卡同语义（`use-backlog-task-editor-opening-in-any-project.ts`）。其他项目的卡：草稿按那个项目记，分支列表只读那个项目的 `workspace.getState`，保存只发改过的字段、不带 overlay，Save & Start 直接对那个项目发启动命令；对话框显示只读的「Project」标签。

**Create Task In Board Scope（Board Scope 建卡）**：
面板顶部与 All projects 首页页头的「Create task (c)」、热键 `c` 打开带目标项目字段的建卡框（**Task Creation Target Project**，见 `docs/context-board-scope-all-projects-and-single-project-scope.md`），默认上下文项目，往别的项目建卡不切项目、弹提示，新卡随广播出现在面板里。

**Board Scope Home Page Section Columns（All projects 首页分区列呈现）**：
Board Scope 下没有聚焦任务时，首页把本面板的分区横排成列（`board-scope-all-projects-home-page-cross-project-task-switcher-section-columns-board.tsx`，2026-10-12 取代 Board Overview）。与单项目对称：单项目首页是阶段列看板、Focus View 左栏是阶段竖列表；All projects 首页是分区列看板、Focus View 左栏是同一组分区的竖列表。
- 两处共用同一份「区数据 + 一行怎么画、点了做什么」（`use-cross-project-task-switcher-section-row-rendering-shared-across-scroll-containers.tsx`）与同一组区块组件（`cross-project-recently-active-task-switcher-section-blocks.tsx`，参数 `sectionBlockPresentation` 区分两种呈现）。
- 分区模型由 App 持有，经宿主的 `crossProjectTaskSwitcherSectionsModel` 供首页、Focus View 与动作导航共用；渲染 hook 不再单独创建分区模型。
- 列序 Pinned（没有置顶时隐藏）| Running | Cache warm · your turn | Recent，与 Focus View 左栏的 All projects 分区同序；列宽 `flex-1`、最窄 260px，放不下时整排横向滚动。
- 与左栏的呈现差异：Pinned 全量显示、不折叠（不读左栏的折叠 / 只露 5 条偏好）；Running 始终列出行（不读左栏的收起偏好）；Pinned 行点击不做「跳到下方区那一行」（点行就进了 Focus View，首页随即卸载）。Cache warm 与 Recent 两处均可展开／收起，默认展开；首页收起为约 40px 窄列，竖排收起为组头与数量。
- 每列一个滚动容器（列 header 固定在滚动区外、滚动容器就是分区内容容器），各持一个 hover 原地展开 hook 实例：手风琴语义与左栏相同，「指针离开面板」「在面板外按下」都以这一列为面板（「列外」同样按这一列的 React 子树判断，列里卡上弹出的 portal 弹窗算列内），指针从 A 列移到 B 列时 A 列展开的行约 300ms 后收起。各列滚动位置记在 continuity store 的 `boardScopeAllProjectsHomePageSectionColumnScrollTopPxBySection`：Focus View 打开时首页被卸载，Back 回来落回原位。
- 当前项目的行展开成完整卡片时与主看板同数据、同动作（`use-current-project-task-cards-for-cross-project-task-switcher-row-expansion-on-board-scope-home-page.ts`，与 ColumnContextPanel 同构）；board 还不是当前项目的数据时改读服务端。
- 页头「All projects」与「N projects · X live · Y awaiting you」（与顶栏切换器 Live / 等你处理两列同源），右侧「Create task (c)」。移动端放不下多列，回落竖排面板。

**Remaining Section（剩余区，UI 名 Recent）**：
不在 Running、也不在缓存倒计时区的所有阶段条目，Backlog 不再单列。排序与阶段筛选独立：
- `Recently touched`（默认，`most_recently_touched_by_conversation_progress_or_user_open_or_description_edit`）：max(对话推进, 我最后打开, Description 编辑)。刻意不用 `card.updatedAt`，列流转不会把旧卡顶上来。
- `Conversation progress`（`most_recent_conversation_progress_only`）：按对话推进倒序，没有推进记录的任务仍保留并排末尾，并在这些任务之间按 Description 最后更新时间倒序（包括 Backlog 单选、阶段混选和 All，最近打开或创建时间不参与兜底）；对话推进时间相同或无记录且 Description 更新时间相同时，按 `(workspaceId, taskId)` 稳定排序。
- 阶段筛选为可组合的 `In progress / Review`、`Backlog`、`Validation`、`Done`，选项间取并集；默认启用 `In progress / Review`；全部未选时即 `All`，点击 `All` 清空选择。`Done` 对应内部列 ID `trash`。
- Project 筛选支持按 workspaceId 多选项目，默认所有项目；可搜索项目名或路径。项目间取并集，与阶段筛选取交集，只影响 Recent。
- 候选统一按最近触达时间截取默认 7 天；排序切换不改变候选范围。「Show older」按需扩展至 30 天（`projects.listCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizon`，不扩大广播窗口）。
- 阶段、项目筛选与 Recent / Cache warm 的展开态由 App 共享模型持有，跨视图、任务切换和过渡壳重挂载保留，页面刷新恢复 `In progress / Review`、所有项目与展开。排序偏好沿用原 localStorage key；旧 `Unread + opened` 值回落至默认，通知未读圆点仍保留。
- 组头数量反映筛选后的条目。展开时显示排序与多选阶段按钮；空列表仍保留筛选和扩展时间窗入口。
快照只补广播取景范围**之外**的旧任务：落在取景范围内却不在广播里的快照条目已失效（取消置顶 / 已删除），不补回；扩展期间随面板 30 秒 tick 重新拉取快照，范围外任务的变化在一个 tick 内收敛。

**Focused Task Visibility（当前聚焦任务留存与 Sticky）**：
- All projects Focus View 的当前任务不以四组取景为存在条件：Spotlight 可以打开未置顶 Done、时间窗外、或被 Recent 时间窗或阶段筛选排除的任务。这时在创建按钮下方临时显示「当前聚焦任务」完整紧凑卡；任务进入正常分组后移除临时区，不改四组归属、计数或排序。
- 当前任务以 `(workspaceId, taskId)` 定位，完整卡读已水合的当前项目 board、推流 session 与共享 `buildTaskCardBusinessProps`；跨项目在途只显示目标占位，不复用旧项目同号卡。手机详情顶部卡片继续使用独立的移动端角色。
- 主分组行优先于 Pinned 副本作为唯一定位源；Running / Cache warm / Recent 收起、仅在 Pinned 的任务被折叠或截断时仍保留这一行，用户的持久化收起偏好不变。分组内沿用精简行 / hover 展开的交互。
- 复用 `useSelectedCardPinState` 的实时几何判定：完整可见时不显示副本，上下前沿触边即在对应边缘显示完整 Sticky 卡。源行只改 `visibility`、保留几何；副本不带 canonical `data-task-id` 或验证锚点。卡体或「返回当前任务所在位置」按钮只滚回定位源，卡片动作与 Portal 弹窗不触发导航。
- 明确切换任务后定位新任务；同一任务跨过渡壳重挂载时恢复原滚动位置。临时区与组内定位源切换时重新绑定测量。没有聚焦任务的 All projects 首页不增加焦点区或 Sticky。
- 当前聚焦的 Cache warm 任务从 Review 移入 Validation 时，按操作前的同组显示顺序选择下一项，末尾选上一项，单项保留当前焦点；跨项目沿用统一打开入口。普通卡片、Sticky 副本与 Review → Validation 拖拽共用此规则。仅服务端确认移入 Validation 后接续，失败、候选退出分组或用户已切走时不自动导航（`use-cache-warm-task-focus-navigation-after-validation-move.ts`）；其他场景仍按既有 Review 列导航。

**Section Exclusivity（主分组互斥）**：
Running / 缓存倒计时 / Recent 三区互斥，优先级 Running > 缓存倒计时 > Recent。Running 不受阶段筛选限制，Validation 中 agent 正在工作仍进 Running；Cache warm 维持 In progress / Review 的阶段资格；阶段多选只过滤 Recent。Pinned 可以与任一主分组重复。区归属是纯函数（`src/core/cross-project-recently-active-task-switcher-section-assignment.ts`），前端每 30 秒按 now 重算。

**Unread Handoff（未读交接）**：
通知中心里该 (workspaceId, taskId) 还有 `visitedAt` 为空的条目，与铃铛同源。两种排序下都用圆点标出。

**Last Opened By User（我最后打开）**：
用户最近一次在任一浏览器 origin 里打开该任务的时刻，记在 runtime（`task-last-opened-by-user-records.json`，每个 workspace 一个），因为 127.0.0.1 / localhost / Tailscale 是不同 origin，localStorage 不共享。只在 board 已是当前项目的完整快照时记——taskId 跨项目会撞号。

**In-Place Cross-Project Task Open（原地跨项目打开）**：
`use-cross-project-task-open-in-project.ts`：同项目直接选中；跨项目先切 workspace，目标 board 加载出该任务后再打开。在途态的收尾决策（选中 / 开 backlog 编辑器 / 提示找不到）一律等 `isCurrentProjectBoardSettled`——快照到达那一帧 board 仍是上一个项目的，taskId 跨项目会撞号；落定在别的项目（导航被其它入口改走、或切换失败回落）即取消在途态。All projects 首页、Spotlight、切换面板、通知点击（找不到开着目标项目的标签页时）共用这一条路径。

从 Focus View 发起时（2026-10-03 修掉「整屏闪烁 + 偶发终端白屏」之后的约束）：
- 在途**全程**只渲染过渡外壳 `FocusViewCrossProjectTaskOpenInTransitShell`，不渲染详情页；顶栏保持详情模式（不出现首页侧栏、看板不挂载，项目相关的顶栏动作与路径隐藏）。一次打开的帧序列是「旧详情 → 外壳 → 新详情」，e2e 逐帧断言过没有任何一帧露出看板。外壳左栏就是本面板，滚动位置 / 展开全部置顶 / 「显示更早」快照经 `cross-project-task-switcher-panel-view-continuity-store` 跨重挂载接上。
- 详情页（含 agent 终端）只在 board 装的确实是当前项目的数据时挂载（`useWorkspaceSync` 的 `projectIdOwningHydratedBoard`）：快照到达那一帧 `currentProjectId` 已换、board 还是旧的，拿旧卡配新 workspaceId 挂终端会在新项目里给同号任务建出幽灵终端，还可能把终端 LRU 里新项目已停放的热终端挤掉。
- 换项目时 sessions 以新快照为底**整体替换**，不与上一个项目合并（同号任务的旧摘要会残留、让终端误判会话重启清屏）；新项目已推来的摘要按原件带回。终端因会话重启清屏后立即向服务端 mirror 重拉快照，不再出现清完不补的永久白屏。
- 外壳上的 Cancel 回到**发起时打开着的任务**（快照未到时撤销在途切换，已切过去则反向打开）；在途期间点当前项目的任务同样先撤销在途切换。`handleSelectProject` 选回当前项目 = 撤销在途切换。

**Workspace Metadata Probe Scope（git 元数据探测范围）**：
2026-10-05 用户观察：All projects 里打开其他项目的任务要等很久。成因：服务端发快照前要等目标项目**每张非 backlog 卡**（含 Done）的 git 元数据首轮刷新跑完（每卡 5 条 git、全局并发 4，cline-kanban 224 个 worktree 约 6.5 秒），且最后一个连接断开时缓存直接删掉，单标签页切回来必然全量冷探。修法（用户提议）：Board Scope 下屏幕上只有焦点任务要逐卡 git 状态，就只探它。
- 每个状态流连接声明范围（`src/core/runtime-state-stream-workspace-metadata-probe-scope-declaration.ts` 组装，浏览器与服务端共用）：单项目范围 = 整个项目；Board Scope = 焦点任务（跨项目打开在途时是目标任务）。服务端自己并上 Review 列开了 auto-review 的卡（自动提交 / 自动 PR 要看它们有没有未提交改动）。不声明的旧客户端按整个项目。
- 初值在 WS URL 参数 `workspaceMetadataProbeScope`（JSON）里，首轮探测就只探它；之后经浏览器 → 服务端消息 `declare_workspace_metadata_probe_scope` 更新（状态流里唯一一种上行消息），不阻塞、探完照常推 `workspace_metadata_updated`。跨项目打开在切项目**之前**同步登记目标任务（`workspace-metadata-probe-scope-declaration-inputs-of-browser-tab-store`），所以新连接的 URL 已带上它。握手期间到达的声明在注册进广播名单之后才补探，否则补探的推送到不了这个连接。
- 同一项目多个连接取并集，任一要整个项目就探整个项目；快照只放范围内的任务。范围外仍跟踪的任务保留上次的结果，`⌘⇧E` 收窄到单项目时补探整个项目，没变的 worktree 只需一条 `git status` 复核。
- 最后一个连接断开后缓存保留 5 分钟（`EXPERIMENT_NODE`）、期间不轮询，切回来不必全量冷探。
- 代价：落地检测（`refreshTaskCommitIntegrationProvenance`）挂在同一个探针上，Board Scope 下没被探的卡要等它被看到（面板轮询或切到单项目）才更新，与其他项目现状一致。

**Cross-Project Ready Notification（跨项目就绪通知）**：
`task_ready_for_review` 投给所有在场客户端，不只是该项目的连接；前端只对**当前项目**按前台可见让位，别的项目照样弹 OS 通知 / 提示音 / 播报。多标签页之间靠 `claimDelivery` 领取（每个 candidate 只有一个客户端领得到）与「有可见标签页正开着该项目」让位去重。连接握手时按全部项目重放最近 60 秒未领取的通知（单标签页切项目会重连 WS）。
- 应用内通知点击别的项目的任务：SW 先找开着目标项目的标签页并尝试聚焦；浏览器不许页面切标签页（当前 Chromium 的常态）时**不再**把选中消息投给后台的那个标签页，改由发起页原地打开（2026-10-05：后台标签页自己跳进 Focus View 是「没操作就跳了」的成因之一）。旧 SW 还会回 `task-selected-in-background-tab`，页面照旧弹 toast。

## 不在本功能内

- 把列自动流转搬到服务端（修 review / in_progress 的列错位）。面板不读列，与它正交。
- 快捷键弹窗切换器（可复用同一个区归属纯函数）。
- 删掉已无前端消费者的 `rawColumnTaskCounts`（原 Board Overview 的 stage 计数；为兼容旧 bundle 暂留在契约里，见 ADR-0001 的 Superseded 说明）。


### 2026-10-07：单项目首帧与终端预热（54602）

- 单项目、All projects 均先以缓存或空元数据发送 `snapshot`，再登记 workspace 广播订阅并启动 git 刷新；首轮结果经 `workspace_metadata_updated` 补推。缓存直到通知读取结束、发帧前才读取，避免这段等待期间的元数据更新被漏掉。空缓存不代表没有任务；Done 的持久元数据投影照常保留。
- 跨项目打开进入在途态时，用已有只读卡片 API 查询会话；仅已有且明示为 PTY 的会话预热终端。完整目标 board 水合之前仍只显示过渡外壳。隐藏预热禁止输入、粘贴与自动续跑，直到可见挂载才释放；画面重同步对该次恢复的续跑抑制也保留到挂载之后。终端键仍为 workspace + task，上限仍是 2 个 parked 终端。取消导航后迟到的查询不会创建终端。
- 独立实验未采纳整板 HTTP 去重和只读详情预览：均未达到约定的 100ms p50 收益门槛。provenance 相同内容免写已由共享 `locked-file-system` 实现，未重复添加；git 插队与 Done 首轮延后也不再是首帧等待的解法。
