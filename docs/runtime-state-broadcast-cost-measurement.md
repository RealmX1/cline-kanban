# 运行时广播成本刻度

`runtime-state-hub` 默认记录 `projects_updated`、`workspace_state_updated` 和首帧 `initial_snapshot` 的成本。WebSocket 消息和 tRPC 契约没有增加字段；HTTP `workspace.getState`、all-projects `list/watch`、通知广播与 git 元数据探测不在本刻度范围内。

## 读取与归属

记录复用 `~/.cline/kanban/diagnostic-event-journals/runtime-state-broadcast-cost-window-sample.jsonl`，沿用 journal 的 8 MiB 活动文件及四个轮转分片。测试可经 `KANBAN_DIAGNOSTIC_EVENT_JOURNAL_ROOT_DIR` 隔离目录。

每个 hub 每 60 秒输出一个窗口，关闭时再输出剩余窗口。定时器迟到时 `observedWindowDurationMs` 是实际单调时钟跨度，不能假定每行恰好一分钟。每分钟频率应以计数乘 `60000 / observedWindowDurationMs` 计算；未满一分钟的关闭窗口单列，不与完整窗口等权平均。

分析前必须同时筛选 `journalWriterProcessId`、`journalWriterProcessStartedAtIso` 及 `runtimeStateHubInstanceId`。PID 可能复用，同一进程也可能创建多个 hub。当前 `schemaVersion` 为 `runtime-state-broadcast-cost-window/v2`；历史 v1 保留原记录，不与 v2 发送刻度混算。

```sh
jq --argjson pid 12345 --arg started '2026-10-25T16:00:00.000Z' \
  'select(.journalWriterProcessId == $pid and .journalWriterProcessStartedAtIso == $started) |
   {runtimeStateHubInstanceId, windowStartedAtIso, observedWindowDurationMs, operations}' \
  ~/.cline/kanban/diagnostic-event-journals/runtime-state-broadcast-cost-window-sample.jsonl
```

进程异常退出会丢失尚未输出的内存窗口。journal 是 best-effort，写入失败不阻塞推流，也不无限积攒重试；缺窗表示证据不完整，不能当作零成本。部署后须重新绑定进程启动代，不能沿用旧实例样本。

## 数值口径

三类操作分别聚合在 `operations` 中。`startedOperationCount` 归开始窗口，`completedOperationCount` 与阶段成本归操作结束窗口，`inFlightOperationCountAtWindowEnd` 表示窗口边界仍未归账的操作。跨窗时不能要求单窗开始数等于完成数。

每个阶段有 `completedStageCount`（已结束，包含失败）、`failedStageCount`、`totalDurationMs` 和 `maximumDurationMs`：

| 阶段 | 含义 |
| --- | --- |
| `projects_payload_build` | 广播使用的完整 projects 构建，包含异步等待 |
| `workspace_payload_build` | workspace 完整快照构建，包含异步等待 |
| `payload_json_stringify` | 业务消息一次完整 JSON 序列化 |
| `projects_fingerprint_compare` | 已序列化字符串与既有指纹比较 |
| `websocket_send_loop` | 同步发送循环，包括逐连接判断及成本计数 |
| `payload_utf8_byte_measurement` | 新刻度计算 UTF-8 字节的自身开销 |

首帧的 projects 与 workspace 构建仍并行。所有时长都是墙钟时间；并行构建、并发广播或异步等待的累计值不能相加后冒充 CPU，也不能视为互斥的耗时分解。首帧通知读取、workspace 元数据更新等未单独插桩的工作可能出现在操作总耗时中。

首帧的一支构建失败时，业务仍按原逻辑提前返回；已启动的另一支自然结束后，记录器才把该次操作一起归账。因此故障操作的总时长可能超过业务报错时间。关停时仍未结束的操作保留在途数，迟到完成不改写关闭窗口。

`outcomeCounts` 区分完成、去重、过期丢弃、无连接早退、首帧途中断连及操作失败。构建失败没有伪造序列化计数；过期结果仍保留实际已执行的构建和序列化成本。workspace 的无连接早退不包括原有的跨项目通知刷新路径。

`totalSerializedPayloadBytes` 是转换为逐连接 v2 差量之前的候选业务消息字符串的 UTF-8 字节，`maximumSerializedPayloadBytes` 是其中最大候选消息。workspace 与首帧字节包含对应的消息信封；首帧还包含 projects、通知等字段，不代表单独的 workspace 子对象大小，也不代表最终发出的帧。不会为测量子对象另做一次序列化。

v2 的 `webSocketSendAttemptCount` 只计 OPEN 连接上的 `client.send` 调用；`webSocketAcceptedSendCount` 计未同步抛错的调用，`webSocketThrownSendCount` 计同步抛错，关闭连接另计 `webSocketClosedClientSkipCount`。消息解析、差量转换或序列化失败另计 `webSocketMessagePreparationFailureCount`，此时没有尝试发送。`webSocketSubmittedApplicationPayloadBytes` 累计最终提交给 `client.send` 的 UTF-8 字节，包含 v2 差量／版本／首帧信封。它是压缩前应用载荷，不包含帧头、压缩和 TCP 开销，也不证明浏览器收到或绘制完成。逐连接去重、过期版本跳过计入 `webSocketDeduplicatedClientSkipCount`，不计发送次数或字节。握手待首帧连接的跳过次数单列为 `initialSnapshotAwaitingClientSkipCount`。

历史 v1 的 `webSocketAcceptedSendPayloadBytes` 实际按转换前的候选完整载荷乘「accepted」次数计算；当时逐连接去重也返回 accepted，因此其发送次数和字节都可能高估。不能将该字段解释为实际网络流量，也不能通过重命名字段把旧值升级成 v2 证据。

每类最多保留首条及最慢一条完成操作样本，以 `operationSequenceNumber` 关联同次操作的全部阶段。没有按项目增长的历史 Map，也不保存业务对象、prompt、凭据或异常正文。

## 隔离对照

```sh
KANBAN_BROADCAST_COST_MEASUREMENT_EVIDENCE_DIRECTORY=/absolute/persistent/evidence \
npm run test:guarded -- --project runtime-integration \
  test/integration/runtime-state-broadcast-cost-measurement.integration.test.ts
```

默认全套测试跳过这个有界性能实验；上述命令才是真实执行。实验使用隔离 Git fixture、HOME、journal 和随机端口，真实 registry 热缓存构建与真实 WebSocket；git 元数据监控和通知档案重放使用桩，避免把旁路后台成本混入对照。没有向真实任务投递消息或启动模型。

语料固定为 1／10／30 项目，每项目 20 张合成卡，首项目合成 prompt 约 64 KiB／1 MiB／4 MiB。客户端数为 0／1／4，覆盖无连接、未变化 projects、变化 projects 及 workspace 快照。变化 projects 只在真实构建后改变合成项目名以触发发送，不代表看板缓存失效对照；所有卡都在 Backlog，不代表活跃 agent 的完整字段分布。

每个场景预热三次，执行五组交替 AB／BA 对照。无连接每组 200 次，其余每组 12 次。原始行追加到 `raw-measurements.jsonl`，以 `measurementRunId` 区分运行；同目录保留诊断 journal。循环墙钟和本进程 CPU 单列，窗口写盘耗时另测；没有把子进程 CPU、浏览器消费或网络送达计入本进程 CPU。

T9 判断须结合实际自然广播频率、重复构建／序列化成本和事件循环影响。这个实验可证明阶段分账及本语料中的成本，不能单独证明生产环境需要增量协议；all-projects 多 watcher 的证据闸仍须独立完成。
