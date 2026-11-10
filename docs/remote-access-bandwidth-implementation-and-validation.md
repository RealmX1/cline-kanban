# 远程访问省流：实现与验证

本任务以 `935f2777b014e885cb34011b278a074d54dc4c61` 为源码基线实施。用户后续授权先精简过量测试，再提交并执行 `base-branch-sync`；部署仍需另行授权。

## 已实现行为

HTTP 静态文本与 tRPC JSON 统一协商 gzip/Brotli，阈值 1 KiB、压缩级别均为 4。哈希资源缓存一年并标记 immutable；HTML、service worker 和 manifest 继续重新验证。静态资源采用弱 ETag，跨编码条件请求返回无正文 304，并保留 Vary: Accept-Encoding；业务 API 为 private, no-store。

状态流开启无上下文复用的 permessage-deflate，阈值 1 KiB、并发上限 4。浏览器声明 `stateProtocolVersion=2`：每条基线和增量携带 runtime 代际、workspace 及顺序号。项目基础信息与两类任务条目、卡片与列顺序、会话、git 元数据分别按稳定实体键增删。新连接建立自己的基线；首帧期间变化定向补齐，迟到构建不覆盖已发布的新状态。

首份 WebSocket 快照直接水合工作区；显式刷新、保存冲突和既有三方合并继续保留。版本缺口、缓存缺失或代际变化会暂停增量应用并自动补完整快照，最多主动重试三次。耗尽后保留现有内容与错误；连接、源版本、代际或订阅范围变化后接续。慢连接超过有界发送缓冲后重建基线。

| 查询 | 归属与返回内容 |
|---|---|
| `deployment.getPostDeployVerificationWorkspaceOverview` | workspace 概览、活跃组、历史标题、计数和内容版本，不带任务正文 |
| `deployment.getPostDeployVerificationDeploymentGroup` | workspace + deployment；已知内容版本未变时只确认版本 |
| `workspace.getChangesConditional` | 复用现有变化缓存；内容版本排除 generatedAt，未变时不重复返回 diff |
| `workspace.readTaskCardsForPostDeployVerification` | 每批最多 100 张指定卡、当前列和关联会话摘要 |

PDV 每 30 秒及页面恢复可见时对账。折叠时只取概览；展开活跃组、历史组或显式定位时才取相应详情。详情错误独立展示；失败不视为历史清理，也不阻塞无关组和概览。缓存、读取顺序、乐观勾选及写入回包均受 workspace 归属和代际保护；关闭面板停止跨项目卡片轮询。原完整接口与服务端 Done 门禁保留。

浏览器会话投影剥离 `agentSessionForkReplayLaunchArguments` 和 `codexNativeSessionControlEndpoint`；同代回存保留服务端原件，原生接口和持久记录继续保留全文。prompt、评论及用户可见活动文本不裁剪。通知日志跳过完全相同广播；PTY 诊断只向设置面板订阅者发送，并按 250 ms 窗口合并失效通知。

## 终端策略

按观看者区分连续输出、等待快照和暂停输出；暂停不停止 Agent、服务端镜像或其他观看者，也不积压隐藏输出或加入共享 PTY 背压。等待 prompt 等操作临时持有连续接收需求。恢复核对输出版本，并沿用双通道快照、旧 IO 隔离及 restore_complete；失败或协议不支持时回退连续接收，恢复本身不触发 Agent 重启或自动续跑。

隐藏页面和切换任务是独立实验，任务切换保留五秒连续接收窗口。选择处保留 `EXPERIMENT_NODE:`；默认开关根据下述实测门槛分别决定。

## 验证口径与环境

性能基线从上述提交独立导出并构建，未使用 11 月 2 日采样作分母。语料包含 31 个项目、700 张卡、950 条会话及 21 个部署组；持续输出场景另有一个真实隔离 shell，每秒约 20 行输出，并回放相同看板与会话变更。正文是固定中文样本，不能将其压缩率直接外推到真实用户内容。

Node 22 下隔离 HOME、CODEX_HOME、原生存储、Git fixture 及构建输出。dist、web-ui/dist 和根 node_modules 为本任务独立目录，没有更新共享分发产物。私有安装为 Node 22 重建 better-sqlite3，并按已钉死的 graph 依赖提交恢复过期 dist；未改依赖 pin 或共享安装。

正式矩阵为 1/4 页面 × 空闲/持续输出，各做三轮五分钟基线与候选对照，轮次间交替执行顺序。分别统计业务 JSON 与压缩后的 HTTP/WebSocket 字节、首次加载、稳定回放和新增连接首帧。字节来自真实 TCP 接收，包含 HTTP 头、压缩正文及 WebSocket 帧，不含 TLS/VPN 外层；管理端注入请求不计入浏览器流量。四页面共享浏览器静态缓存；git 探测范围混合全量与聚焦订阅。

runtime CPU 指主进程 process.cpuUsage 的用户态和系统态总和；事件循环 p95 来自 monitorEventLoopDelay。浏览器、语料注入、git 与 shell 子进程 CPU 不在此指标内。普通 API p95 与真实浏览器 50 次 PDV 展开交互分别记录；浏览器交互同时回放 25 次看板和会话更新。

所有持久证据在 `/Users/bominzhang/.cline/kanban/task-artifacts/3fed0/remote-access-bandwidth/`，包括原始 JSON、日志、截图、源码快照、完整差异和构建指纹。相关受保护测试、Web UI 测试、根/Web typecheck、Node 22 独立构建与真实浏览器回归记录在该目录。

## 实际结果

已完成 24 场三轮五分钟正式回放；12 组逐轮配对均通过首屏、持续流量、主进程 CPU、API p95 与事件循环 p95 门槛。下表为三轮中位数。

| 页面 / 场景 | 首屏比例 | 持续流量减少 | CPU 变化 | API p95 增量 | 事件循环 p95 增量 |
|---|---:|---:|---:|---:|---:|
| 1 / 空闲 | 5.40% | 99.44% | -2.11% | +3.75 ms | +0.00 ms |
| 1 / 持续输出 | 5.24% | 99.91% | +1.79% | +4.38 ms | +0.03 ms |
| 4 / 空闲 | 1.66% | 99.58% | -0.25% | +1.30 ms | +0.02 ms |
| 4 / 持续输出 | 1.62% | 99.91% | -7.57% | +9.54 ms | -0.05 ms |

真实浏览器的完整冷加载为 24.47 MB → 1.33 MB；相同 25 次看板/会话更新期间，50 次已缓存 PDV 展开交互 p95 为 240.31 ms → 92.81 ms。All projects 下验证仅取所需的 40 张卡，关闭面板后停读。

终端网络整形覆盖数据与初始升级请求，两方向各 40 ms、10 Mbps。104 次切回均通过历史、alternate buffer、鼠标模式和恢复后输入检查。任务切换暂停的额外 p95 超过 100 ms；页面隐藏事件只经浏览器内模拟，缺原生可见性证据。两项默认均关闭，实验入口和 EXPERIMENT_NODE 保留。

后续 RVF 两路评审发现四类边界问题，现已修复：App 权威会话集合参数透传、历史定位后的详情持续刷新、首帧失败后的有界恢复及通知重放锁竞态、不同核对项乱序回包互相覆盖。修复后的根项目相关回归 107 项、Web UI 170 项、两处类型检查与 Node 22 独立构建通过。

修复后真实浏览器复验通过；追加性能矩阵完成两轮、16 场后，按用户减少过量测试的要求撤销，保留原始采样。它不是完成了三轮的矩阵，不覆盖前述原候选 24 场正式结果。

每轮字节、CPU、延迟、终端门槛与统计限制详见持久目录的 `performance-report.md`、`performance-summary.json` 和原始 `runtime-replay-results.json`。

## 常规回归与专项测量的边界

常规测试保留压缩与条件读取、增量同步与恢复、PDV 读写归属、会话删除接线和终端协议等功能回归。专项浏览器／网络整形／五分钟性能矩阵已经完成任务验收，不作为常规测试和类型检查输入，也不因一般修复自动重跑。

原 `test/performance/` 的 8 个测量文件约 1,734 行，已逐字核验并归档到上述持久目录的 `post-rvf-validated-source-snapshot/test/performance/`，随后移出源码树。完整重建基线保存在 `baseline-source/`，完整候选差异为 `post-rvf-validated-source.patch`；需要重新标定传输或热路径时，可在隔离 checkout 中恢复原布局，通过受保护测试入口显式运行。归档不删除历史报告、采样、截图或 PDV 资产。

## 真实实例待验

已通过 PDV authoring 注册两项自动脚本与一项设备观察项，沿用相同 verificationId 幂等 reconcile。脚本和定义保存在 registry 返回的 assetsDir，不依赖任务工作树。旧实例 dry-run 正常报告尚无新行为，未执行部署后验证或勾选。

真实 Tailscale 路由、部署资产、真实设备可见性、实际 Agent 的后台状态与恢复后输入仍待部署后核验。注册清单、分析表、dry-run 和兜底清理命令见持久目录 `post-deploy-verification/post-deploy-verification-report.md`。
