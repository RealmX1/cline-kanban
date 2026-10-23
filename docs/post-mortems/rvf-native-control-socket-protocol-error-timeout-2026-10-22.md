# RVF 实时查询的协议错误误报与取证边界

任务：cline-kanban/21325。来源事故：ai-analysis/ea403。用户先授权调查和提案，选择“先修已证缺陷并补诊断”后要求实施。本文区分历史事故、隔离复现和实施结果，不将修复误报等同于历史事故根因已消除。

## 事故时间线与结论

以下时间均为 UTC，来自来源任务的工具输出和持久探针，不引用隐藏推理。

| 时间 | 观测 | 判定 |
| --- | --- | --- |
| 2026-10-22 16:16–16:18 | prepare/start 多次返回 `原生实时查询超时：thread/turns/list` | confirmed |
| 16:21:59 | 直接连接当时的活动 endpoint，合法 JSON 响应 1,058,390 字节，558 ms，4 turns，无下一页 | confirmed |
| 16:22:31 | run `rvf-review-start-bfdd14c5402e223b` 完成 prepare，冻结 12 文件；不是审查完成 | confirmed |
| 16:26–16:28 | dispatch 前置或内部再次查询失败，未成功派发 reviewer | confirmed |
| 16:28:00 | 相同 clientInfo 的三个直接探针分别 295/173/139 ms 成功，响应 1,183,815 字节 | confirmed |
| 21:31–21:35 | 本任务原始探针及 helper 成功；3 次 CLI 和 8 次配对 RPC 观测均成功，采样期间 endpoint/会话代次稳定 | not_reproduced |
| 同次调查 | 隔离 WS 服务立即返回损坏 JSON 或不合法 envelope，旧 helper 仍等待到请求期限 | confirmed |

历史失败缺少请求级收发、校验及匹配记录，触发原因保持 **unknown**。当时运行时事件循环延迟有升高，但相关窗口的最大值不足以单独证明 2 秒请求预算被耗尽。磁盘源码、部署记录与当时进程的实际加载代码版本也不能互相替代。

旧任务 222d5 处理的是 stdio 的 LF 分帧；WebSocket 不使用该 decoder。本次合法的 1 MB 级 Unicode 响应、分页和并发乱序均可通过，不能沿用旧根因解释新错误，也不能用单次探针成功宣称 gate 已通过。

## 已复现的缺陷与修复

原 WebSocket helper 在 JSON.parse 或响应 schema 校验失败后静默返回，pending 请求只能由 timeout 结算。响应缺少 `result/error` 时还会成功返回 `undefined`，两者同时出现时会误走原生错误分支。

控制 socket 的连接生命周期现在独立在 `codex-app-server-control-socket-request-connection.ts`，既有入口继续转导出，stdio 行为不变：

- 无效 JSON、匹配请求但非法的 envelope 立即报告脱敏 `protocol_error`，拒绝全部 pending 并关闭本次客户端连接。
- 合法响应必须恰有 `result` 或 `error`；通知、服务端请求和其它 ID 不得误完成 pending 请求。
- 区分原生错误、真正请求超时、连接超时/失败/断开及取消；不传播原始响应、解析异常摘录或原生错误正文。
- 结束时清理 pending、timer、AbortSignal 和自有 socket 监听，再确认本次客户端已关闭。不发送 daemon stop、thread/unsubscribe，不改变原生会话。
- 观测前保存 endpoint 与 transcript 路径快照；原地修改、会话替换或代次变化时不返回有效活动分支观测。

默认请求预算仍为 **2000 ms**，连接预算仍为 2000 ms；已有显式 requestTimeoutMs 调用保持支持。回合查询仍为 `full / limit=100 / asc` 并遍历所有分页。receipt、token、候选、checkpoint、nonce 及当前活动分支门禁均保留。

## 脱敏诊断与归因方法

运行时复用轮转 journal 通道 `codex-native-control-socket-request-diagnostic`，默认位于 `~/.cline/kanban/diagnostic-event-journals/`。诊断回调或写入失败不改变业务结果。

每次观测按 workspace、task、nonce、conversation、native session 和 incarnation 归属；连接另有 connectionId，请求有 requestId、方法白名单、预算、发送/返回计时、字节数、JSON/schema 耗时、匹配分类及清理结果。threadId/cursor/socket 路径只存 SHA256，任意参数和会话正文不进入日志。writer PID/进程开始时间由 journal 权威写入；Node 版本和执行路径为实际进程值，无法证明的加载代码版本明确记为 `unknown`。

下次失败时按同一 nonce 关联这些阶段：

1. 没有 `connection_opened`：检查连接建立阶段及实际 endpoint 归属。
2. 已发送请求但没有完整 WS 消息：保留 timeout 结论，不能推断是网络、原生服务还是调度原因。
3. 收到消息但 `invalid_json/invalid_envelope`：协议错误；与真正无响应区分。
4. 仅有 `unmatched_response`：核对请求路径与响应匹配，不从字节数推断成功。
5. 连接完成后仍缺少 `observation_verified`：检查身份复核结论；不得将连接成功视为 gate 通过。

此处的 frame 是 WS 库交付的完整消息，不是网络分片的到达时间。若主事件循环长时间无法调度，日志不能证明内核实际收包时刻；需要进一步因果复现，不能只凭 loadavg 归因。

## 验收与恢复

自动验收覆盖真实 Unix WS 的损坏 envelope、通知/服务端请求、其它 ID、乱序、大响应分片、Unicode、分页、原生错误、默认预算、迟到响应、取消/断开、清理及诊断失败；运行时测试覆盖观测中身份与 endpoint 的原地修改。Node 22/24 均经 guarded runner 执行，另做独立打包态真实 TUI/CLI/HTTP 跨重启验证。

测试 fixture 的 socket 使用独享短暂存目录，并在结束时清理。guarded runner 的长 TMPDIR 曾产生 142 字节 socket 路径，导致 Node 24 fixture 尚未调用产品 helper 就等待；这是测试路径问题，不是历史生产事故根因，也未据此更改产品超时。

恢复 ea403 时，由来源任务重新核对当前候选、会话、活动回合及有效独立分界。调查时最新用户回合已不同于旧 receipt；不得直接复用旧分界，不得伪造回执、改 token/history 或关闭 gate。正式 prepare、dispatch、reviewer 完成、部署和实际源任务验收应分别记录。

持久交接与可执行验收证据：`~/.cline/kanban/cross-task-handoff-artifacts/task-21325-rvf-native-query-protocol-diagnostics/`。本实现不包含提交、部署、共享 daemon 重启或来源任务开审。
