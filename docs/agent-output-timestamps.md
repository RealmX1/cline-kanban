# 会话有效活动、真实交棒与进程待命

2026-10-22：本页按任务 3e5e6 经用户批准的新方案更新。旧版把进程恢复边沿显示为 Stopped 的规则已被替代；旧取证保留在 Git 历史和任务持久研究产物中。

## 从原始来源到消费者

原生转录、Codex 当前 TUI 控制接口、harness hooks、ACP 协议及进程事件是原始来源。适配器先核对 workspace、Kanban 会话、原生身份和 incarnation，再进入共享 summary 漏斗。PTY 字节仍用于镜像、粘贴摄入、回显沉降及诊断，不证明对话推进或模型正在计算。

原生转录必须按 `agentNativeConversationSessionIdentity` 定向；同 cwd 的主对话、协作、By the way 不得取最大值合并。异步返回后复核身份，旧结果不得落进新会话。

| 字段 | 含义 | 消费者 |
| --- | --- | --- |
| `lastEffectiveAgentConversationActivityObservation` | 最后一次有效活动及其证据 | Progress、默认活动排序、近期活动、持续自动流转 |
| `lastAgentConversationUserHandoffObservation` | 最后一次真正结束、中断或可信待答 | 交棒药丸、需要新交棒的投递触发 |
| `currentAgentProcessUserTurnIdleRetentionStarted` | 当前进程开始用户回合待命的边沿 | 普通五小时回收、资源诊断 |
| `lastAgentConversationPromptCacheReferenceObservation` | 请求或压缩的缓存参考证据 | Cache warm 估算 |

活动种类包括已接受输入、Agent 输出、工具、上下文压缩、真实回合边界及请求；带发生时间、证据来源，可附原生消息身份。合并单调，迟到 Agent 转录不能回拉更晚的可信输入或压缩。明确的旧 TUI 猜测才可纠偏。

当前状态仍由 `turnOwner / liveness / userTurnKind` 表达，四个讲解场景不是新状态机。Running 根据可信 Agent 回合、存活与明确后台等待判定，静默不代表停止。“近期有效活动”不声称模型正在计算。

## 尝试、接受和回执

`agentConversationPromptSubmissionAcceptance` 分 pending/unconfirmed/accepted。Enter、paste 和前置 UserPromptSubmit/BeforeAgent 只唤醒核验，不证明成功，不自动重复投递。

- Codex：当前 TUI 已加载 thread 的新用户消息，固定前驱，有界读取。消息没有原始时间时保留“发现时间”的语义，并携带原生回合是否仍在进行；已结束回合的晚到接受只补事实，不重新开工或作废更晚的阶段目标。
- Claude/OMP PTY：确切转录中新用户记录，过滤侧链、工具结果、通知、合成压缩摘要；纯附件输入也可确认。
- ACP：唯一在途请求的真实 Agent/工具/权限事件或成功最终响应。写出请求、乐观本地 user 消息和历史重播不是 ACK。
- 能力不足：保持未确认；之后可信主工具工作可恢复实际 Agent 状态，不伪造逐条接受证明。

观察器初始化只建基线，不重放历史边沿；候选核验单飞、有界，回调失败不消费游标。同正文多次提交按原生消息身份区分。

### Codex 后台终端等待与原生执行状态

原生回合执行状态是独立的内部观察，不是有效活动。轻量 `thread/turns/list` summary 页与 `thread/read` 绑定当前 workspace、Kanban 会话、incarnation、原生会话及回合；消息游标超预算、首次基线或消息投影暂时失败都不阻断状态核验。`inProgress` 且无待答标记时保持 Agent 回合，`canAcceptDirectInput=true` 和提示符可用不代表交棒。静默超阈值的 Codex 只有取得明确结束证明后，才允许既有提示符兜底。

观察器在没有摘要更新时也每 15 秒补查，和静默扫描、回收前核验共享同身份在途查询及最多四个原生读取。每个请求超时两秒，未知结果按 15／30／60 秒封顶退避；仅推迟依赖该证据的自动动作。重启后按持久身份与当前端点重新核验，不把旧 socket、PID 或历史 active 当作仍在执行的证据。

对 `idle_stall` 的自动纠正还须证明原生回合在误判时已开始，并与已有原生接受或活动事件关联。纠正保留回合序号、原开始时间、接受及缓存事实，清除错误待命起点；只有与该起点时间、序号、置信度都匹配的 `prompt_ready_fallback` 历史交棒才被撤销。手动 Review、Stop、真实问题及批准不受此纠正影响。回收到期及重启后续接回收均先补证，未知时保留期限记录，纠正后将错误期限标为 superseded。

工具活动另用有界转录游标补齐原生消息投影遗漏。首次读取只建立字节基线，分段核对主会话元信息与 `task_started` 回合边界；只消费基线后的完整工具调用或结果，保留原始发生时间，过滤旧分支、合成内容、子代理及重复记录。文件替换或截断重建基线；缺少完整边界时暂停工具补充。该通道不确认用户接受，也不写缓存参考。真实 `write_stdin` 调用或空结果可以更新工具活动，调用间的纯等待、重复状态查询和耗时变化不能更新活动或缓存 TTL。

接受当前主对话新输入后，服务端一次性将 Review/Validation 移回 In Progress，无须浏览器打开。持续自动流转排除 accepted_user_input，保护用户随后手动移列；其他活动继续受原有窗口和手动移动时间约束。

程序化投递回执比会话活跃更严格：写前固定原生前驱、正文匹配、当前 incarnation；别人的新输入不能冒领本条成功。既有独立原生回合门继续保留。缺可靠关联保持未确认，不凭重绘结算成功。

## 历史与生命周期

新进程就绪可以刷新本代待命起点，不能制造历史交棒。接管同一活进程保留原待命起点。Agent 继续清待命、保留历史；Agent 回合及 park 时交棒药丸隐藏。普通五小时、park 独立期限及 incarnation＋turnSequence 旧定时器保护不变。

当前主身份统一解析 `mainTaskConversationSessionId ?? card.id`。主药丸、Direct 和默认活动排序只取主对话；hover 分列协作、By the way、前主的时间与来源。内部 subagent 不直接刷新主活动，主对话收到结果后才推进。

缓存使用专用投影与既有 measured TTL/进程作用域/手动压缩政策；请求代理标估计。Stop、恢复及普通活动不补满 TTL。Cursor 无原生请求遥测时，内容分类只写明确标为估计的缓存参考。通知版本取回合与真实交棒，压缩不单独取消有效通知。

无工具回合也可由主 Agent 的真实原生响应或 ACP 唯一在途请求的真实处理证明生成专用请求时间估计，不能由 pending/accepted 通用活动生成。转录使用响应的原始时间；ACP 用已证实处理的原请求提交时间。Codex 当前 TUI 不报原始响应时间时，正在进行回合的真实响应可用发现时间作明确估计；首次读取已结束的快速回合，只有未被取代的程序化投递回执凭写前游标、完整身份、正文和新原生输入 ID 证明归属，且该输入已有真实模型响应时，才用首次 CR 时间作保守估计。只有同代 pending 或同正文仍不足以关联；单纯排队接受、缺关联的已结束回合及历史重播均不续期，也不声称 provider 已创建缓存。

## 兼容与验证

兼容读旧 Progress、请求参考、进程停止对象，只新写新字段。旧实质 TUI 戳不升级可信活动；旧 Stopped 无法证明真实交棒时隐藏。不用恢复或升级时间补 now。

内存、磁盘轻量读取、主看板、Focus View 和跨项目卡片语义一致，无可靠时间显示未知。Created 放详情，主时间组只留交棒和推进。

测试覆盖 core reducer、回收边沿、定向原生 reader/observer、ACP 接受及回执、卡片与跨项目排序，使用受保护根测试入口和独立 Web UI 测试。真实部署后的 harness/hook/广播链按本任务 PDV 观察；源码验证不等于部署验证。
