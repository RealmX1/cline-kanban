# RVF 候选版本与原生投递恢复

普通 RVF 范围修订由插件在同一 token/run 下完成，不要求下一条消息。后继候选版本不继承父版本的原生回退／自动收尾资格。`assert-rvf-current-candidate-native-closeout-qualification.ts` 在激活、完成检查、原生恢复和收尾投递前核验当前合同；当前后继版本协议只授予普通审查资格。父 receipt 作为历史保留。

## 发送与接受的持久事实

实际程序化消息入口在既有 task-message injection ledger 中保存 `codex_native_prompt_delivery_operation`，包括 workspace、conversation、native session、canonical cwd、正文 SHA256、稳定客户端 ID、发送阶段、原生 turn ID 和运行时进程身份。账本、文件和目录的 fsync 成功后才允许调用 `turn/start`；同内容重试也必须完成持久化。原生 ID 和正文不符时拒绝沿用资格。

重启复用原客户端 ID。`request_intent_persisted` 表示请求可能已经发生，恢复只查询；无 PID、第一页未命中或完整分页未命中都不能证明可以重发。接受查询遍历 `thread/turns/list`，以客户端消息 ID，或已保存的返回 turn 加精确正文／摘要核对；分页循环、查询错误和预算耗尽保留未知。原生端未回传客户端 ID且返回 turn 尚未落盘时，不能仅凭相同正文猜测接受。

已提交 operation 的 `acceptanceHistoryQueryProgress` 在每页核验后持久保存下一页 cursor、已查 cursor 的 SHA256 和查询状态；它沿用该 operation 的 workspace、conversation、native session、canonical cwd 和正文绑定。预算耗尽后的后续扫描及进程重启从未完成页接续，每轮仍受原查询预算约束。cursor 读取失败或检测到跨轮次循环时，本轮保留未知并持久重置到最新页，后续扫描自动重查；完整遍历未命中后也从最新页开启下一轮。这些状态都不授予发送资格、不增加发送次数，也不覆盖原失败。

RVF 自动收尾沿用压缩感知的动态确认截止时间，journal 不把它缩回固定 15 秒。已保存的提交快照和 journal 任一证明请求可能已发送，接管就只查询；即使停机跨过确认截止，也另给最多 2 秒的分页补证预算。这不增加发送次数、不延长执行授权，也不覆盖原失败回执。

实际发送次数与补证次数分开。`actualSendAttemptCount` 只保存已观测的调用次数；在意图写入后、调用次数保存前崩溃时，以发送阶段保留未知，也禁止重发。历史接受追加为 `historicalAcceptanceEvidence`，不覆盖原 `delivery_failed` 回执，也不直接授予当前分支执行资格。

启动与持续 pending 清扫通过 `codex-native-prompt-delivery-acceptance-reconciliation.ts` 查询自己已托管的会话，不启动 Agent、不发送正文。每 workspace 一趟最多四条，按上次查询时间轮转。当前分支变化与历史接受分别记录；没有本运行时 summary 或 workspace 不符的记录不改写。查询暂不可用时等待下一次扫描，查询不会消耗发送预算。

## 显式停止与主会话唤醒

显式 stop procedure 将原生身份绑定的取消事实持久保存到 workspace 的 `programmatic-review-explicit-user-stop-observations.json`。自然回合结束、Stop hook、闲置回收和内部 force-stop 不生成这些事实。证据写入失败可观测，但不拦住用户停止进程。

插件只有在后续确需主 Agent 且该回合结束时才登记独立唤醒。`kanban task get` 暴露 conversation、原生身份、本代 incarnation 和控制端点；`task message-status` 暴露持久投递阶段与接受历史，供系统交叉核对。未知投递只查询同一 key；用户停止取消对应操作。当前主进程不可用时等待可信托管恢复，不用当前默认模型／权限盲目启动新会话。

源码测试使用隔离 HOME、Git fixture、假服务和真实 Codex TUI／本地模型服务，不能据此声称常驻实例已经加载新实现。部署版本、自然使用中的跨重启补证和源任务恢复各自保留独立证据。
