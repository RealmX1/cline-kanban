# Codex 原生与 ACP 双路径原型比较报告

交付日期：2026-11-13（America/Los_Angeles）。任务：`82c6d`。源码基线：`b03bba8ae3c925d47e36056aa80af5905f494a0b`。本轮没有再次同步 main，没有提交、推送或部署。

本报告对应用户以 `start` 恢复授权的首轮隔离原型。现有 Codex CLI/TUI、原生控制宿主、fork/恢复及 OMP 接入保留；正式任务仍沿用原默认通道。实验入口不能作为已完成生产接入或已完成 RVF 迁移的证明。

## 结论与推进建议

**继续采用“共用会话能力与界面，后端保留原生接口、ACP 和 CLI 后备”的方向。** 本轮已验证两条结构化路径都能运行真正的 Codex、恢复历史并使用同一聊天面板。ACP 的主要价值是统一不同 Harness 的客户端接口；Codex 特有的精确 Rewind、运行实例归属和原生接受证据仍需要能力扩展。

建议下一阶段先把本轮共用合同接入正式任务的会话宿主、投递与 Queue 入口，以显式选择的 Codex App Server 为首个正式结构化后端；ACP 继续作为对照与跨 Harness 接口。生产默认值和 CLI 后备路径在完成对应验收前保持现状。这个建议依据能力边界与维护成本；每条路径仅三个模型输入，不能据此判定性能优劣或长期可靠性。

### Headless、协议与界面的关系

| 层次 | 本轮对应实体 | 能解决什么 |
| --- | --- | --- |
| Agent 执行循环 | 官方 Codex runtime | 模型、上下文、工具执行、沙箱及原生历史 |
| 原生控制接口 | Codex App Server | thread/turn 控制、双向事件、审批、原生历史及 fork |
| 通用客户端协议 | ACP + `codex-acp` | 用统一协议连接 Agent；通过 adapter 映射原生能力 |
| 宿主与业务状态 | 现有会话服务、投递 coordinator、本次隔离宿主 | 目标身份、代际、幂等、Stop、投递观察及恢复 |
| 可视化 | 复用 `AgentConversationChatPanel` | 结构化消息、工具内容、决策及分支观察 |

Headless 描述无交互终端的运行方式，ACP 描述客户端与 Agent 的通信合同；二者没有一一对应关系。一个 App Server 可同时服务结构化客户端与连接它的终端界面。ACP 也不要求所有 Harness 都有一个名字叫 App Server 的组件。官方将 App Server 定位为丰富客户端接口，ACP 的请求及更新则由 adapter 映射。[Codex App Server](https://learn.chatgpt.com/docs/app-server)、[Codex as a platform](https://developers.openai.com/blog/codex-as-a-platform)、[ACP v1](https://agentclientprotocol.com/protocol/v1/overview)。

结构化接口消除了粘贴、按键、终端重绘和输入框焦点对投递的依赖，也提供更明确的错误与归属证据；它不会自动消除连接断开、丢回执、重复请求、语义误解或 Prompt Injection。Agent 发来的内容仍须保留来源与授权边界；原生 `role=user` 和 `session/prompt` 均不能证明真人批准。跨 Task 寻址、排队和语义完成继续属于 Kanban 与外部业务合同，不能由一条 JSON-RPC 成功响应代替。

## 实际交付与实现边界

- 共用连接运行时与显式能力声明，复用现有 `AcpTaskSessionService`、facet、决策 broker、结构化消息和投递 coordinator。原生实现不伪造 ACP 握手或协议版本；当前内部投影复用既有 ACP 内容类型，尚非全面重写后的中立事件模型。
- 新增原生 App Server 后端及可注入的 ACP 启动定义。ACP 使用上游 adapter；本仓库桥接脚本只转发协议帧，并让精确核验连接 ACP 实际拥有的同一个 App Server，没有另写 Agent loop。
- 新增 `npm run codex:compare` 隔离入口及一个共用的双栏面板。只绑定 `127.0.0.1`，控制请求有实例访问标识和来源校验；生产任务 procedure 没有切换到该入口。
- 工具原始输入、输出、位置、协议元数据与完整 terminal delta 保存在结构字段，显示摘要不替代原始内容。该加性改动也影响现有共享聊天渲染器，须在实际部署后验证资源交付。
- 精确 Rewind 在原分支空闲时创建指定边界前的 fork，核验完整分页、回合顺序与正文 SHA-256；原会话保留，工作区文件不恢复。切换前确认旧根进程退出，切换后重新构建可见消息投影。
- 提交前保存 fork 意图及既有实例集合；响应未知时以同一所有者的 loaded threads、原生 fork 通知和历史正文补证，两次有界查询后仍未知就保留恢复条件，不重复 fork。已知候选未核验时不接收可能落到错误分支的新输入；受控重启会继续核验。

共用能力声明目前如实标明：运行中输入使用“中断后再发送”；精确 Rewind 依赖拥有原生 App Server；重启恢复只覆盖确认旧进程退出后的历史恢复；自由文本问答表单未接入。尚未提供完整的生产跨进程单写者协议或独立宿主热接管；请为每个实验目录只运行一个比较宿主。

实验 SSE 发送当前快照，长会话的内存与大输出吞吐尚未基准测试。正式接入应回到现有 runtime-state-hub 与任务控制面，不长期维护第二套比较宿主。现有会话指导会进入原生首轮 user 内容，历史回放仍显冗长，不能据本原型宣称最终可视化体验已完成。

### 固定版本与复现

| 项目 | 本次实际值 |
| --- | --- |
| Codex | `codex-cli 0.168.0`，`/opt/homebrew/Caskroom/codex/0.168.0/bin/codex` |
| ACP adapter | `@agentclientprotocol/codex-acp 2.6.0` |
| adapter 源码 | `f3208913693bd4d5171d6c6b9be5ec1ff96c6431`，npm integrity 随证据保存 |
| ACP SDK | 已安装的 `@agentclientprotocol/sdk 1.3.0`，未新增根项目依赖 |
| 模型 | 两条路径均为 `gpt-6.1-sol` |
| 环境 | macOS；Node `22.22.3`；同一个私有执行目录 |
| 实际权限 | `on-request` + `read-only`；未证明逐工具必询问的字面语义 |

安装版本、生成的原生协议类型及 adapter 包来源均已保存。上游 adapter 参考：[固定源码](https://github.com/agentclientprotocol/codex-acp/tree/f3208913693bd4d5171d6c6b9be5ec1ff96c6431)。Codex 0.168 的生成类型仍含 `untrusted`，实际配置已拒绝该值，因此不能只据类型承诺权限语义；本轮采用只读沙箱，并在 manifest 明示限制。[官方配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。

```bash
npm run codex:compare -- \
  --directory <持久的独立实验目录> \
  --codex-binary /opt/homebrew/Caskroom/codex/0.168.0/bin/codex \
  --acp-binary <codex-acp-2.6.0-可执行文件> \
  --model gpt-6.1-sol
```

入口输出带访问标识的本机地址。启动器清除继承的 `KANBAN_*`、`CLINE_*`、`CODEX_*`，显式设置私有 `HOME`、`CODEX_HOME`、`CODEX_SQLITE_HOME`。只复制登录与必要模型/provider 配置，不复制用户 hooks 或 plugins 配置；Codex 自身仍可能在私有目录生成缓存。证据目录按私有权限创建，原始转录和访问标识不应作为公共报告附件。

## 实测结果

真正模型输入共六次，每条路径三次：无工具中文精确回复、读取约 6 KB 的固定文件、首次 Rewind 及受控重启后再次读取该文件。两条路径采用相同 Codex、模型和请求场景，但 adapter、启动指导与事件表示仍有差异，未进行严格性能 A/B。

| 场景 | 证据与结果 | 判定边界 |
| --- | --- | --- |
| 即时消息与中文 | 两条路径各 3 次观察到接受和完成，实际模型输出保留预定标记；分块中文及非法 UTF-8 有协议回归 | 接受是匹配处理证据，不是 provider ack 或语义任务完成率 |
| 正文与来源 | 幂等键冻结逻辑正文；同键改文拒绝；实验来源标为不证明真人授权 | 原生首轮正文还包含现有 Kanban 启动指导；不能声称完整 wire payload 与输入框逐字相同 |
| 完整工具内容 | 两条真实路径均保留并显示 `PROTO_TOOL_CONTENT_END`；ACP terminal delta 与历史回放均验证 | 未覆盖所有 diff、图片和不同工具类型的真实模型交互 |
| 精确 Rewind | 两条路径均从 2 个回合恢复到 1 个，完整前缀正文 SHA-256 一致，原分支保留，固定工作区文件哈希不变 | ACP 路径使用同一 App Server 的原生扩展，不能称为标准 ACP 独立完成 |
| 分支界面 | 服务端消息列表与浏览器均确认保留首轮、移除被回退回合 | 修复前曾混入旧分支缓存，失败证据与回归保留 |
| 中断与代际 | 可控 Unix socket fixture 覆盖取消、过期连接、损坏返回、重复请求及退出 | 没有真实长时间 shell/子进程清理的全部场景证明 |
| 受控重启与 Stop | 真会话历史可恢复，不重发输入；fixture 验证持久 Stop；旧 PID 仍存活时拒绝并发恢复 | 不等于硬杀恢复、整机重启或独立 PTY host 保活 |
| fork 响应未知 | fixture 覆盖提交后失去回执、结果暂不可见及跨重启补证；真实迟到分支恢复后新增 fork 请求为 0 | 旧失败样本的缺失提交标记由原生原始证据补齐私有夹具，再验新版自动核验；不称旧版已自动恢复 |
| CLI 后备 | 连接同一个 App Server 的 `--remote` TUI 和旧实例退出后的独立 `resume <id>` 都显示相同分支历史；均未追加模型输入 | 未测试带未知待投递消息的自动 transport 切换 |
| 桌面/手机 | Playwright 验证桌面并排、手机有界面板、可滚动到第二条路径、无横向溢出、无 JS page error | 只验实验页及共享聊天，不冒充整个正式工作台已接入 |
| Queue、审批、模式及 RVF | 复用 coordinator、决策与模式接口；共享服务既有回归通过 | 实验页尚无 `after_agent_turn` 排队入口；真实审批/自由文本问答/模式组合和外部 RVF consumer 未验 |

### 接受与完成的计时

全部六次输入来自本次同一个 journal，按稳定 delivery event ID 去重。每后端分母均为 3；分位数使用 nearest-rank：排序后取 `ceil(n × p) - 1`。计时以记录到调用边界、接受证据及完成投影为准，不把创建到结算当成传输延迟。完成统计要求位于本次接受之后，避免将上一轮保留的完成原因误算成零耗时。

| 后端 | 意图→调用 p50 / 最大 | 调用→接受证据 p50 / 最大 | 调用→完成 p50 / 最大 |
| --- | --- | --- | --- |
| 原生 | 1 / 1 ms | 3159 / 6034 ms | 6485 / 7957 ms |
| ACP | 1 / 2 ms | 3149 / 3187 ms | 4296 / 6363 ms |

这里包含网络、模型与工具执行影响。排队耗时 unknown，独立传输耗时及 provider 接受时点 unknown，不能将该表解释为 ACP 更快。原始样本、全部分母和算法保存在 `comparison-protocol-metrics.json`，复算脚本为 `analyze-comparison-protocol-metrics.py`。

### 发现并修复的问题

1. ACP 2.6 的 stdout 位于 `_meta.terminal_output_delta.data`，旧投影遗漏该扩展，且展示摘要有 4 KB 截断。本轮保存并渲染完整结构内容；保留原失败快照及通过证据。
2. Rewind 底层正确时，旧会话服务账本仍混入被移除回合。现在重新绑定前弃置旧内存投影，通过原生历史重建；成功与丢回执路径均有回归。
3. 原生旁路默认 2 秒预算不适合完整 fork；一次 `thread/started` 在请求后 2239 ms 到达。实验连接改用 15 秒，同时前置保存副作用意图并补证，未用延长超时替代未知结果恢复。
4. `thread/list` 对未继续输入的新 fork 的可见性及 `forkedFromId` 与活体所有者的读取结果不同。补证优先使用同一所有者的 loaded threads、原生通知及其持久事实，再核验正文；不以索引列表缺失推断“没有创建”。
5. HTTP 分块曾可能切坏 UTF-8 中文；已使用有状态严格解码，非法字节在投递前拒绝。手机页也修复了共享根节点禁止滚动造成第二条路径不可达的问题。
6. 共享依赖最初为 Node 24 ABI，Node 22 的 SQLite 测试与首个投递失败；隔离基线同样复现。已将本任务依赖改为私有副本并仅在其中重编译 SQLite/PTY，主仓共享依赖未重编译。
7. 初次独立 CLI 探针遗漏 `CODEX_SQLITE_HOME`，在全局索引登记了两条只属于本实验的转录引用。该结果不采信；已只读审计、备份精确行、确认无关联后仅清理两条缓存索引。正确隔离复验通过；未删除转录，也不宣称全局数据库字节级还原。TUI 更新弹窗也曾遮挡历史，关闭启动更新检查后验证通过。[配置项出处](https://learn.chatgpt.com/docs/config-file/config-sample)。

收尾已确认本轮拥有的实验进程全部退出，移除两个私有 `auth.json` 副本，保留持久证据；源登录文件未被清理操作修改。全局线程索引中本实验引用为 0；首次探针对其他全局数据库或日志的附带变化仍为 unknown，没有扩大清理范围。见 `delivery-owned-experiment-cleanup-receipt.json`。

## Rewind 与当前 RVF 的迁移判断

当前基线已移除 Kanban 内的 RVF 专属编排。以前的自动 Rewind 业务顺序不能从旧实现或历史完成状态外推到现行系统；Kanban 当前保留通用原生控制、fork、前缀核验、任务会话与外部工作流引用。相关 Plugin 自己判断开审边界、Run、handoff、Stop 和后续执行资格。

本轮证明 **ACP 执行循环可以保留，同时通过其实际 App Server 完成精确 Rewind**。移植路径应由共用能力提供指定边界、原生身份、独立输入接受及 fork 证据，外部 RVF producer 消费这些事实；标准 ACP 能力不足时通过原生扩展或 CLI 后备。不能另起一个 App Server 读取同目录，就冒充正在执行的会话所有者。

当前外部 RVF consumer 是否接受此来源、自动 Rewind 后是否继续业务主流程均为 **unknown / 未验收**。本任务没有改 RVF 仓库、恢复已删除的协调器、调用真实 RVF 自动 Rewind 或伪装 `codex-tui` 身份。正式接入前应针对现行 consumer 交付精确 fixture、拒绝原因和接口差异，再确认对应仓库的实施归属。

## 验证、评审与部署状态

- 最终根项目 guarded tests：15 文件、151 项通过，含 Git 静态策略及 invoking-repository canary；没有绕过 guarded runner。
- Web 相关回归：3 文件、42 项通过；运行时类型检查与包含 Web 类型检查的隔离完整构建通过。最后一次实验页滚动布局修正另行核验 Web 类型与构建。
- 真实协议：6 次模型输入；额外历史、恢复、fork 和 CLI 观察未追加模型输入。接口与权限的未验部分见上表。
- 一次并行浏览器日志写入触发 canary，测试本体通过但该轮不计全门禁通过；移出浏览器产物后已单独重跑通过。Red、环境失败和后续修复日志全部保留。
- PDV 已登记 1 个自动脚本、0 个人工项：`a06dc435-ef90-4515-8ad5-edad56b6600c`，验证真实运行实例是否交付完整结构化工具渲染资源。显式源码实验入口没有部署依赖；共享渲染器的打包交付需要该项。脚本对旧运行实例 dry-run 清晰失败，无超时或残留；未执行部署后验证、未勾选、未写 `verifiedAt`。
- RVF 为**首次不发起**，精确 run 数为 0，不是已有覆盖后不重跑或父任务统一评审。本任务 `autoReviewEnabled=false`，交付范围以显式隔离原型为主，没有生产默认路径切换；本轮采用协议、回归、浏览器与隔离构建证据。共享 schema、回调和工具渲染仍有实际影响，正式生产接入前需要独立评审，不能将当前测试视为 RVF 覆盖。
- 历史累计任务独有提交：0，`+0/-0`；已吸收的 main 提交不计作本任务实现。当前 Dirty 的分类与幅度、背景 WIP 归属及精确清单见持久证据 `delivery-change-scope.json`。开工前仅有本任务计划文档 WIP；没有识别到无关代码 WIP，目录外并行工作的完整归属为 unknown。

当前 Dirty（HEAD → 完整工作树，含未跟踪）：29 文件 +2928/-11，二进制 0；实现/行为配置 20 文件 +1985/-11，测试/fixtures 7 文件 +595/-0，文档 2 文件 +348/-0，其他 0 文件。

## 后续正式接入的验收门槛

1. 接入真正的任务会话、实际 transport 路由与 Query/Event 契约；把 CLI 适配纳入同一能力面，继续保留现有 CLI 实现。补齐安装、版本能力探测及默认值回退。
2. 复用独立执行宿主的跨进程所有权、硬退出与重启恢复；补齐全量 Queue、丢回执、幂等预算、审批/问题与附件/diff 的真实场景。当前原型不承担多个比较宿主并发控制同一目录。
3. 将现有启动指导作为有来源的内容建模，区分逻辑用户正文与实际原生请求，改善历史回放时长指导占据聊天视图的问题；不隐藏证据差异。
4. 与现行 RVF consumer 核验原生接受和边界资格后再接自动 Rewind。随后以相同验收集扩展 Claude Code、Kimi、oh-my-pi；本轮没有新增这三家的适配或验收承诺。

## 持久证据索引

证据根目录：`/Users/bominzhang/.cline/kanban/cross-task-handoff-artifacts/cline-kanban/task-82c6d-codex-app-server-and-acp-comparison/`。以下路径均相对于该目录：

| 路径 | 用途 |
| --- | --- |
| `live-comparison-verified/comparison-version-manifest.json` | 实际 binary、版本、模型和权限 |
| `live-comparison-verified/comparison-protocol-events.jsonl` | 原生/ACP、消息、summary、fork 的原始观察 |
| `live-comparison-verified/final-full-tool-output-snapshot.json` | 真实长工具输出修复后的完整快照 |
| `final-strict-rewind/verification.json` | 首次双路径正文哈希与文件不变校验 |
| `native-fork-timeout-late-result-evidence.json`、`real-fork-timeout-recovery-seeding-receipt.json` | 真实超时的晚到原生证据与私有夹具补齐边界 |
| `final-strict-rewind-after-projection-fix/verification.json` | 恢复迟到分支、ACP Rewind 与旧消息清除 |
| `isolated-codex-cli-backup-corrected-verification.json`、`codex-remote-cli-history-verification.json` | 两种 CLI 后备观察，无模型提交 |
| `initial-cli-probe-owned-thread-index-cleanup-receipt.json` | 两条实验索引的精确备份与清理审计 |
| `comparison-protocol-metrics.json` | 全部计时样本、分母和算法 |
| `comparison-browser-layout-final-verification.json`、`structured-comparison-*.png` | 桌面、手机及第二面板可达性；旧失败截图有独立名称 |
| `delivery-final-guarded-regression-tests.log`、`final-green-web-regression-tests.log` | 回归测试结果 |
| `delivery-final-runtime-typecheck.log`、`delivery-final-isolated-build.log` | 类型与隔离构建结果 |
| `post-deploy-verification/` | 定义、dry-run、登记回执及资源清理入口 |
| `updates/kimi-research-artifact-ingestion-and-sanity-check-20261113T212909Z/` | Kimi 产物吸收、历史统计纠错与原始来源 |

Kimi 的历史统计和通信提案已按计划吸收；本轮没有重做 Swarm、把历史投递率当作当前成功率或新增一套 peer 消息总线。
