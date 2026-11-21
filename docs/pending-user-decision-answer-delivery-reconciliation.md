# 问答答案的送达核验与人工关闭

## 实施合同

答案确认超时不能证明没有发送。本次变更覆盖持久账本、终端与 ACP 投递、Queue 观察、tRPC、共享问题面板及问答历史。核验只读取证据，不发送输入、不启动 agent；未知结果不自动重发。初始实现阶段不包含提交、同步或部署；用户随后授权在 RVF 基本完成时提交并调用 `base-branch-sync`，部署仍不在授权范围内。两席主体审阅、7 类已知问题修复及相关验证已完成，原 RVF 的退出证据尾项继续保持 unknown，不冒充完整评审通过。

按三个可独立验证的切片实施：送达状态与尝试身份；只读补证与重启恢复；共享面板和人工关闭。先添加超时、重试身份及人工确认的失败测试，再实现状态机；随后补充后台退避、真实文件读取和打包态浏览器验证。

## 状态与证据

| 状态 | 含义 | 可用操作 |
| --- | --- | --- |
| `answer_recorded` | 答案已保存，尚未进入发送尝试 | 投递 |
| `delivery_in_progress` | 原执行仍负责发送，或尚不能证明已退出 | 只读核验；等待发送收敛 |
| `delivery_failed` | 已明确证明本次未发送 | 先核验，再创建独立尝试重投 |
| `delivery_unconfirmed` | 输入可能已提交，接受证据不足 | 只读核验或人工确认处理 |
| `delivered` | 持久回执或关联的原生接受证据已确认 | 仅回看 |

每条答案保留稳定逻辑键，每次合法投递有独立 `attemptId` 和 `dispatchIdempotencyKey`。实际提交、注入账本和 Queue 使用同一尝试键。新正文通过 `answerMessageFormatVersion=2` 携带尝试标识，避免同文但不同问题互相认领。账本保存原执行身份、目标原生会话、正文 SHA-256、提交阶段、可用的转录提交前位置及原始回执。更新时再次比较当前尝试，旧结果不能覆盖新尝试。

补证先查询对应 Queue／注入账本回执，再复用 Codex 原生接受查询；PTY 后备读取必须匹配原生会话、工作目录、带尝试标识的正文和提交前位置。旧正文仅凭精确持久回执补证。Claude 使用现有用户输入记录解析器。单次转录读取最多 256 KiB，持久保存游标与最多两个匹配；转录缩短或文件身份改变时不得回扫到提交前；多个原生用户消息命中同文时保留歧义。历史补证不发布新的输入接受边沿，也不覆盖原始失败回执。

ACP 补证读取所属服务的接受快照，严格比较尝试键、agent、原生会话及 runtime incarnation；迟到接受监听与自动清扫复用同一路径。提交前连接丢失／请求繁忙沿现有回调保存真实原因。`submissionMayHaveStarted` 同时进入原始回执与注入账本；恢复时先检查写入阶段，不能把写入后的同名失败原因当成未发送。

## 自动恢复

自动核验复用已有运行时清扫链，答案状态变更请求更早的核验时刻，不建立另一套调度器。超时后、任务打开、原生接受变化及运行时启动均可触发。无新证据按 15／30／60 秒退避，随后暂停昂贵的接受读取；转录、对应回执或控制端点变化后恢复。转录持续分页时继续有界读取，部分未完成行没有进展时仍退避。

原执行活性使用运行时身份和三态心跳；不能把“另一个实例刚启动”或“过去很久”当作原执行已退出。已知原执行在提交前退出，或已有明确未发送的持久回执，可恢复重投资格；提交可能开始后退出只能恢复为未知。旧记录可通过唯一关联的 Queue 回执及托管者补证归属。旧记录没有 attempt 或 Queue 时迁为送达待确认，执行归属仍为 unknown，允许独立人工关闭，不据此授权重投；已有活跃执行证据时继续等待。

## 人工确认

已保存答案默认折叠；换代、刷新和导航不会重新展开。未回答问题沿用原来的展开规则。仅保存、尚未认领投递的 `answer_recorded` 保留“投递已保存的回答”入口。“重新核验送达”不发送答案。“我已在终端确认处理”保存时间与 `kanban_panel_terminal_confirmation` 来源，阻止之后的投递；仍在发送时先等待其收敛。

问答历史显示“用户确认已处理”，保留原有 `answerDeliveryState`，不把人工观察改写为系统证实送达。关闭事实独立于临时浏览器状态，并且不受普通历史条数裁剪影响。

## 本次验证结果

- 根项目相关 guarded 测试共 338 项通过（15 个文件，含打包态浏览器重启及注入账本兼容性用例）；策略检查与 invoking repository canary 通过。
- Web 相关测试 100 项通过（5 个文件），根项目 typecheck 与 Web typecheck 均通过。
- 23 个变更 TypeScript／TSX 文件的 Biome 检查通过；`git diff --check` 通过。
- 隔离构建通过，未改写主仓库的共享 `dist` 或 `web-ui/dist`。
- guarded 与打包态运行验证使用 Node 24.22.0，匹配现有 `better-sqlite3` ABI 137；Node 22 下完成了类型检查，没有改动共享原生依赖。

独立 RVF 已发起，精确目录为 `~/.rvf/user-local-data/task-snapshot-reviews/task-review-cc592db9fcc9449d87541ce68d146a50`。两席发现的 7 类问题已在本工作树修复，并增加 13 项后端边界回归及 1 项面板回归。原 run 的机器补证命令报告 291 项测试通过，但 macOS 原生后代退出观测存在缺口，正式状态仍为 `machine_evidence_pending`，不等于完整评审通过；修复后的工作树尚未获精确 RVF 覆盖。保留原 run、原候选和未知事实，等待可信原生退出证明或宿主启动身份变化后接续缺失步骤，不另起 run 绕过缺口。

## 验证入口

- `npm run test:guarded`：问答存储、投递、补证、Codex 写前核验、原生问答恢复和清扫调度相关测试。
- `npm run web:test`：共享问题面板、问答历史、草稿和详情宿主相关测试。
- `npm run typecheck`、`npm run web:typecheck` 与变更文件的 Biome 检查。
- 在隔离 `dist` 和 `web-ui/dist` 后，显式指定 `KANBAN_BUILD_DISTRIBUTION_OUTPUT_DIRECTORY` 构建。
- `KANBAN_RUN_BROWSER_DEPENDENT_RUNTIME_RESTART_TESTS=1 npm run test:guarded -- --project runtime-integration test/integration/pending-user-decision-answer-confirmation-browser-runtime-restart.integration.test.ts`：本机 Chrome、独立 HOME／Codex 存储／关系账本与隔离 runtime。

浏览器用例验证默认折叠、手动核验、人工关闭、刷新、runtime 重启与历史归属，并同时检查没有额外回答请求、注入账本写入或新投递尝试。

| 行为 | 部署前已证 | 真实实例待验 | 类型 |
| --- | --- | --- | --- |
| 默认折叠、人工关闭和跨重启保存 | Web 测试及隔离打包态 Chrome 已覆盖 | 无须重复注册相同断言 | — |
| 真实 agent 迟到接受及用户确认来源 | 状态机、原生转录和隔离 runtime 已覆盖 | 常驻实例真实终端／hook 的超时现场、迟到接受只收敛原尝试且不重发 | 引导观察，复现依赖实际现场 |

真实实例已登记 1 条引导观察项，`verificationId=268fd5dc-312d-5cba-b742-5397eb614f18`，资产目录为 `~/.cline/kanban/verifications/268fd5dc-312d-5cba-b742-5397eb614f18/`，清理模式为 `automatic`。该项依赖真实超时现场，不是确定性模型桩可以替代的常驻 agent／hook 集成断言；本次只登记定义，没有执行、勾选或部署，后续部署登记预计挂载 0 条自动脚本、1 条引导观察项。

定义已用 `verification list --task-id 46337 --project-path /Users/bominzhang/Documents/GitHub/cline-kanban` 自查；不适用自动脚本 dry-run。兜底清理命令：`kanban verification cleanup --verification-id 268fd5dc-312d-5cba-b742-5397eb614f18`。本变更没有验证插桩。
