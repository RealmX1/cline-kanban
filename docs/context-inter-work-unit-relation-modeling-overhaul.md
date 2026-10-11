# 工作单元间关系建模重构（Inter-Work-Unit Relation Modeling Overhaul）— 领域术语表

本文件收录 dd2db「任务关系建模重构（Task Relation Modeling Overhaul）」引入的领域术语（ubiquitous language），只收术语的定义与应避免的叫法，不写实现（原在仓库根 `CONTEXT.md`，按 `docs/README.md`「功能术语表」约定迁入）。权威设计在 dd2db 设计归档（仓库外），冲突时以设计归档的最高仲裁层为准，并回头修订本文件。其余子系统的术语见 `AGENTS.md` 的参考文档表（例如 facet 模型见 `docs/session-facet-model.md`，thread graph 术语见其核心包自己的 CONTEXT）。

写法：每条「**中文（English）**：定义」加 `_Avoid_`。标识符保持英文原文。全文禁用「推断 / inferred」一词，见「间接证据」。

## Language

### 工作单元与身份

**工作单元（Work Unit）**：
关系图的节点，只有两种：一张看板卡片，或一个看板外独立 agent 会话。节点从不合并；同一原生会话在不同时段归不同工作单元，靠「会话归属时段」表达。
_Avoid_：node、vertex、entity、task（task 只指卡片）、Exploration（thread graph 的探索场次，与工作单元相互独立）

**卡片限定引用（Qualified Kanban Board Card Reference）**：
落盘时指称一张卡片的唯一形状：`{workUnitType: "kanban_board_card", workspaceId, taskId, taskIncarnationCreatedAtEpochMs}`，四项在所有落盘位置一律必填。`taskIncarnationCreatedAtEpochMs` 区分同一 taskId 被删除后再次使用的不同「世」。输入面可以接受裸 taskId，由 runtime 解析到当前活着的那一世；有多个候选时拒绝（fail closed）。
_Avoid_：裸 taskId 作为落盘键（5 位 hex 会跨 project 撞号）、task ref、card id

**全局任务身份登记簿（Global Task Identity Registry）**：
跨全部 workspace 的卡片身份记录，永不删除：删卡只打墓碑，已删卡仍能按 id 解析出身份。taskId 只由 runtime 对照登记簿（含墓碑）分配，保证全局不重复。
_Avoid_：task index、task cache

**看板外独立 agent 会话（Kanban-Unmanaged Standalone Agent Conversation Session）**：
既不能由进程环境里的 `KANBAN_TASK_ID`、也不能由原生会话 id 查「会话归属登记」解析到任何卡片的 coding agent 会话，典型情形是用户直接在终端里敲 `claude` / `codex`。以「会话身份键」标识；只有能观测到原生会话 id 的会话才能成为这种工作单元。它可以当覆盖方、需求出处、边界排除的承接方，但**不能持有可结案的义务**。Kanban 侧边栏里的 home agent 会话不是这种工作单元，也不是任何工作单元。
_Avoid_：人驱动会话（卡片里的会话同样由人驱动）、主会话 / main session（与卡片内 main vs by-the-way 撞名）、影子 task

**会话身份键（Conversation Session Identity Key）**：
二元组 `{conversationSessionHostKanbanAgentId, nativeConversationSessionId}`。前者取宿主 agentId 全集（claude、codex、kimi、omp、cursor 等），按开放字符串处理；后者是 harness 给出的不透明原生会话 id，不要求 uuid 格式。与 thread graph 核心包 `harnessKind` 的对应只在宿主胶水层用一个映射函数完成。
_Avoid_：harnessKind、workUnitAgentHarnessKind（两者都已停用：核心包只有 3 个取值，kimi/omp/cursor 会话会丢失）、session id（不区分原生 id 与 kanban 会话 id）

**会话归属时段（Conversation Session Ownership Period）**：
一个原生会话在某段时间内归哪个工作单元。卡片在启动时以 resume 方式实际续接了某个原生会话，即「采纳」：采纳前该会话可以归看板外独立会话，也可以归另一张卡片；采纳后归属转给采纳方，此后即使有人在终端手动 resume，只要原生 id 命中登记，仍归采纳方。源卡片之后再以同一原生 id resume，报「共享会话冲突」诊断。卡片内新观测到的原生 id（rewind、fork、by-the-way 会话）追加登记给同一张卡。fork 不转移归属。归属时段是会话身份事件的投影，不是独立写入的真相。
_Avoid_：合并、别名（节点从不合并）

**行动者（Actor）**：
发起一次被记账事件的主体，`kanbanActorKind` 共 10 个取值：
- 工作单元：`kanban_board_card_work_unit`、`kanban_unmanaged_standalone_agent_conversation_session_work_unit`；
- 非工作单元：`kanban_home_sidebar_agent_session_not_a_work_unit`、`kanban_web_ui_user_gesture_with_verified_page_load_nonce`（用户在 Web UI 的手势）、`kanban_web_ui_client_side_automation_with_verified_page_load_nonce`（浏览器端自动流转）、`kanban_web_ui_request_with_verified_page_load_nonce_without_board_mutation_initiator_annotation`、`kanban_runtime_system_component{componentName, onBehalfOf?, causedBy?}`、`kanban_cli_invocation_without_task_or_session_environment`、`direct_runtime_trpc_caller_without_cli_actor_header_or_web_ui_page_load_nonce`、`unresolved_actor{unresolvedActorReason}`。

只有前两种是工作单元、能成为关系端点；其余只进事件日志。其中 `unresolved_actor`、无环境 CLI、裸 tRPC 调用方、Web 缺标注请求这 4 个值在确认、门与义务规则里一律「按未解析处理」。CLI 的行动者声明优先于页面 nonce，且永远不记为用户；系统组件身份只能在 runtime 进程内显式传入，不接受请求头或环境变量声明。
_Avoid_：caller、source、initiator（后者专指 saveState 的「发起方标注」）、「未知」（改用 `unresolved_actor`）

**关系断言方（Relation Asserter）**：
「谁提出了这条关系」。取值 = 行动者 ∪ 历史回填抽取运行 `historical_backfill_extraction_run{extractionRunId, extractorIdentifier, extractorImplementationVersion}`。抽取器不是行动者。
_Avoid_：assertion origin、来源渠道枚举（渠道由断言方身份决定，另设枚举只会与它不一致）

**Web UI 页面加载 nonce（Kanban Web UI Page-Load Issued Request-Origin Nonce）**：
runtime 为每次页面加载签发、只存在内存里的 nonce，证明一个请求来自一个真实加载过的 Kanban 页面。它**证明不了是用户手势**：用户手势与浏览器自动流转还要靠 saveState 上逐卡、逐变更的「发起方标注」区分。
_Avoid_：用户决策 nonce（旧名）、session token、CSRF token

### 事件与关系

**工作单元间关系真相源事件（Inter-Work-Unit Relation Source-of-Truth Event）**：
关系的唯一原始真相。只追加、不删除，提交时分配全局单调序号，共 10 族：`task_mutation_event`、`agent_conversation_session_identity_event`、`fact_observed_by_kanban_runtime_event`、`inter_work_unit_relation_assertion_lifecycle_event`、`requirement_obligation_unary_declaration_event`、`work_unit_agent_self_declared_milestone_event`、`relation_presentation_preference_event`、`recorded_live_fact_attribution_compensation_event`、`resource_disposition_decision_event`、`extracted_record_effectiveness_transition_pointer_event`。关系是「事件日志 × 投影表版本」的纯函数；投影表版本演进不算改写历史。
_Avoid_：操作日志、audit、activity、journal

**Task 修改事件（Task Mutation Event）**：
10 族中的第 1 族：某个行动者对某张卡片做的一次有记账的修改（create、逐字段 update、message、message-cancel、start、park/unpark、移列、trash、delete、从 trash 恢复），以及 runtime 从 board 差异里检测到、没有经过持久化漏斗的未归属修改。它是来源轴和交互轴的派生原料，但不再是「唯一原始真相」本身。
_Avoid_：操作日志、audit、activity

**记录捕获渠道（Record Capture Channel）**：
一条事件或记录经由什么渠道进入系统（例如 live 捕获、历史回填的各类抽取来源）。唯一的渠道字段是 `recordCaptureChannel`；「谁提的」只看关系断言方。
_Avoid_：assertionOriginChannel、eventCaptureChannel 等旧的多套来源枚举

**间接证据（Circumstantial Evidence Only）**：
证据只间接支持某个主张（例如只有时间窗吻合、只有散文里的「由 X 创建」），不能直接证明。这样得到的东西要么作为归属主张，要么作为待确认的提议，永远不直接生效为事实。
_Avoid_：推断、inferred（全局禁用；改说「间接证据」「待确认」「抽取或建议类来源」）

**工作单元间关系（Inter-Work-Unit Relation）**：
两个工作单元之间一条有类型、有方向的联系，端点一律是卡片限定引用或会话身份键。分「记录型」和「断言型」两个品种；类型名一律带轴前缀，以免与 thread graph 的 turn 级边（`TurnRelationEdge` 的 `continues` / `forks_from` 等）同名。词表共 21 个 kind，见「关系轴」。
_Avoid_：dependency、edge、link（`link` 只是已退役的旧 CLI 动词）、裸词 relation、Task Relation（节点已不只是卡片）

**主体与锚点（Relation Statement Subject / Anchor）**：
一条关系「S `<kind>` A」必须读成一句真陈述句。S（主体）是叙述中回头指向对方的一方，A（锚点）是被指向的前件：S 从哪来、属于谁、等谁、接手谁、覆盖谁、研究谁（回指约定）。结案类固定为「解除方或承接方 → 被解除方」；事件投影固定为「被作用的客体 → 行动者或来源」。方向的规范来源是注册表里每个 kind 的读法短语。
_Avoid_：source / target、from / to（写入动词的 flag 按对端角色命名，禁止 `--from` / `--to`）

**关系轴（Relation Axis）**：
关系按五条轴组织，约束跟轴走。品种由前缀唯一决定：
- 来源 `provenance_`（记录型，3 个）：`provenance_created_by`、`provenance_resumed_and_adopted_conversation_session_of`、`provenance_forked_conversation_session_of`；
- 交互 `interaction_`（记录型，4 个，按效果分类）：`interaction_agent_session_dispatched_or_controlled_by`、`interaction_requirements_amended_by`、`interaction_execution_configuration_changed_by`、`interaction_board_lifecycle_transitioned_by`；
- 义务 `obligation_`（断言型，7 个）：`obligation_is_decomposed_subtask_of`、`obligation_fully_covers_requirements_of`、`obligation_partially_covers_requirements_of`、`obligation_takes_over_all_remaining_obligations_of`、`obligation_renders_obsolete_requirements_of`、`obligation_scope_boundary_excludes_work_owned_by`、`obligation_is_forbidden_to_mutate_resources_of`；
- 门 `gate_`（1 个，只是门实体的投影，不能直接断言）：`gate_waits_for_condition_on`；
- 参照 `reference_`（断言型，6 个）：`reference_concerns_behavior_or_state_of`、`reference_verifies_claims_of`、`reference_reuses_produced_outputs_of`、`reference_requirement_originates_from`、`reference_is_cross_repository_counterpart_with`、`reference_is_generally_related_with`。

系统组件和浏览器自动化作为行动者的事件，不投影成交互轴关系。
_Avoid_：edgeKind、relation type（不带轴）

**记录型关系（Recorded Relation）**：
由系统从事件确定性派生的关系，即来源轴与交互轴。它陈述的是已经发生的事实：由 live 捕获事件派生的不能撤回，只能被用户静音，归属错误只能由用户或确定性证据追加归属更正事件；由历史抽取记录派生的，随该抽取记录的接纳生效或撤回而出现或消失。
_Avoid_：自动关系、推断关系

**断言型关系（Asserted Relation）**：
由人、agent 或系统组件声称的语义关系，即义务轴、参照轴（门另由门实体表达）。它可能是错的，因此有提议 → 生效 → 撤销的生命周期，生效与否由「可确认变更」决定。
_Avoid_：手动关系

**无环约束组（Acyclic Constraint Group）**：
只有三组关系静态禁止成环：子任务层级；完全覆盖、接手、使过时构成的结案组（`acyclic_group_obligation_discharge_by_full_coverage_takeover_or_obsolescence`）；armed 或 suspended 门投影出的等待边。跨 kind 的环允许。
_Avoid_：DAG（整张关系图是允许环的一般图）

**创建时主来源（Creation-Time Primary Provenance）**：
一张卡片在树状视图里的唯一父节点：优先取 `provenance_created_by`（系统组件代行建卡时按 onBehalfOf 投影出的那条也算），没有时取 `provenance_forked_conversation_session_of`；两者都没有，这张卡就是树根。采纳关系和子任务关系永远不能当主来源。
_Avoid_：parent（父子语义属于义务轴的子任务关系）

**轮次锚点（Occurred-At Conversation Turn Reference）**：
关系或事件上可选的「发生在哪一轮」外键，指向 thread graph 的轮次键空间。会话身份用两个可空字段并存（原生会话身份、kanban 任务会话限定引用），至少一个非空，因为 Cline 会话和嵌套的 by-the-way 会话没有可反查的原生 id。dd2db 不以 thread graph 为前提，这个字段只是为将来完整接洽预留。
_Avoid_：TurnRef 判别联合（两种身份都已知时会丢失对应关系）

### 确认与生效

**可确认变更（Relation-Affecting Confirmable Change）**：
一切会改变断言型关系、门或义务状态的提议所经过的唯一决策层，共 9 种：建立断言型关系或门、修改已生效断言的风险相关属性、撤销已生效的断言或门、需要确认的关系触发副作用、一元义务结局声明、义务重开、无去向的需求项剔除声明、抽取运行整批生效、单条历史抽取记录的接纳生效。被拒绝的提议留下墓碑，所有提议方共用。
_Avoid_：审批单、approval request、pending relation

**确认策略（Confirmation Strategy）**：
只指 S1–S6 六种生效方式：S1 立即生效不经审阅；S2 立即生效、限时可否决；S3 独立自动核验通过后生效，否则按行回退；S4 等用户决定、截止后按提议生效（不算显式同意）；S5 等用户决定、截止后作废并交还提议方；S6 无期限等用户明确决定。每种变更允许哪些策略由授权矩阵（M1–M28）按行明文列出，这是唯一授权源。
_Avoid_：autonomy、confirmation policy、risk tier、「底线 + 只能收紧」（已废止的模型）

**决策来源（Decision Provenance）**：
一条可确认变更最终以什么方式被决定（例如用户显式同意、截止到期、独立核验通过），与决策事件的行动者一起回答「谁、凭什么让它生效」。用户显式同意只认带页面加载 nonce 且来自显式用户事件处理器的请求。
_Avoid_：接纳决定方、agent 确认（不存在这种决策来源）

**自派生对端与独立对端（Self-Derived Counterpart / Independent Counterpart）**：
相对某个提议方 P 的对端分类。自派生对端 = P 的纯委派子树：对端的 live 建卡、改需求、message、start 都出自 P 或其子树，且运行时从未观察到用户输入进入它，并且整个生命期都可观测。其余一律是独立对端；判不清的按独立对端处理。
_Avoid_：child、下游（前者是义务轴概念，后者是方向概念）

**撤回、撤销、否决、静音（Withdraw / Revoke / Veto / Mute）**：
四个不同动作：撤回 = 提议方收回自己仍在挂起中的可确认变更；撤销 = 让一条已生效的断言失效（用户同意过的，只能由用户撤销）；否决 = 用户在 S2 的否决窗口内推翻已立即生效的变更；静音 = 用户隐藏一条记录型关系的展示，事实本身不变。
_Avoid_：retract、delete relation、reject（拒绝只是用户对挂起变更的一种决定）

**拒绝墓碑（User Rejection Suppression Tombstone）**：
用户拒绝一条提议、或以「关系有误」撤销一条断言时留下的记录（自然键、被拒时的证据锚点集合、两端当时的计划指纹、抑制范围）。之后同自然键、没有新证据、两端需求也没改的再断言一律被抑制并明确报错；Web UI 用户自己的直接断言永远不受抑制。agent 以「有误」撤销自己的断言时，墓碑只抑制它自己（同一原生会话）。「自然结束」的撤销不留墓碑。
_Avoid_：黑名单、cooldown（冷却是被这个机制取代的旧说法）

**单方面声明（Unilateral Declaration Not Confirmed By User Or Verifier）**：
由对端（或第三方）断言、又没经过用户显式同意或独立核验的断言型关系。在被指向的一方的邻域摘要与会话注入里单独成块，理由文本作为引用数据截断呈现，不能被当成指令。
_Avoid_：未确认关系、外部关系

**注入回执（Asserted Relation Injection Receipt）**：
一条断言型关系随会话启动注入进某个会话时记下的（会话、时刻、关系 id 与版本）。关系后来被撤销或修订时，据此知道该给哪些会话发修订通知。
_Avoid_：已读回执（那是正向呈现回执）

**正向呈现回执（Positive Presentation Receipt）**：
系统能证明某条待决变更确实被用户看到过的凭据。S2 窗口到期时，有没有回执决定它记为「看过未否决」还是进入「过窗未审阅」。
_Avoid_：已读、seen

**预授权副作用（Pre-Authorized Side Effect）**：
一条关系生效时由系统组件代为执行、无需再次确认的写入，例如接手生效后把前任的入向子任务边改指向接手方、把 handoff 证据写入携带实体。完全覆盖生效时没有写入型副作用。
_Avoid_：自动执行、hook

**随下一条用户消息携带（Pending Carry With Next User Message）**：
一份等待投递给某个工作单元的上下文（关系修订通知、门的满足信息、handoff 证据等），在该单元收到下一条真人消息时一并带上，确认送达后才消费。它与 inject（直接投递进正在运行的会话）是两个不同动作；程序化消息不消费携带内容。
_Avoid_：裸词 inject、queue、inbox

### 门

**门（Work Unit Gate）**：
一个断言实体：「等待方在条件树满足之前不（应）开始或继续，满足后执行声明的动作」。条件树由叶子条件组合（all_of 等）；动作有 notify（强制）、carry、inject、start（有上限）。门只结案一次，已结案的门只能靠新建门恢复。门投影出 `gate_waits_for_condition_on` 边，每个（门, 被等方）一条。
_Avoid_：dependency、blocker、link、wait-for 关系（门不是一条可以直接断言的关系）

**门条件（Work Unit Gate Condition）**：
共 9 种叶子条件：1 被等卡片 main 会话把回合交还给用户审阅；2 被等方宣告了自己的 milestone；3 被等任务的提交落地到本地 base；4 落地且要求的部署后验证通过（只认 `post_deploy_verification_passed_observed`，且事件里的部署归属区不能是「尚未随部署上线」；未全勾、带原因结案的 `post_deploy_verification_closed_into_done_with_unchecked_items_reasoned_observed` 不算）；5 被等卡片的义务以指定的满足类结局结案；6 被等卡片被移入 Done 列（只表示有人宣告做完，不是完成证据）；7 到达某个绝对时刻；8 外部就绪探针报告就绪；9 只能由用户在 Web UI 宣告满足的外部条件文本（用来表达「暂停」）。完成证据类叶子一经观测就锁存；只有条件 5 可以因义务重开而解锁。
_Avoid_：trigger、precondition、「进 review 列」（review 列在第一次提问时就会进入，不是条件）

**满足证据等级（Gate Condition Leaf Satisfaction Evidence Grade）**：
每片满足的叶子记录证据有多强：机器观测的确定性事实、agent 自行宣告而未经机器核验、用户在 Web UI 宣告、已确认义务关系上的独立自动核验通过、浏览器自动流转移列而无完成证据。证据低于授权时，门动作自动降级（start 转为待确认，inject 降为 carry 加 notify）。满足途径只有三条：机器观测、被等方宣告自己的 milestone、用户在 Web UI 宣告。
_Avoid_：gate satisfy、declare-result-ready（均已删除）

**任务提交落地到本地 base（Task Commits Integrated Into Local Base）**：
统一的落地判据：取被等任务最新一世中、从最后已知 task HEAD 可达的非 merge 自有提交，每一个都按 exact SHA → patch-id 一对一进了本地 base。不读拓扑 ahead；squash 这类机器无法判定的情况交用户裁决。
_Avoid_：merged、ahead 为零、「已落 main」（标题里的手写状态不是证据）

### 义务

**需求义务（Requirement Obligation）**：
一张卡片「欠着要完成的需求」这件事本身。它的状态由事件和已生效关系推导（C′），不写进 board，也不改变看板列：`phase` 取 `requirement_obligation_open`、`requirement_obligation_closed`，或对看板外独立会话取 `requirement_obligation_not_applicable_to_kanban_unmanaged_standalone_agent_conversation_session`。消费方只看 `phase`。状态值以 `requirement_obligation_` 开头，关系 kind 以 `obligation_` 开头，互不混淆。
_Avoid_：完成状态、Done（Done 列会停会话、删 worktree，与「义务是否了结」是两回事）、obligation facet

**义务结局（Requirement Obligation Outcome）**：
义务结案时的封闭词表，前缀 `requirement_obligation_outcome_`：`fulfilled_by_own_work`、`fulfilled_by_covering_work_units`、`fulfilled_by_commits_on_local_base_ref_without_attributed_work_unit`、`transferred_to_successor_work_units`、`requirements_rendered_obsolete_by_work_units`、`abandoned`、`closed_reason_unspecified`、`discarded_by_work_unit_deletion`。有对端的结局（覆盖、接手、使过时）的唯一真相是对应义务关系的生效迁移，不另写结案事件；一元结局（自身完成、放弃、原因未说明、无主提交）来自一元声明。暂停不是结局，由门表达。
_Avoid_：fulfilled_by_self、fulfilled_by_coverage、superseded_by_work_units（旧名）

**覆盖（完全 / 部分）（Full / Partial Coverage of Requirements）**：
一个工作单元已落地到本地 base 的成果，满足了另一张卡片当前义务的全集（完全覆盖，被覆盖方以此结案且不走 Done 的副作用链）或其中一部分（部分覆盖，永不导致结案，剩余工作按原卡重整 / 交新卡承接 / 只留建议处理）。多个部分覆盖合起来结案，由一条列出前序部分覆盖的完全覆盖表达。
_Avoid_：duplicate（Linear 的 duplicate 在本体系写成接手）、「标题相似」「ahead 为零」（都不是覆盖证据）

**接手（Take Over Remaining Obligations）**：
后继卡片接过前任卡片**全部**未完成的义务，前任以「移交」结案，资源不因此清理。每个前任最多一条已生效的接手；多后继写成若干条边界排除加恰好一条接手。前任只能是卡片。
_Avoid_：continues（撞 thread graph 边名）、handoff 作为关系名（hand-off 只是反视角动词）

**使过时（Render Obsolete Requirements）**：
新方向（卡片或看板外独立会话）让一张卡片的旧要求不再需要被满足，被使过时的一方以此结案；它不主张需求已满足。部分过时不单列 kind，写成一元剔除声明。
_Avoid_：supersede / 取代（这组词只指记录的代际更替）、replaces（易被读成「接过了需求」）

**边界排除与一元剔除（Scope Boundary Exclusion / Unary Requirement Item Drop）**：
边界排除：列出的工作不属于 S 的义务，由必填的去向工作单元承接；约束只落在 S 上，对去向一侧只是信息。没有去向的剔除不是关系，而是一元声明「这些需求项被舍弃、无人承接」，只能由用户逐条决定。
_Avoid_：exclude-scope 不带去向的用法、scope_excludes（旧占位名）

**需求指纹（Requirement Obligation Baseline Fingerprint）**：
判定「覆盖之后需求是否又被修订」的哈希：取 prompt、images、prepFilePath、taskCommentEntries、已生效的剔除与排除集合，**不含标题**。指纹变化使主张「需求已满足」的结局失效并触发再核对，但不改变关系本身的状态。
_Avoid_：plan version、invalidated 关系状态（已删除）

### 回填

**抽取记录（Extracted Record）**：
进程外回填作业从历史 transcript、board 残留、散文引用里抽出的证据记录，导入 runtime 后不可变。它只存证据；是否生效只由可确认变更决定。已生效的抽取记录整体排在所有 live 事件之前（激活前历史纪元），纪元内按发生时刻排序。
_Avoid_：推断记录、backfilled event（回填产物不进 live 事件日志）

**抽取运行（Inter-Work-Unit Relation Extraction Run）**：
一次进程外回填作业，没有主语，产出先写暂存文件再由 runtime 导入；同一抽取器版本的首跑要由用户看过抽样后整批决定。
_Avoid_：backfill job、relations backfill

**激活基线观测（Board State Baseline Observed At Live Capture Activation）**：
live 捕获启用那一刻，runtime 对每张卡片所在列与最后会话状态的一手观测。历史 Done 卡的义务状态据此推导（会话被中断的推为 open，其余推为原因未说明），不经回填、不需要确认。
_Avoid_：历史快照回填、列快照抽取

### 读侧上下文

**工作单元上下文提供端口（Work Unit Context Provider Port）**：
dd2db 读取某个工作单元意图上下文的唯一接口，分三级：L1 全局 Recap（默认注入）、L2 完整意图卷宗（覆盖核对与按需拉取）、L3 transcript 节选。每次返回都带 `asOf` 和完整度评估；身份与归属由 dd2db 下发，提供方不得自行推导；「提供方不可用」是合法结果。
_Avoid_：context API、memory

**全局 Recap（Work Unit Global Recap）**：
每个工作单元一份跨 harness 的滚动摘要，由压缩后的意图卷宗、dd2db 事件事实和 agent 末次汇报（只作情境）组成，在 cline-kanban 内生成与缓存。它不是 Claude Code 单轮的 `away_summary` / `※ recap`，后者只是可选输入之一。
_Avoid_：recap（裸词，易与 Claude Code 原生 recap 混淆）、summary

**意图卷宗（Work Unit Intent Dossier）**：
一个工作单元内用户提出的需求、验收、边界、决定及其演化的完整记录，由意图提取系统作为「按工作单元」的投影产出，是端口 L2 的正式提供方；与「按作用域分级的持久约束」是同一提取层的两个不同投影。
_Avoid_：intent summary、约束（约束 reference 是另一个投影）

**跨库自动结案完整度闸（Cross-Repository Automatic Closure Intent Context Completeness Gate）**：
跨仓库的完全覆盖、部分覆盖、接手要自动生效，必须同时满足：L2 提供方可用、没有缺失的 transcript、被覆盖方每条有效意图项都有逐条的「已覆盖」判定与证据。任何兜底实现都过不了这道闸。
_Avoid_：跨库开关（开关是闸之外的发布控制）

## 退役与改名

- **「Task 修改事件是关系记录的唯一原始真相」** → 唯一原始真相是 10 族「工作单元间关系真相源事件」，Task 修改事件只是第 1 族。
- **「被卡片以 resume 方式采纳前，它归看板外独立 agent 会话」** → 采纳前的归属者可以是独立会话，也可以是另一张卡片（卡对卡采纳允许）。
- **「以 {harnessKind, nativeSessionId} 标识，复用 thread graph 核心包的 ConversationSession 身份」** → 会话身份键为 `{conversationSessionHostKanbanAgentId, nativeConversationSessionId}`，与核心包只在胶水层映射。
- **「看板外独立会话的判据是进程环境里没有 `KANBAN_TASK_ID`」** → 还要求原生 id 查不到任何卡片的归属登记，且不是侧边栏 home agent 会话。
- **行动者「未知」** → `unresolved_actor{unresolvedActorReason}`；行动者从 4 类扩为 10 个取值。
- **「推断」（含 inferred 提议、推断关系）** → 全局禁用，改说「间接证据」「待确认」。
- **`obligation_supersedes` / `superseded_by_work_units`** → 使过时 `obligation_renders_obsolete_requirements_of` / `requirement_obligation_outcome_requirements_rendered_obsolete_by_work_units`。
- **`obligation_continues`、`obligation_covers`、`obligation_subtask_of`、`obligation_scope_excludes`** → 见「关系轴」中的对应全名；无去向的剔除改为一元声明。
- **旧 link / `board.dependencies` / 完成后自动启动下游** → 已退役；等待关系由门表达。
- **`gate satisfy`、`declare-result-ready`、`await-resolution`** → 被等方只能用 `declare-own-milestone` 宣告自己的 milestone；阻塞读为 `gate block-foreground-until-resolved`。
