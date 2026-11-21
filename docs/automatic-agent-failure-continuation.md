# 容量不足与连接中断的自动恢复

容量不足和连接中断共用 `automatic-agent-failure-continuation-coordinator.ts` 的调度、单飞、取消与恢复记录。Codex 通过已有原生投递账本发送 `system_continuation`；Claude 的网络恢复沿用 PTY 的分离 paste / Enter 和真实接受核验。

## 策略与可见状态

| 原因 | 设置 | 退避 | 截止 |
| --- | --- | --- | --- |
| Codex 容量不足 | `codexModelCapacityErrorAutoContinuationEnabled`，默认 `true` | 30 秒、1 分钟、2 分钟、4 分钟、8 分钟，之后保持 8 分钟 | 从首次容量故障起 30 分钟 |
| 网络中断 | 原有 `autoContinueOnConnectionDropEnabled` | 4 秒、15 秒、1 分钟、4 分钟、8 分钟，之后保持 8 分钟 | 保留原有无固定截止策略 |

网络开关与容量开关独立。关闭立即取消对应恢复；重新开启只影响后续新故障，当前故障须通过明确的重试动作重新开启。自动提示被接受后立即再失败，沿用原 episode 与容量截止，不重新计时。关闭容量开关本身不会取消网络 episode；随后出现新容量故障时仍须交棒，不能借网络策略绕过关闭的容量设置。

等待退避、查询机器证据、正在投递、未知结果核对均进入“等待自动恢复”，位于 Running 后、Cache warm 前。该分组不是新 Stage。首页、Focus View、手机列表、项目计数及 CLI 复用同一分组函数。只有接受与原生执行均确证才回 Running。Claude 可按可信对话进展结束恢复链，Codex 继续核对当前原生回合终态。元数据更新、Enter、终端重绘及错误暂时消失不算恢复。

## 身份、投递与取消

- 每个 episode 绑定 workspace、任务 incarnation、对话、原生会话和进程代际；同一 episode 最多一个发送或核验操作。
- 容量检测保留本回合归属、历史重播隔离、引用排除及异步身份复验。活动回合、问题、计划评审和权限模态不能被“立即重试”绕过。
- Codex 复用原 thread，保留模型、推理档、Plan Mode 和权限。发生未知发送结果后，仅沿原消息标识与原发送日志补证，不切换 PTY，也不重新发一条提示。
- Claude 在可能写出首个 paste 字节前保存发送意图和转录基线。跨重启只读原 managed receipt 与该基线后的原生转录，不重新粘贴正文。
- 问题、计划评审、权限与补充输入模态只暂停发送，保留完整 facet、episode 与原截止；readiness 暂缺也只延期。确证尚未调用原生请求时才能撤回写前意图，崩溃后的未知意图继续只读核对。
- 用户点击 Stop、人工终端输入、新任务消息、会话替换、主会话交接、搁置和结案撤销旧资格。同一旧错误的重绘不能复活已取消的 episode。
- agent 自然 Stop 与 idle stall 的待交棒原因随 episode 持久保存，绑定实际发送边沿、当前投递及回合；登记投递期间的旧 Stop 不归属于新提示，迟到旧事件也不能覆盖当前交棒。当前提示的真实待交棒跨重启保留，恢复补证后补回 Review。Codex 必须核实原生 `completed`，工具活动可触发复核，恢复意图保留到原生终态或其他现有终止条件成立。
- 新 API `runtime.actOnAutomaticFailureContinuation` 接收 `{ taskId, episodeId, action: "retry_now" | "cancel" }`。过期 episode 返回 `ok: false`。旧 connection-retry API 委托相同协调器。
- “立即重试或核对”只跳过退避；未知结果仍推进原投递的核对。到期后停止新发送，既有 Codex 发送账本仍可只读补证，并幂等回填历史发送／接受计数；迟到接受不会恢复旧资格。明确重新开启才产生新的恢复预算。

## 持久化与机器恢复

`workspaces/<workspaceId>/automatic-agent-failure-continuation-episodes/<conversation-sha256>.json` 只保存身份、策略、截止、进度与投递引用；正文和接受事实仍在已有 managed delivery / native journal 中。记录按文件锁原子持久写入，取消接口等待写入完成再回执。

| 缺口 | 自动动作 |
| --- | --- |
| 原生回合分页明确不支持 | 复用 `thread/read` 完整历史读取；网络错误、损坏响应和中途分页失败不后备 |
| 控制端点缺失 | 从同一代持久启动描述恢复，核对 workspace / 对话 / incarnation 及目录 device / inode |
| 原生身份暂缺 | 读取当前独享宿主，恢复唯一且归属正确的身份，再核验 |
| 查询或持久写入暂时失败 | 5、15、30、60 秒有界间隔重验，发布最近检查、下次检查和原因 |
| 单条 episode 暂不可读 | 保留原文件，不阻断其它会话；独立退避重读，恢复后不覆盖已加载协调器 |
| runtime 重启且 PTY 仍存在 | 先走现有接管入口，再恢复 episode、截止和原投递引用 |
| 旧进程确证退出 | 用原持久启动快照及明确原生 ID 接回，再核验；不使用全局 `--last` |
| 所有者退出未知或仍存活 | 保持机器等待，不启动第二个会话 |
| runtime 正在关停 | 冻结调度并排空持久写入，不把关停误写为用户取消；下次启动先对账 |

Codex 的 `failed + systemError` 且无活动 flags 只证明失败已结束，不证明失败原因。重试必须有当前原生回合的容量／网络错误，或绑定于本投递及同一原生回合的可信检测证据；鉴权、配额与上下文错误停止恢复，原因未知时保留只读核对。原生控制连接隐藏错误正文时仍保留明确的分页能力拒绝分类，否则真实 legacy 会话无法进入后备读取。 运行时控制查询超时或缺少失败正文时，从已绑定的转录末尾读取最新回合的开始与结束记录。再次核对进程代际、原生回合及输入边界后，才登记恢复或结束失败回合。不可恢复、关闭恢复或旧 episode 已终结时显示会话错误。未能确认终态时保留待核验及下一检查时间，已有终态但原因仍缺失时有限等待补证。

## 验证入口

根测试必须经过 guarded runner。原生端到端测试用真实 Codex、真实 PTY、本地 HTTP 模型、真实 WebSocket 和两个 Chromium 视口（1280 / 390），隔离 `HOME`、`CODEX_HOME`、`CODEX_SQLITE_HOME`，不依赖外部模型。测试同时检查原生会话与设置保持一致、每次恢复只接受一条 self prompt、等待分组和实际执行的区别。

```bash
KANBAN_CODEX_NATIVE_SESSION_TEST_BINARY=/absolute/path/to/codex \
KANBAN_AUTOMATIC_FAILURE_CONTINUATION_BROWSER_CHECK=1 \
KANBAN_AUTOMATIC_FAILURE_CONTINUATION_EVIDENCE_DIRECTORY=/persistent/evidence-directory \
PLAYWRIGHT_BROWSERS_PATH=/absolute/path/to/installed-playwright-browsers \
npm run test:guarded -- --project runtime-integration \
  test/integration/codex-automatic-failure-continuation-real-native.integration.test.ts
```

浏览器缓存路径需显式指定，因为隔离 HOME 不应读取用户配置。构建前隔离 `dist` 与 `web-ui/dist`，并显式指定 `KANBAN_BUILD_DISTRIBUTION_OUTPUT_DIRECTORY`。共享原生依赖必须用匹配 ABI 的 Node；不要为验证重编主仓库共享依赖。

本地夹具可以证明容量失败后的产品闭环；真实容量服务恢复后的自然运行结果仍由部署后观察补证。自动换模型、扩大权限、鉴权／配额／上下文错误恢复不在本能力范围。
