# Batch 1 复核与 Batch 2 实施记录（task 041d9）

日期：2026-09-22。接手依据为 `perf-batch1-handoff.md`、`perf-batch1-approved-plan.md`、`perf-batch1-implementation-log.md`，三份均已完整阅读。本轮修改未提交、未推送、未部署。

## 1. 工作区与计划漂移

- 当前工作区为 task **041d9**，不是 handoff 的 3fe15。实施基线 HEAD/local main 均为 `64faca997963cd137d4e86852a7370ccdeb766bf`，HEAD 为 detached；初始工作区干净。
- 按 reconcile / 单向 base sync skill 完成 preflight、local base 锁、匹配 origin/main fetch、吸收检查与边界验证。local main 已包含远端，不需推进；task 无 unique commit，无合并、handback 或 push。锁已释放；bootstrap receipt 在 `.git/worktrees/cline-kanban183/base-branch-sync/local-base-into-task-worktree-bootstrap-receipt.json`（main 的 git common dir 下）。最终模式 `SYNC_LOCAL_BASE_INTO_TASK_ONLY`，`HAND_BACK_ALLOWED=0`、`PUSH_ALLOWED=0`。
- **handoff 第 5 节“6accac9e 尚未进 main”已经过时**：它已是当前 main 的祖先，实施日志的 land 记录与此一致，不能再按旧文回灌。
- 只读调查 223 个 sibling tasks，无需要等待的硬冲突。软关联为 790b2/98e4a（sticky）、8ff17（验证门控）、9674c（独立 workspace）、ay90l（看板异常）、d369f（Focus 样式）、f78bf（推流延迟）；未吸收其未提交成果。调查原始结果 `/tmp/041d9-sibling-task-survey.json`。
- 原行号仅作线索；重新追踪了 App → hooks → 主看板 / Focus / 两处 pinboard / StageHeaderRails。额外发现 `canLinkTasks` 的函数身份会污染 pointer handler，已一并稳定。
- 本轮顺序：只读审计与同步 → Batch 1 实测 → A-P1-1 → A-P1-2 → 全局验证和部署后注册。未扩展到 session store、manualChunks、桌面化或服务端 payload 构建缓存。

## 2. Batch 1 审计结论

`6accac9e` 实际涉及 35 文件（+2262/-117）；B9 撤销涉及的 AGENTS.md、Spotlight controller 与测试在该 commit 中均为零改动。历史 RVF run `rvf-20260828T162256Z-agentic-initiation-start-6e9b08dc` 的 `artifacts/validation-records.json` 已逐项检查，对应缓存文件 SHA256 均匹配，handoff-validation-001…005 有 passed 记录。005 的两条早期 failed 记录仍在，不能将其解释为最终结果，也不能抹去它们。

| 项目 | 当前代码与测试复核 | 结论边界 |
| --- | --- | --- |
| A-P0 | 输入草稿下沉、聊天 memo/Prism、overlay 早退、Focus 卸载与滚动恢复、共享粗时钟、去 motion 仍在 | 未宣称重现原计划全部 Profiler 场景 |
| B1/B2 | 惰性复制、同毫秒 `<=` 接受更新、session applier 旁路仍在；引用与事件路径有测试 | App 约 6.7 次/秒是场景假设，不是已测结果 |
| B3 | observer 仅跳过完全落在 hover-actions 内的 childList；其它结构变化仍刷新 | 真实浏览器抽样见下节 |
| B4 | 图片逐字段比较含 name/data；引用和长度早退 | 不是只比较 data.length |
| B5 | summary 引用短路、board 引用失效、deferred 重试均保留 | 事件 handler 稳定化没有改自动流转 effect 的依赖/判据 |
| B6 | 发送层 fingerprint、新连接 reset、活跃 lastOutputAt 的限制都在 | 每 150ms payload 构建仍发生；不能承诺活跃期 projects 总是远少于 sessions |
| B7/B8 | 共享细时钟 enabled、hover Tooltip 门控、消息 upsert 引用快路、窗口 slice memo 在位 | UI 自身时钟仍会合法重渲染 |
| B10/B11 | manifest 边界、滚动 store 卫生、常量与注释修正保留 | motion 防回魂测试只查依赖 manifest，不能声称它扫描全部源码 import |

本轮实做反证，而非只读测试名：B1 恢复 eager copy → 2 例失败；`<=` 改 `<` → 1 例失败；B3 去 hover guard → 2 例失败；B5 去引用短路 → 1 例失败（scanner 调用次数）；B6 去 fingerprint → 3 例失败。每次修改均在测试前完成、测试后恢复，失败原因是断言，不是 canary。其余项有现有回归覆盖，**未声称本轮逐项做过所有 mutation**。

铁律审计：未改 facet 写漏斗/派生 state、双时间戳、模态判据、plan/权限、transport catalog 或 thread-graph 所有权。没有新增 agentId 硬编码、inline import。BoardCard 主看板与 Focus 共用 `buildCardBusinessProps` 门控，改动同步传递到 pinboard/sticky；没有用自定义 memo comparator 忽略动作或业务 props。

## 3. 原有 3 条部署后验证：已执行，结果分开记录

真实实例为 `127.0.0.1:3484`；部署记录 commit `e3ffbbc44343bb3bcb0eb5ec46f13b3d1246eedf` 已包含 Batch 1。因此无需再部署旧批次，也未伪造本轮 deployment record。

| 原 verificationId | 执行与观察 | 判定 |
| --- | --- | --- |
| `8f967724-3b8f-4de7-ac1c-2d9550865c05` | 原资产目录 `run.js` 原样执行 20s：session=0、projects=0，退出 1；显式 workspace 订阅也只见 snapshot/metadata | **未通过：没有活跃推流前提，无法判定比例** |
| `817a4516-98fb-4ebe-9dfb-239d2e669422` | 真实 Chrome 注入 React DevTools commit 探针观察 30s：33 次 root commit，期间无 session 帧；生产函数名压缩 | **未证实：不能把 root commit 当 App render，也不能验约 6.7/s** |
| `21e8663d-47b5-45c3-a05f-762cd42a3c80` | 真实 Chrome/CDP trace；页面 42 卡、953 SVG path，扫 5 张可见卡 20 次（约 5s）；257 条正常 Layout/UpdateLayoutTree，0 条带同步 JS stack | **本次 hover 抽样通过：未发现强制同步布局** |

第一次 hover 探针的 boundingBox 自身会强制布局，已剔除该探针污染，改为 trace 开始前一次性收集坐标。未把正常布局事件算成 forced reflow。完整原始 trace 在 `/tmp/041d9-batch1-hover-trace.json`；仓内保存了精简结果及可复跑探针。没有勾选整批“完成”或注销这些旧定义。

旧 automated 的 `ratio < 0.34` 也不是 B6 当前实现的通用契约：持续输出会更新 lastOutputAt，从而使 project fingerprint 改变。要验证这条性能假设，需要区分无可见 project 变化的重复 tick 和真正变化的 tick；本轮没有篡改旧定义来获取绿灯。

## 4. A-P1-1：完整消费链 memo 化

- `KanbanBoard`、`BoardColumn`、`BoardCard`、`TaskCardBody` 使用 React 默认浅比较 memo。
- `use-board-interactions.ts`、`use-task-start-actions.ts`、`use-git-actions.ts` 沿用仓库的 latest ref 模式：事件入口读取最新 board/session，再保留一次调用内的快照。自动流转 effect 与异步业务步骤保持原义。
- 选择/编辑的 card 参数传到调用点，移除逐卡闭包；App 的编辑回调、主看板 `canLinkTasks` 与选择回调稳定。双宿主复用相同动作门控。
- StageHeaderRails 已用直接 handler，稳定上游并 memo 它真正渲染的 TaskCardBody 即覆盖第三消费链，不再加薄壳组件。
- 新 `board-card-render-isolation.test.tsx` 先红后绿，使用真实卡体与主看板/Focus 组合，强制 pinboard/sticky 副本，记录变动 prop。断言单条 summary 更新只重渲染相应卡体、所有 per-key 引用不变时零卡体渲染、真实 handler 变化仍使卡更新。hook 测试另证 handler 身份不随 board/session tick 改变且读取最新标题、列和路由能力。

这证明的是 session 更新造成的无关卡体渲染被隔离；没有声称消除卡片自己的时钟、hover、context 或 workspace metadata 更新，也未将组件测试计数冒充全量生产 App 的帧率。

## 5. A-P1-2：按需 CPU Worker 与真实引擎修复

- 主线程仅保留异步客户端；真正 Orama/USE engine 位于 module Worker，`new Worker(new URL(..., import.meta.url))` 由 Vite 打包。仅保留 CPU backend，跳过 WebGL spike，未改 xterm 策略。
- Worker 串行处理初始化/查询，按 requestId 回传；使用 documentIndex 回映主线程原始 document 引用，跨项目相同 taskId 不混淆。结果 Set 通过 structured clone 保留。
- 切文档/项目、离开语义模式、清空或关闭搜索、卸载时终止 Worker；错误、消息解码错误、postMessage 异常、120s 超时均拒绝 pending 请求并终止，后续查询可重建。模型初始化期间过期查询不再发送；在途旧查询结果不能覆盖新查询。既有 direct/fuzzy 降级继续保留。
- **浏览器暴露的原有引擎缺陷已修**：Orama 3.1.18 以 `constructor.name === "AsyncFunction"` 判断是否 await hook，embeddings 发布产物却将 async 编译成普通 Promise 函数。原接法会在向量未生成时查询，报 `Cannot read properties of undefined (reading 'property')`。接入处仅给 beforeInsert/beforeSearch 包原生 async 边界。
- 新 engine 测试保留真实 Orama 和 embeddings 插件，只替换远端模型，修复前稳定报上述错误、修复后 semantic/hybrid 均返回正确文档。vitest 配置将插件纳入转换并统一间接模型模块身份，防止 mock 漏掉嵌套依赖而意外联网。
- 真实 Chrome 运行最终生产 Worker：两份跨项目同 taskId 文档，semantic 命中部署文档、hybrid 命中蛋糕文档；9,647.7ms 内主线程 10ms timer 执行 964 次。之前一次远端模型 Failed to fetch、一次旧引擎报错都如实保留；成功结果没有绕过真实模型。这个小样本不代表大型看板索引延迟。

| 产物 | 基线 raw / gzip-9 | 本轮 raw / gzip-9 |
| --- | --- | --- |
| 主 JS chunk | 4,084,566 / 922,019 B | 2,717,442 / 702,386 B |
| 新 Worker | — | 1,491,312 / 212,831 B |
| xterm chunk | 666,307 / 152,325 B | 完全相同，SHA256 相同 |

主包 raw 减少 **33.47%**，gzip-9 减少 **23.82%**。主包 sourcemap 的 TensorFlow/Orama source 数由 700/89 变为 0/0，Worker 为 575/89；这是来源计数，不是字节归属。Worker 自身未压缩与 CPU backend 替换会影响总产物大小，不能把迁出主包等同于总下载量同比下降。模型仍依赖外网，首次加载失败可降级。

## 6. 实施阶段验证与一次测试契约漂移修正（RVF 前）

| 检查 | 最终结果 |
| --- | --- |
| 根 `npm run typecheck` | 通过 |
| `npm run web:typecheck` | 通过 |
| 根 guarded precommit-safe | 179 文件，2,320 例通过 |
| web guarded 全套 | 177 文件，1,724 例通过 |
| guarded runtime-state-stream integration | 13 例通过 |
| 变更文件 Biome、git diff whitespace | 通过 |
| `SENTRY_AUTH_TOKEN= npm run build` | 完整构建通过，未上传 sourcemap |

根与 web 使用不同 node_modules；为使 guarded wrapper 使用 web Vitest，采用仓外 shell 文件将 `web-ui/node_modules/.bin` 放在 PATH 首位，命令仍为：

```sh
npm --script-shell=/tmp/041d9-web-test-script-shell.sh run test:guarded -- --root web-ui --config "$PWD/web-ui/vitest.config.ts" --maxWorkers 2
npm run test:guarded -- --project precommit-safe
npm run test:guarded -- --project runtime-integration test/integration/runtime-state-stream.integration.test.ts
```

初次全套断言全绿，但同时启动的 Playwright 在仓内产生 `.playwright-cli/`，触发 mutation canary。已迁出这些资产，后续浏览器工作全部在 `/tmp/041d9-browser-session`，最终两套均无 canary 失败；不把初次运行计为完整通过。

补跑 runtime integration 首次 12/13：旧断言要求 Done 卡元数据缺席，和 main 的 `f51f9786`（保留 Done 投影用于 handback 快照）冲突。已按现行源码改为断言记录存在、`exists:false`、baseRef 正确、changedFiles:null，未更改运行时或删去检查；重跑 13/13。

当前 worktree 原 `dist`、`web-ui/dist` 均指向 main。完整构建前只移除本 worktree 的两个符号链接，改在本地目录生成产物；未写 main dist、未改 CLI link、未重启用户实例。测试使用隔离 git fixture，未直接运行裸 Vitest。

精简证据、SHA256 与日志尾部在 [`../perf/task-041d9/validation-evidence.json`](../perf/task-041d9/validation-evidence.json)。复跑真实 Worker 的 Playwright 代码与 hover 探针同目录；Worker 探针 URL/hash 为此次构建值，下一次构建需按实际文件名更新。

## 7. 本轮部署后验证注册

已调用 `cline-kanban-post-deploy-verification-authoring`，注册前 task 041d9 无定义；注册后 list 回读为 2 条。以下属于未来部署后的真实链路验证，不能用本轮孤立生产 Worker 或组件测试替代。

| 行为 | 部署前已证 | 部署后待验 | 类型 |
| --- | --- | --- | --- |
| 会话更新隔离、卡片动作 | 主看板/Focus/pinboard/sticky 渲染计数、handler 最新值和现有交互回归 | 实际 session 推流下多宿主渲染、层级、点击与拖拽 | guided_manual |
| 按需 CPU Worker | 构建拆包、真实模型查询、主线程 timer、取消/乱序/失败测试 | 真实运行实例资源路径/CSP、完整搜索 UI 生命周期、大看板负载和故障恢复 | guided_manual |

- `6db145cf-1b44-49a8-931c-090291a23730`：会话推流只更新变化卡片；主看板、Focus View、置顶板和 sticky 副本的动作及拖拽保持可用。
- `80d85664-5d49-483d-a137-09c396e4cce5`：真实部署的语义搜索按需创建 CPU Worker，搜索完成或失败后 UI 仍可交互，退出搜索能释放 Worker。
- 两条均为 `guided_manual`、`cleanup.mode=manual`，资产目录分别为 `~/.cline/kanban/verifications/<verificationId>/`；无仓库插桩。定义副本在证据目录。
- automated dry-run：本轮新增 automated 为 0，不适用；旧 automated 执行结果见第 3 节。
- 后续合法部署并 record 后，本组预计挂载 **0 automated + 2 guided**；本轮未部署、未 record、未勾选通过。引擎异步修复未改变注册断言，不需要新增重复定义。

兜底清理（只在验证完成或决定撤销定义时执行）：

```sh
kanban verification cleanup --verification-id 6db145cf-1b44-49a8-931c-090291a23730
kanban verification cleanup --verification-id 80d85664-5d49-483d-a137-09c396e4cce5
rg -n 'KANBAN-VERIFICATION-SCOPED:(6db145cf-1b44-49a8-931c-090291a23730|80d85664-5d49-483d-a137-09c396e4cce5)' src web-ui/src
```

当前无匹配插桩，浏览器验证不改用户任务数据。原 Batch 1 的 2 项未证实结论及本轮真实部署验证均保留待验状态。

## 8. RVF 后续复核与修复

run `rvf-20260922T144727Z-agentic-initiation-start-ac0d6774` 已完成双评审，两个 canonical 结果均合法，审查期间工作区快照未变。入口选择 strict，其 preset 回执声明目标3，但实际 dispatcher 为 `pseudo_random_two`，最终 `completed / effective_reviewers=2`；这里只声明两路完成。一路发现1条真实问题，另一路无问题。

**RVF-001：初始化过早就绪。** 原生 async hook 包装仍不足以修复 Orama 3.1.18 的批量插入：`insertMultiple` 的 async 判定遗漏文档级 beforeInsert，同步分支不等待单条 insert 返回的 Promise。原测试让文档与查询同为1ms，未覆盖查询先完成的顺序。隔离 validate/fix attempt 以 deferred Promise 复现：文档向量全部 pending 时初始化已完成。修复为逐条 `await insert`，保留其它索引和查询语义，不再并发启动全部嵌入任务；文档失败立即拒绝初始化且不再插入后续文档。

修复仅涉及 engine、engine.test、vendor 三文件，已经 `rvf_fix_attempt.py stop --status fixed` 与 `apply` 合回；无 scope expansion。真实 Orama/plugin 的3例测试现在覆盖文档完成屏障、查询等待、错误传播和停止后续文档；新增2例。最终全套结果以 run 的 `artifacts/validation-records.json` 和 `artifacts/handoff.md` 为准，第6节保留实施阶段的历史计数，不冒充修复后的缓存证据。

修复后重新构建：主包 2,717,442 B / gzip-9 702,391 B；Worker 1,487,554 B / gzip-9 212,165 B；xterm SHA256 仍相同；主包 TensorFlow/Orama source 计数仍0/0。第5节的表和9.65秒浏览器成功属于 RVF 前的原始记录。

**修复后真实模型复测未完成**：Chrome 两次请求分别约80.3s、98.8s后 `Failed to fetch`，主线程10ms timer分别推进8,026与9,884次。没有把远端模型网络失败标为搜索通过，也没有改模型来源以绕过现场条件；离线可控回归与本次构建通过，真实部署搜索仍由已注册清单验收。

按 `cline-kanban-post-deploy-verification-authoring` reconcile 模式，以原两个 verificationId 幂等重注册，清单读回仍为2条。语义搜索项新增“首次查询等待全部文档索引完成、文档失败进入既有降级”观察；未堆叠定义、未打勾、未部署。完整修复归因和最终验证由该 RVF handoff 承载。
