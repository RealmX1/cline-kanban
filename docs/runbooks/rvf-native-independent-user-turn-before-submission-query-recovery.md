# RVF 独立原生回合二次校验的安全恢复

此路径补齐已经通过首次预检、但在实际发送前再次查询原生回合时失败的情况。投递受理、真实用户消息接受和 RVF 独立开审资格仍分别取证。

## 持久边界

| 阶段 | 可观察状态 | 恢复动作 |
| --- | --- | --- |
| 首次预检查询等待 | `nativeIndependentUserTurnPreflightQueryRecovery` | 复用首次 TTL 的既有退避 |
| 已交给 transport、仍未写入 | `nativeIndependentUserTurnSubmissionProgress.submissionMayHaveStartedAtEpochMs=null` | 暂时查询错误持久退避；同 key、同原生 session/incarnation、同前置 turn；原截止不变 |
| 实际写入可能开始 | 上述时间戳非 null，且先于写入持久保存 | 只核验接受证据，禁止重新粘贴或重新调用 `turn/start` |
| 旧记录缺少提交边界 | 可选字段缺失 | 保留未知，不能根据“未看到消息”自动重发 |

二次查询等待记录在 `nativeIndependentUserTurnBeforeSubmissionQueryRecovery`，保存原始错误、首次等待、失败次数、下次重查与恢复时间。退避为 1、2、4、8 秒，随后每次最多 15 秒，并受原 `expiresAt` 限制。查询重试不创建新 key，也不延长意图的有效期。

启动清扫只给确证尚未写入、同代原生活体仍持有的条目恢复托管；原生身份暂未水合时保留等待，明确替换则失败。旧托管者的迟到回执在队列锁内按 key、托管实例和会话代次核对，不能覆盖新托管者。

## 接线与诊断

`TaskChatDeliveryWriteValidator` 的阶段必须贯穿 dispatcher → `runtime-server` → 统一发送出口 → session manager。组合两个 validator 时必须透传参数：丢掉阶段会导致消息成功送达、持久标记却仍为“尚未写入”，从而使重启资格错误。真实原生端到端测试同时核对消息与持久边界，不能只看发送成功。

原生能力和身份错误保留对应 `native_independent_user_turn_*` 原因；实际取消才报告 `cancelled_before_delivery`。错误正文通过 receipt 的可选 `failureNote`、队列的 `lastDeliveryFailureNote` 和账本/CLI 的 `terminal_delivery_failure_detail` 保留。只读查询的暂时失败仍是 pending；pending 不是送达证明。

精确正文已成为唯一后继原生用户消息时，只确认原投递，不再写入。该事实仍不替代 RVF 的 checkpoint、nonce 或独立开审捕获。

## 隔离验收

`rvf-decision-point-target-conversation-session.integration.test.ts` 的常规参数见 `test/README.md`。额外设置 `KANBAN_RVF_SESSION_DELIVERY_INJECT_PRE_SUBMISSION_QUERY_TIMEOUT=1` 时，隔离 fixture 在自己的 Unix socket 上转发真实 Codex 协议，只丢弃一次提交前完整回合查询的响应。测试要求客户端经历真实超时、自动恢复、`turn/start` 恰好一次、精确用户消息恰好一条，并保存非空提交开始标记。

此 fixture 只接触自己启动的隔离 runtime/TUI，模型使用本地响应桩；所有交接证据复制到持久目录。常驻实例、旧故障 token 和其他任务不参与造样。
