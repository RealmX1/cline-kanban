# Codex 未答问题在回收恢复后丢失及问答历史缺失

来源任务：36156。修复任务：419e6。调查版本：local main / task HEAD `ac8502b1786fa4bc42ab7a8615c9377240083da5`，Codex `0.163.0`。

## 事件与证据边界

原生对话：`01a147e5-2f4c-77c2-834d-a1f23008f27e`；问题 id：`reclaimed_session_recovery_gesture`。以下时间均为 2026-10-17 UTC。

| 时间 | 证据 |
| --- | --- |
| 03:32:52.378 | 旧 rollout 第 210 行：`response_item/function_call`，工具 `request_user_input`，call id `call_1ae0d4283ce749ca9cce2de27f092849`。调用的 `status=completed` 不表示用户作答。 |
| 03:32:52.815 | hook 资源日志第 5162 行：`PreToolUse/request_user_input` 已到 Kanban，却被路由为 `activity`；旧 incarnation `7e52e6c5-23bf-459a-96da-f692442d8e72`。日志没有 call id，关联依据是工具名、时刻与 incarnation。 |
| 08:38:17.895 | session summary 确认旧进程回收，原因为 `response_generation_grace_period_expired`，使用了强制升级。 |
| 20:01:05.586 起 | 新 incarnation `112074e6-39bf-44b2-8e56-898e8c53d857`；随后有环境注入及用户要求恢复问题的消息。 |
| 20:05:08.213 | 恢复后的新 rollout 第 22 行重新提问，新 call id `call_39704c2d7a924175a09e396483f3f6ec`，复用了问题 id。 |
| 20:33:58.548 | 新 rollout 第 24 行：`retained_context/verified_answer`，精确关联新 call id，记录用户选择“保留打开、聚焦和重启按钮”。 |
| 20:33:59.806 | 第 25 行：匹配新 call id 的 `function_call_output`，`answers[questionId].answers[]` 保存真实答案；相邻 PostToolUse 也到达 Kanban。 |

来源会话已确认旧工具返回 `aborted`，没有答案。本次读取的两份 raw rollout 未找到旧 call 的配对工具结果，不能编造旧取消结果的落盘时刻，也不能把新答案记给旧 call。

旧文件名：`rollout-2026-10-16T23-26-04-<native-id>.jsonl`；新文件名：`rollout-2026-10-17T16-03-54-<native-id>_01a14b76-bb96-78d0-b57b-94db3a6a0315.jsonl`。恢复文件以 `history_base.end_byte_offset=1189454` 引用旧文件前 213 行；不能拼入父文件之后的分叉尾部。根文件同样可以声明 `history_mode=paginated`，但 `history_base=null`。

后续真实恢复段 `rollout-2026-10-17T17-35-00-<native-id>_01a14bca-21c9-7f62-acab-1bd026daa1ee.jsonl` 的 `history_base.thread_id` 是父 rollout id `01a14b76-bb96-78d0-b57b-94db3a6a0315`，不是原生对话 id。其字节边界 `1771392` 对应父文件前 429 行，加祖先 213 行，恰为累计 `end_ordinal_exclusive=642`。因此每一层都必须按明确的父 rollout 身份定位并校验累计边界；不能按时间取最近分片，也不能要求各层父 id 都等于根原生 id。

调查时 workspace 决策账本恰好 200 条，其中本任务 0 条。现存记录数量不能证明从未入账；实时路由和捕获代码本身已经足以解释漏捕。

## 因果链与实现

1. 旧实时采集只认 Claude `AskUserQuestion`，Codex Pre/PostToolUse 均按普通活动路由；问题没有进入 durable 决策与 question facet。
2. 旧补录只使用卡片初始化来源字段。本事件卡片无该字段，summary 却已有精确原生 id 和 transcriptPath。即使进入旧补录，新文件的 UUID 后缀也不匹配；环境消息或恢复请求会阻断补录，任意配对输出还会被当作已解决。
3. 旧历史回填只读 Claude 转录。Codex 中确实存在的新答案无法显示。前端依赖服务端结果，无法自行修补这条链。
4. 回收代码只给已有 pending 标记 reclaimedAt，不删除问题。原生 TUI 选择器是进程内交互状态；其消失不能证明问题已经回答。

修复将 Codex 专用参数与结果提取用于实时 hook 和恢复投影。PreToolUse 路由到 question 边界并同步落盘；PostToolUse 按原生 question id 读取答案。中断、取消、失败和部分答案均保留待答事实；部分答案只保存草稿。普通用户消息、环境注入和恢复请求不自动表示跳过；显式面板取消是持久的关闭事实。

新记录以 workspace/task/native-session/call 定位；原生 question id 只标识调用内部的问题，不能跨 call 合并。同文重问独立记录，旧结果不得按正文了结后继调用。旧版本未带 native-session 的 Codex 记录保留原 id，不重新创建或复活已答、已取消项。

恢复读取仅枚举已知 id 的文件名、校验 session_meta 并读取有界分页链；默认 32 MiB。损坏、身份不符、文件缺失或预算不足时显示读取不完整，不据此创建待答或推断已答。精确配对且问题正文边界吻合的 verified_answer 也可证明真实作答，避免用户提交后进程在 PostToolUse 结束前退出而丢失答案。

完整恢复对账先回填所有已有调用的真实终端答案，再创建后继问题；即使后继 hook 已把旧调用标成 superseded，也只凭同会话、同调用的完整转录答案回填旧历史，不清掉新题。面板答案尚未送达（包括投递中或失败）时，同会话、同调用的完整真实终端答案可以成为权威结果；已确认送达的面板答案仍保持终态。无答案的 aborted、错误身份或不完整答案不能覆盖它。

问答历史合并 ledger 与同一 Codex 投影。未答的中断/失败有独立标签；有后继提问则记录被新问题取代。pending、未送达答案及 Codex 面板作答/取消的关闭事实不受普通 200 条历史裁剪影响，因为原生转录可能仅留下 aborted。

## 恢复后答题与投递

- 原 incarnation 仍停在 Codex 选择器时，面板可以查看和编辑草稿，提交按钮禁用并引导终端作答；不复用 Claude 的 Esc/输入框语法。
- 先前 incarnation 的未答问题默认展开。提交先保存答案并作废旧回收期限，再复用既有按持久原生身份恢复的入口。
- 在真正写入粘贴内容、首个提交 CR 和补发 CR 前，均重新读取原生记录；身份不符、记录不完整、已在终端回答或已被新题取代时不发送。异步核验返回后再次校验当前活体与投递代际，防止排队期间状态改变；已在核验中的旧确认链也会随新投递失效。没有可用普通输入框时由现有就绪与投递回执链判失败，保留答案和原因。
- delivered 维持终态；重复提交或重启不会重复发送。已在终端真实作答的旧请求不能被面板的陈旧操作重新投递。

pending/history 查询使用有界、单飞的恢复缓存。缓存命中仍检查已知文件和目录身份及变化，内容或恢复链发生变化时重新读取；无变化时不反复枚举目录、读取正文和全量投影。实际答案投递的每个写入前保护继续调用原始恢复读取，不使用查询缓存。

## 自动化覆盖与重跑

| 场景 | 覆盖 |
| --- | --- |
| 正常提问/作答 | 原生工具名、hook 路由、人轴、逐问原生 id、结构化结果与历史展示。 |
| 未答回收/resume | 实际 hook ingest + 磁盘账本 + 回收标记 + summary incarnation 切换 + runtime API 恢复投递。 |
| aborted/失败/部分答案 | 无答案不标 answered；真实部分答案保留为草稿。 |
| 后续输入 | 环境注入、恢复请求及普通消息均不冒充答案。 |
| 重复恢复/迟到结果 | 同 call 幂等，同文新 call 独立；旧结果不清掉新问题，投递只发生一次。 |
| 分页/截断/预算/身份 | UUID 后缀、三代恢复、明确父 rollout id、兄弟分叉、累计 ordinal 与整行字节边界、错误身份、歧义、缺失及超预算。 |
| 旧答案回填与投递失败 | pending/superseded 的旧调用真实答案回填；未送达面板答案可由精确配对的完整终端答案替代；错误身份与已送达状态保持保护。 |
| 写入前竞态 | 入队、就绪等待、争用等待、粘贴后首个 CR、补发 CR 期间出现真实答案或后继题，均阻止陈旧投递；对话/活体/投递代际切换同样受保护。 |
| 查询缓存 | 单飞、命中不重放；追加、截断、同尺寸改写、inode 替换、身份、父链和新恢复目录变化失效；实际投递保持新鲜读取。 |
| 浏览器/runtime 重启 | 隔离 HOME、独立打包 runtime、真实 Chromium、真实 tRPC；无 ledger 时恢复待答，刷新保留记录，重启后新答案回填历史且不复活旧题。 |

运行 Node 应与本 checkout 的 better-sqlite3 ABI 一致；本机使用 `/Users/bominzhang/.nvm/versions/node/v24.12.0/bin/node`。不为测试重编共享依赖或重启真实 runtime。

```sh
npm run test:guarded -- --project precommit-safe test/runtime/agent-session-history/codex-user-question-transcript-recovery.test.ts
npm run test:guarded -- --project runtime-integration test/integration/codex-user-question-recovery-and-history.integration.test.ts
KANBAN_RUN_CODEX_QUESTION_BROWSER_TESTS=1 npm run test:guarded -- --project runtime-integration test/integration/codex-user-question-packaged-browser-restart.integration.test.ts
```

浏览器测试需先 `npm run build` 且本机安装 Chrome；其 runtime 使用 auto 端口及隔离环境，不连接 3484，不启动真实模型。合成状态通过项目 fixture 建立，不向真实 HOME 的关系账本制造测试数据。

## 集成边界

RVF 前已单向吸收 local main `9564d7c45379789725b9dc580691521267be56cb` 的来源任务终端修复，完整恢复本任务 WIP，并在释放 base 锁后执行审查与验证。本任务未提交、未部署。3de7b 对共享文件的改动集中在 prompt 草稿匹配；用户已授权本任务在独立 worktree 并行修改 Codex 问答逻辑。集成时须复核 hooks.ts、hooks-api.ts、api-contract.ts、card-detail-view.tsx，保留两边的语义，不吸收 sibling WIP。

真实已运行 Codex 的 hook 事件、自然回收及真实原生 TUI 行为仍需部署后在自然使用中观察；不得通过本次修复宣称这些真实集成已经验证，也不为了验证停止真实会话。

## 部署后验证登记

- verificationId：`d64fb190-4d36-4907-aaa2-6e34c867b3d8`；类型 `guided_manual`；已注册，尚未运行。
- assetsDir：`/Users/bominzhang/.cline/kanban/verifications/d64fb190-4d36-4907-aaa2-6e34c867b3d8`；cleanup：`automatic`。
- 部署后预计挂载：自动脚本 0 项、自然使用中观察 1 项；没有把源码测试通过当作真实实例通过。
- 定义与注册回执保存在持久交接目录 `task-419e6-post-deploy-verification.json`、`task-419e6-verification-registration.json`、`task-419e6-verification-list.json`。
- 兜底清理：`kanban verification cleanup --verification-id d64fb190-4d36-4907-aaa2-6e34c867b3d8`。没有临时 repo instrumentation，无需移除插桩。
