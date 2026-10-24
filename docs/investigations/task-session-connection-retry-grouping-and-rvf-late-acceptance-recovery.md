# 会话重连、任务分组与 RVF 迟到接受恢复

## 来源与批准范围

本记录属于任务 `b1b63`。用户先报告 `review-validate-fix/5de70` 停止后进入 Recent，随后补充
`my-ai-setup/7e615` 在继续工作时也进入 Recent。用户批准完整修复计划，并明确选择：

- 自动重连中的 Agent 回合保留在 Running，显示重连状态。
- RVF 正文迟到接受后，自动复用 `7e075` 的严格补证恢复原收尾资格。

## 事实与边界

- `5de70`：2026-10-24 纽约时间 06:04:32.121 的旧缓存参考早于 06:04:36.312 的新进程；
  不继承旧进程的热缓存估算符合现行规则。06:04:53.113 留下确认超时回执，06:06:52 中断过回合，
  06:07:00 开始新回合，06:08:53 压缩完成后才记录收尾正文。不能将整段间隔归因于首次提交持续压缩。
- `7e615`：同一进程内的 `ModuleNotFoundError` 被正则子串 `enotfound` 误匹配；恢复检查又位于
  可注入检查之后，导致真实工作继续时仍保留 `retrying`，被 Running 排除。
- 普通确认预算、缓存 TTL、跨进程缓存约束保持原有口径。补证记录实际接受，不覆盖原始失败，
  不重新投递正文，不推导 land/base 同步已经完成。
- 代码只修改本任务的 Cline Kanban 工作区。外部任务仅为证据来源；不修改它们的工作区或投递账本。

## 实现合同（PLAN-READY）

- 能力：避免网络文本误判和重试状态滞留；重连任务保持可见；真实迟到接受自动补证。
- 验收：错误码完整匹配、可信恢复事件清理、原生回合写前保护、分组一致、严格自动补证与幂等。
- 主要边界：output reactions、session manager、共享分组、切换面板、RVF 自动收尾服务。
- 风险：历史活动冒领恢复、异步写入目标变化、重复投递、补证锁重入、真实停止被覆盖。
- 验证：guarded 根测试、根与 Web typecheck、Web 测试、隔离 API/浏览器链路和独立输出构建。

## 垂直切片

1. 网络匹配与恢复：先复现 Python 子串误判及不可注入时清理受阻，再补可信活动和原生写前保护。
2. 分组与呈现：先复现 `retrying` 落入 Recent，再改共享谓词、稳定排序和跨视图重连说明。
3. 自动补证：先复现 eligible 暂停被扫描跳过，再复用严格内核，验证并发、停止、重启和历史保留。

同仓调查已识别 `46d51` 的活跃文件碰撞（会话管理与原生活动链）；不拷贝其未提交工作，集成时保留两组语义。

## 已实施的行为

### 重连识别与清理

- 为 errno 和裸 HTTP 状态码增加完整边界，阻止 `ModuleNotFoundError`、标识符与数字子串误命中；
  保留真实错误码跨多个 PTY chunk 的匹配。桥接缓存仅用于完成本次新字节延伸的匹配，不能因普通重绘重复刷新旧错误时间。
- 将恢复判断移到提示符和可注入检查之前。可信的新 `agent_output`、`tool_activity`、
  `context_compaction` 经活动投影接受后，清理 episode、定时器、跨 chunk 缓存与 summary。
  历史事件、其他原生会话、仅输入接受和被投影拒绝的未来时间不能冒领恢复。
- 续跑动作明确返回「已写入」「写前延期」「目标失效」；实际 PTY 写入后才增加次数，异步在途只保留一次，
  旧 episode 的迟到结果不能复活新状态。
- Codex 写入前只查询本代既有控制端点的 `thread/loaded/list` 与 `thread/turns/list`。
  `failed` 才可继续核验空输入框；`inProgress`、未知、分页异常或端点不可读均延期，
  `completed`、`interrupted` 或回合换代作废旧目标。paste、Enter 与补发前都重验身份；
  核验期间的人工输入、新程序化投递、进程换代和显式停止均使旧写入失效。
- 首个 Enter 核验拒绝时，只有本进程仍独占原输入框、没有人工输入或更新投递，才用 Ctrl+U 撤回已知单逻辑行的续跑 paste。
  内部回调分别记录等待首个 Enter、已写 Enter、提交前延期与目标失效；paste 计数仍只表示真实写入，绝不等同原生接受。
  核验挂起不会被当作恢复，撤回后仍可重探；已经写过首个 Enter 后不再自动撤回正文。

### 分组与呈现

- 共享 Running 谓词接纳持有 agent 回合的 `live`、`retrying` 和既有 park 状态。
  同一回合的 live/retrying 变化不创建新的排序时间。
- 首页列、Focus View 与手机堆叠列表复用「重连中」说明；恢复后说明消失，任务保留在 Running。
- 没有延长 cache warm TTL，也没有让新进程继承旧进程的缓存参考。`5de70` 的跨进程缓存退组仍按原规则解释。

### RVF 自动严格补证

- 后台扫描、外部状态查询、`completed` 结果报告均可触发 eligible 暂停记录的严格补证。
  复用 `7e075` 的精确正文、handoff、原生活动分支、身份、停止与锁校验，不重投正文。
- 同一证据指纹最多三次核验，间隔至少 15 秒；新转录证据或服务重建后重新核验。
  指纹只含收尾绑定、会话代际与转录元数据；liveness、接受态、控制端点和记录更新时间的无关抖动不重置预算。
  内部状态读取只返回快照，避免等待自身持有的 workspace 队列。
- 原 `delivery_failed / submit_confirmation_budget_exhausted` 账本保持原字节，补证另存凭据。
  补证成功只恢复收尾资格；land 仍要求真实 evidence，base 同步仍要求 land 成功及本地祖先证明。
- 新增持久结构化自动补证诊断通道，仅记录绑定标识、触发来源与结果，不记录正文。

## 实施阶段验证结果（RVF 前）

验证源起点为 `525088712f119d3d0d044b68f614b9a287fa478b`，使用 Node `v24.12.0`。

| 检查 | 实际结果 |
| --- | --- |
| 六个相关根测试文件 | 216 项通过；覆盖匹配、生命周期、分组、原生保护与 RVF 严格补证 |
| 最后追加的原生写入回归 | 两个文件 26 项通过，包含核验期间人工输入、抑制窗结束后也不写入旧正文；与上一行有重叠 |
| Web 全套测试 | 276 个文件、2,777 项通过 |
| 根 / Web typecheck | 均通过，最后的新增测试也通过根 typecheck |
| Biome 与 diff 空白检查 | 通过 |
| 隔离生产构建 | 通过；`dist`、`web-ui/dist` 均先解除本工作区软链接并隔离，显式设置 `KANBAN_BUILD_DISTRIBUTION_OUTPUT_DIRECTORY` |
| 打包态真实 Chromium | 通过，五项端到端断言，`pageErrors=[]`；覆盖真实 PTY 输出反应、服务端广播、首页、Focus View、390px 手机及 hook 恢复 |
| 全量 `npm run check` | 4,943 通过、28 失败、39 跳过；不能标记为全绿 |

全量失败拆分如下，未改动这些测试来隐藏失败：

- 26 项源码 runtime 启动失败：当前依赖的 `stream-json` 无法以 Node ESM named export 导入 `parser`。
  独立 Node 导入探针以及原 HEAD 基线中的 runtime stream 用例均复现。
- 1 项 CLI 兼容测试：同时继承 `NO_COLOR` 与 `FORCE_COLOR`，Node 警告破坏「stderr 为空」断言；原 HEAD 基线复现。
- 1 项原生问答正常恢复测试：15 秒超时；原 HEAD 的独立派生 worktree 中同一用例也超时。

源码态浏览器尝试同样被 `stream-json` 导入阻塞，因此浏览器改用本任务独立构建的 runtime 与静态 Web 产物。
真实网络故障和真实模型没有被主动触发；原生写入保护以协议边界测试验证，真实 RVF 自然样本留给 PDV。

## RVF 审查与修复

本轮绑定 `bd5ea143ce014307` / `rvf-review-start-bd5ea143ce014307`，正式审查覆盖 24/24。
规范终态为两条有效外部审查腿（`cursor-cli`、`kimi-code`），共提出三条 issue，全部采用，没有混用被替代工件。

- `RVF-001`：补齐首个 Enter 拒绝后的独占正文撤回、首次提交状态反馈及后续重探，保留人工输入、新投递、换代和停止保护。
- `RVF-002`：移除无关 summary 抖动对同一转录证据预算的重置，保留真实代际、新转录与服务重建后的恢复。
- `RVF-003`：分类器按新文本边界识别匹配，防止旧 carryover 污染可信恢复事件的时间关系，并保留多 chunk 识别。

三个 issue 分别在隔离 attempt 中先复现再验证修复，首轮三个补丁经 `rvf apply` 全部合回，无冲突或范围扩张。
`RVF-001` 另外通过新 attempt 核对真实模态与 park 入口，避免只看局部方法而漏掉既有的代际保护；
不把普通 `review` 扩大成模态决定，也不改写已完成 attempt。

RVF 后的最终验证采用 `rvf validate` 绑定最终候选，实际 argv、工作目录、结果和 cache 状态见：

`/Users/bominzhang/.rvf/user-local-data/run-logs/runs/rvf-review-start-bd5ea143ce014307/artifacts/handoff.md`

所有命令日志、基线对照、截图与 JSON 均保存在持久目录：

`/Users/bominzhang/.cline/kanban/cross-task-handoff-artifacts/b1b63/implementation-verification/`

主要证据：`targeted-root-tests.log`、`native-write-regression-tests.log`、`web-tests.log`、
`root-check.log`、`baseline-native-question-test.log`、`baseline-cli-runtime-tests.log`、
`build-output-isolation.json`、`isolated-build.log`、`isolated-runtime-rebuild.log`、
`packaged-browser/connection-retry-browser-results.json` 与同目录三张 `retrying-*.png`。

## 部署后验证分析与登记

已应用 `cline-kanban-post-deploy-verification-authoring`，本阶段只登记定义，不部署、不运行验证面板、不勾选通过。

| 行为 | 部署前已证 | 部署后待验 | 类型 |
| --- | --- | --- | --- |
| 文本边界、状态清理、写前延期与回合保护 | 相关根回归与类型检查 | 纯逻辑结论不随部署改变，不另造验证项 | 不登记 |
| Running 与重连说明、恢复广播 | 独立打包 runtime、真实 Chromium、PTY 替身及 hook 的完整链路 | 此链路已有自动化覆盖，不另加重复人工核对项 | 不登记 |
| 真实 Codex 的迟到接受自动补证 | 严格内核、自动三入口、并发、停止、重启与历史保留测试 | 真实实例自然发生的自动补证事件，须与服务端凭据及原失败账本对账 | `automated_script` |

登记回执：

- `verificationId`：`6b429a05-71bc-4d83-80cf-25945ff0e332`
- `kind`：`automated_script`
- `label`：真实 Codex 迟到接受后自动恢复收尾资格，原确认超时回执保持不变
- `assetsDir`：`/Users/bominzhang/.cline/kanban/verifications/6b429a05-71bc-4d83-80cf-25945ff0e332`
- `entrypoint`：`observe-real-rvf-late-acceptance.mjs`，仅依赖 Node 内置模块和只读运行状态，不依赖 task worktree
- `cleanup.mode`：`automatic`，无临时 repo 插桩；新增诊断通道属于长期运行诊断

旧实例 dry-run 为 exit 1，明确显示「待部署：本项尚未随本任务代码挂载到已部署组」。无崩溃、超时或残留实体。
部署后没有自然样本时也明确失败待观察，绝不将「未观察到」当通过。

`verification list` 自查摘要：`{"ok":true,"taskId":"b1b63","count":1,"kind":"automated_script"}`。
后续部署 record 并将本任务归属到部署组后，预计挂载 1 条 automated、0 条 guided。

兜底人工清理：

```sh
kanban verification cleanup --verification-id 6b429a05-71bc-4d83-80cf-25945ff0e332
```

## 交付边界

改动仍位于本任务 worktree，未提交、未合入本地 base、未 push、未部署；PDV 尚未通过。
没有修改 `5de70`、`7e615` 的工作区或真实投递账本，也未改写现有运行实例的状态来制造修复成功。
