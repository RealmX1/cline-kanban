# 所属执行的简短后台事件与主会话打断策略

本次实现由 `review-validate-fix/a278b` 的用户批准方案覆盖；本工作树只承担该方案的 Kanban 部分。RVF 的阶段判断在生产方，Kanban 继续提供通用所属执行、消息投递和重启恢复。

specification 可声明：

```json
{
  "ownerSessionInterruptPolicy": "preserve_execution",
  "continuationNoticesFile": "/持久run目录/agent-continuation-notices.json",
  "producerExecutionRevocationFile": "/持久run目录/execution-revocation.json"
}
```

`ownerSessionInterruptPolicy` 默认 `cancel_execution`。声明 `preserve_execution` 后，终端 Esc/Ctrl+C 只打断主会话，后台执行继续。显式执行取消和任务停止仍撤销全部匹配执行，持久保存 `source`、`scope`、`requestBasis`。旧撤销原件原样保留，不从信号或 transport 身份推断真人来源。幂等材料把缺省策略与显式 `cancel_execution` 视为同一份；重试既有执行不因补上默认字段而冲突，也不改写已保存的摘要。

ACP 的取消当前回合也传递 `current_agent_turn` 范围，使用相同的所属执行保留策略；整任务会话停止继续使用整任务撤销范围。不能把取消单次聊天回合解释为撤销整个后台工作。

生产方以原子替换保存事件清单：

```json
{"notices":[{"noticeId":"稳定修订ID","stage":"生产方阶段名","text":"简短结论、需判断事项、持久摘要入口及既有授权边界"}]}
```

noticeId 最长 256 字符，stage 最长 80，text 最长 2000；同 ID 正文不可变。更换结果时生成新 ID，将失效事件从当前清单移除，原业务原件与接受历史继续保留。终态业务结果也可直接提供相同结构的 `agentContinuationNotice`。已声明事件清单时，以清单决定当前资格，不能从旧结果反向恢复已撤回通知。

事件可声明 `requiresCurrentResultNoticeMatch: true`，要求当前业务原件的 `agentContinuationNotice` 与清单中的该事件完全匹配。写入前重新读取业务原件，正文、阶段、身份或该声明不同就不投递。这让生产方先原子更新业务资格、再更新清单时的崩溃窗口保持安全；清单先出现新事件但业务原件尚未发布时同样等待。无需绑定当前业务结果的独立阶段事件仍可异步交回。

`producerExecutionRevocationFile` 是启动时绑定的生产方持久撤销原件绝对路径，出现后收回派发与投递资格，并通过既有取消入口保存宿主撤销与取消观察。该门禁在异步核验及实际写入前重查；即使生产方在保存撤销原件后、改写业务结果或清单前崩溃，也不会恢复执行。路径存在性无法核实时保留未知并阻止对应动作，不推断为已撤销或不存在。

Kanban 复用原生投递机制，`resultDelivery` 保存当前尝试，更换通知时追加 `resultDeliveryHistory`。接受未知先对账；已接受的同一事件不重复发。忙碌状态只推迟投递，不阻止后台进程或独立机器恢复。实际写入前重新核对执行归属、撤销与事件仍然有效。结果缺少专用通知时，通用回退仅发送状态及原件路径，不再序列化业务 JSON。

迟到输入导致生产方需要接续时，可返回 `machine_evidence_pending`，在 recovery 中提供 `action: resume_same_run`、稳定 `continuation_request_id` 和相关 `evidence_paths`。新登记请求可触发一次原 run 恢复，不把首次观察只记为基线后永久等待；恢复指纹包含该请求身份，因此更换身份不会被同一证据的重试预算压住。未变化重试继续受原预算约束，实际派发仍核对 owner、进程、单飞及撤销。

生产方负责摘要和当前资格；事件文字不新增提交、同步、推送或部署授权。本协议不恢复旧 RVF 自动 closeout、Land 或 rewind 编排。
