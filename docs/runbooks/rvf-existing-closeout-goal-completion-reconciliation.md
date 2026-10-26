# RVF 既有收尾目标的完成观察与恢复门禁

历史原协议结果、实际收尾目标和当前执行资格分别处理。正式 Land 被拒后由另一条已授权路线完成提交与整合，不等于原协议成功；已接受的旧 Land 也不因当前候选被后继 run 替换而失效。

`existingCloseoutGoalCompletionReconciliation` 是服务端独立观察，按 workspace、task、token、run、handoff、完整开审 receipt 摘要和 Git common directory 绑定。它保存 `verifiedStages`、原件摘要、内容寻址快照、冲突或机器待验缺口、分页位置及重试预算。客户端没有自行声明这一观察的写入口。

| 事实 | 调度 |
| --- | --- |
| 所需阶段均已核验完成 | 停止该旧 run 的恢复、fork、阶段认领和原始/continuation 投递 |
| 原 run 已由正式备用路线消费 | 抑制原路线；具体阶段只按该阶段的独立证据登记 |
| 仅部分阶段完成 | 复用完成事实；剩余阶段仍须有明确机器恢复原因、原生接受和当前执行资格 |
| 旧 blocked 未分类、缺少原生接受或材料尚未查完 | 后台补证并保留恢复条件，不生成 `inspect_existing_state` 消息 |
| 材料冲突 | 保存冲突与来源；不选择 latest、不因冲突重做 |
| Stop、禁止或活动备用接管 | 保持原限制，不恢复执行 |

正常首次激活与收尾沿原有流程运行。真实用户输入、原生会话与代际、操作锁、阶段认领、当前候选资格仍是执行门禁。已认领但结果未知的阶段不得凭超时接管。原生接受只证明指令曾被接受，不能证明排队后出现的新源码已经通过审查。

## 证据来源

优先复用服务端已接受的历史阶段。既有 base 整合核验使用已接受的 Land 与真实 Git 祖先关系，不再读取可替换的当前候选指针。后续执行和当前覆盖仍单独核验。

不可变 Land 规范结果按内容摘要、原 run/worktree、提交对象、父关系及冻结源码摘要核验。正式 supplemental 仍通过 RVF 的 `land supplemental-completion verify`，Kanban 不复制双审判据。

历史手动兼容只读取明确的 `manual-land-actual-execution-receipt.json`、`manual-base-sync-actual-execution-receipt.json` 和 `base-sync-actual-execution-receipt.json`，位置限定为原 run 的 artifacts 或 `manual-closeout-retry-*` 一级目录。支持手动 Land v1、手动 base v1，以及能在同目录与唯一 Land 配对的旧 base 回执。缺少 token 的旧材料必须与原 run 开审凭据、handoff 和源码快照交叉核对。完整提交、真实父提交、冻结源码指纹、任务 tip、整合 tree 与本地 base 祖先关系均由服务端读取 Git 独立核验。材料中的成功、授权或完成字样不授证，不运行历史脚本。

备用路线消费索引只是定位线索。可沿 `completed-operations`、`closed-ownership-markers/<operation>/identity.json` 与同 operation 的持久 `backup-route-delivery-result.json` 查证；索引丢失不等于未完成。具体完成阶段另核验 stage-facts 的原件摘要和 Git 对象。仅证明已消费时，不虚构 Land 或 base 完成。

## 持久补证与单调性

同一输入最多完整核验三次、相隔至少十五秒；耗尽后约六十秒轻量探测。指纹包括材料元数据、源码快照、HEAD、本地 base、Git common directory、目标对象可读性及待恢复原件的位置。输入变化自动重新核验，服务重建不刷新相同输入预算。

每次发现最多读取六十四个候选原件，游标持久保存。未查完只表示机器等待，不能据此断言没有完成。单条任务的缺口不阻塞其他任务。

原件和观察存入 workspace 持久目录 `rvf-closeout-goal-completion-originals`，以 SHA256 寻址。重复扫描复用原件且不重写相同状态。所有收尾记录写回经过单调保护，已接受阶段、完成观察和外部消费不能被迟到恢复 patch 降级；不会因此篡改旧正式拒绝或原投递失败。

## Queue 与在途投递

完成或外部消费后，对精确关联的原始与 continuation 幂等键调用现有取消入口。取消失败保存 `suppressedDeliveryReconciliation` 与重试时间；发送出口独立重读完成、Stop、绑定及接管状态，取消接口故障不会开放投递窗口。

尚未首次写入的条目可以取消。写入已开始、原生结果未知或已确认送达时，保留真实历史，不清空输入框、不更换幂等键重发，也不补 CR。重启后的 dispatcher 使用相同发送门禁。

`rvf-automatic-closeout-status` 与 `task rvf-history` 返回可选的实际完成观察。实际完成不会把 `hasVerifiedCompletedRvf` 或当前候选覆盖改成通过；查询展示原协议仍受阻与目标已实际完成这两个独立事实。

## 验证

单元测试覆盖两个手动历史格式、旧 Land 被后继候选替换、错 task/run/token/repo/摘要、多个目标、分页、三次预算、证据迟到、取消失败、Stop/失锁/换绑/接管竞态及合法剩余阶段恢复。真实 Git 全部经隔离 fixture。

`KANBAN_RVF_PACKAGED_RUNTIME_CLI_PATH=<本任务隔离 dist/cli.js>` 启用 `test/integration/rvf-completed-closeout-packaged-restart.integration.test.ts`，使用隔离 HOME、Codex 存储、关系账本和临时真实实例，核对启动扫描、强制重启后的幂等性、零 Agent 执行、零新增注入以及 refs/WIP 保全。只有部署后的长期实例观察另由已注册自动化验证检查，不由本测试冒充。
