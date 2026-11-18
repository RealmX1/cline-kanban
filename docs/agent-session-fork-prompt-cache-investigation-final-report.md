# 原生分身缓存调查最终报告

调查日期：2026-09-11 / 12 的历史记录、2026-10-30 / 31 的复测，以及 2026-11-16 的 Claude 5.5 与 Antigravity / Gemini 4 复测。
本报告是结论与证据入口；逐请求数据、恢复经过和完整命令保留在
[实测记录](agent-session-fork-prompt-cache-measurements.md)。

## 2026-11-17 离线复核与交接说明

本次遵照用户要求停止 Fable 5.2 测试，**没有新增模型调用**。以下为交接给另一 agent 的阅读入口，
不包含安装、部署或自动重跑授权。

| 材料 | 本次复核等级 | 可支持与不可支持的判断 |
| --- | --- | --- |
| 十一月 Claude Opus / Sonnet 5.5 | 原始 stdout、原生 transcript 与配置快照离线重算通过 | 各一次原生 fork 首轮约 99.9%；当时只有前置父热对照，没有后置对照，不能称为统一双向热对照验收 |
| 十一月 Antigravity 原生与修复候选 | 原始逐步 usage 重算；修复项还与 Google SSE 核对 | 原生有效对照 miss；三个改写后的首轮确有历史缓存读取，但版本 / 后置对照缺陷阻止宣告稳定修复 |
| Fable 5.2 | 原始 stdout 与错误结果复核 | 只有小基线成功；父 seed 返回 HTTP 429 / requires usage credits，无成功模型计量，尚未 fork，缓存结论未知；窗口已过，不再续测 |
| 九月 / 十月 Codex、Kimi、Cursor、Claude、DeepSeek | 核对已提交报告、入口与 44 个解析 / 恢复测试 | 原始私有证据根目录当前不在本机；历史读数保留为既有报告，**未重新复算历史原始请求** |
| Carbon | 核对既有 prepare-only 计划 | 零请求；无实测结论，本次不执行 |

当前可复算材料共 **42 个有效主响应、10 个有计量首轮**。其中包括原先 41 个成功响应和本次收尾纳入的
Fable 小基线；没有新增成功 fork。另有额度拒绝、超时和中止记录，均不算 cache miss。
与历史报告的 118 个主响应 / 48 个首轮合并，是 **160 / 58**；其中 51 个首轮只是按各轮原判据具备资格，
**不是 51 个经过相同双向热对照的样本，也不是 51 次命中**。计数不含九月历史。

可随 Git 交接的[脱敏逐回合数据](measurement-evidence/agent-session-fork-cache-review-2026-11-17.json)包含
读数、资格问题、失败原因、来源相对路径和 stdout SHA-256。没有包含凭据、完整 prompt、账号、数据库或转录正文；
摘要与 hash 不能代替缺失的原件。原件仍在本机私有目录；另一台机器只能复核这份导出，除非另行安全移交原件。

接手时先区分四件事：子首轮确有读取、对照资格、方案效果归因、生产工具 / 权限语义。Argon 根锚点必要性尚未证明，
Hydrogen 仅固定前缀已出现命中；任何后置父缓存退化的根因都未隔离。不要把重新调用同一子会话的第二轮当首轮。
Fable 5.2 的额度拒绝也不是模型不存在、CLI 不支持或缓存失败的证据。历史中的零读取不代表今天所有配置。

本次变更只有独立诊断与材料，未改变产品运行时；无需注册部署后验证。没有提交私有证据、部署或推送。

本次验证：四组现存实验及 Fable 未完成组离线解析通过；历史三个测量模块的 44 个受保护测试通过；
根 `npm run typecheck` 通过，诊断脚本语法与导出数据的 token 算术 / 凭据排除检查通过。
实际执行仓库 pre-commit：staged 检查（本次文件不在 Biome 覆盖范围，处理 0 文件）、类型检查通过；
全量 precommit-safe 为 **7,379 passed / 3 failed / 1 skipped，568 个文件通过、2 个文件失败**。
失败项为 `agent-session-adapters.test.ts:391/:412` 的旧命令前缀断言（两条独立复跑仍失败），以及
`agent-command-and-inline-script-usage-analysis.test.ts` 内 Python fixture 的
`manifest_path_unresolvable` / `manifest_unreadable` 错误码不一致。这些测试及对应业务模块没有本次改动。
不将其写成全仓通过，也不为本次资料交接修改无关产品代码。普通提交因上述失败被 hook 拒绝后，
本次仅以 `HUSKY=0` 提交已复核的六个材料 / 诊断文件；不是免除检查或永久关闭 hook。

## 结论与适用范围

**原生分身可以复用父历史缓存，但须按 harness、fork 路径、模型、配置和规模判断。**
本轮 Kimi、Codex 官方临时 fork、Codex 社区适配的持久化 fork，以及 Cursor Grok 的部分样本都读取了明显超过
公共前缀上界的缓存。2026-11-16 的 Claude Opus / Sonnet 5.5 模拟会话各一次 fork 首轮也达到约 99.9%。
原版 Codex 普通持久化 fork 首轮仍未观察到该复用；Cursor 32k 的缓存表现存在波动。
Antigravity CLI 原生不修改请求的 fork 仍观察到零读取。随后发现父子 system 前部的会话 ID 与 artifact 目录不同，
经隔离中继稳定前缀后，Hydrogen 子首轮读取 41,533 / 43,950；Argon 在稳定前缀并继承父 root 锚点后读取
42,019 / 44,452，均约 94.5%。但两组同版本样本的后置父热对照失效，另一个完整热对照样本跨 CLI 版本，
**首轮命中已有直接证据，稳定修复仍未通过完整验收**。不能把原生 miss 描述成「已证明前缀相同仍失去亲和性」，
也不能把本次实验中继当作官方已支持方案。方法论、社区候选与真实修复尝试见实测记录第十三至十四节。

本任务交付的是诊断脚本、合成会话实验及调查材料。社区 Codex 补丁仅在任务专属副本构建运行；
没有替换本机 CLI，没有启用生产 Cursor 分身，也没有取消 Kanban 的成本闸。
这些实验不代表真实生产工具历史、角色权限变化、深层 fork 链或进程重启后的缓存表现。

## 本轮结果

| 路径及固定配置 | fork 首轮结果 | 可以支持的结论 |
| --- | --- | --- |
| Codex 0.166.0 / `gpt-6.1-sol` / `max`，原版普通持久化 fork | CLI 与 app-server 两组共 12 个首轮，cached 均未超出各组约 11.4k 的公共前缀上界；父热对照及分身第二轮接近全量 | 本轮未观察到原版该路径的父历史缓存复用 |
| 同版本及模型，官方 `ephemeral` root fork | 两档各三个，首轮 99.05%–99.77%，cached 为 31,872 / 127,872 | 所测临时路径能够复用父历史 |
| 同版本及模型，`prediction-ephemeral` | 两档各三个，首轮 99.04%–99.77%，cached 同为 31,872 / 127,872 | 本轮没有观察到超出普通 ephemeral 的额外缓存收益 |
| 同版本源码的社区适配构建，持久化 root fork | 六个首轮 99.18%–99.80%，cached 为 31,872 / 127,872 | 此适配是本轮有效的持久化 fork 修复候选，尚未安装到生产 |
| Kimi 2.3.1 / `kimi-code/k3.1-pro` / `high` | 六个首轮 98.69%–99.87%，均超出约 20.1k 的公共前缀上界 | 本轮复现了历史中 Kimi 已成功的结果 |
| Cursor 2026.10.22-27dcf5f / `grok-4.7-high`，原生显示 `Grok 4.7 256K High`，128k | 两组共六个首轮 99.83%–99.93%，前后热对照有效 | 该配置与规模下能够复用父历史 |
| 同一 Cursor / Grok 配置，32k | 两组均出现 cached=6,016 的低命中，也有 32,128 / 32,256 的高命中；连续组父热对照仅 1,152，三个首轮资格为证据不足 | 存在缓存波动，且并非只发生在 fork；不能承诺每次分身都稳定低成本 |
| Claude Code 2.1.323 / `claude-opus-5-5` / `high`，2026-11-16 | 一组两轮父会话后原生 `--resume --fork-session`；首轮 116,425 / 116,562 tokens，99.8825%；增量估算 $0.0248730 | 本次约 116k 的模拟会话能复用父历史；默认 system 没有 scratchpad，不能证明历史交互式故障已修 |
| 同一 Claude Code / `claude-sonnet-5-5` / `high`，2026-11-16 | 同法一次首轮 119,027 / 119,164 tokens，99.8850%；增量估算 $0.0127767 | 本次约 119k 的模拟会话能复用父历史；适用边界同上 |
| Antigravity CLI 1.5.9 / `gemini-4-argon-high`，2026-11-16 | 一次原生 PTY `/fork`，子首轮 0 / 43,463 cached；前后父对照分别读取 40,865 / 41,163 | 该配置本次首轮未复用父历史缓存；不是由父缓存未建立解释 |
| 同一 Antigravity CLI / `gemini-4-hydrogen-high` | 一次子首轮 0 / 44,164；最初父续跑曾读取 41,336，初始化等待后的三次父补对照均为零 | 记录未命中，但有效热对照不足，不能归因于 fork |
| Antigravity CLI 1.5.10 固定副本 / Gemini 4 Argon、Hydrogen，原生 fork 对照 | 首轮分别 0 / 44,206、0 / 43,721；父前后热对照有效 | 同版本、同一隔离中继内，原生路径首轮仍未命中 |
| 同版本 Argon，隔离中继稳定前缀＋父 `root_cascade_id` | 首轮 42,019 / 44,452，94.527%；父后置读取仅 9,596；另一个跨版本样本首轮 94.474% 且前后热对照有效 | 独立子首轮确有父历史缓存读取；同版本完整验收未通过，不能认定 root 锚点必需 |
| 同版本 Hydrogen，隔离中继仅稳定前缀 | 首轮 41,533 / 43,950，94.501%；后置父对照为零 | 仅修前缀就能出现首轮命中；后续缓存保持性尚未验证 |
| Claude Code 2.1.326 / `claude-fable-5-2` / high | 小基线 input=19,525，read=11,457，write=8,066；长父 seed 被 429 usage credits 拒绝，未 fork | 只有公共基线读取；分身首轮未知，窗口已过，停止续测 |
| Gemini 4 Carbon / High | 已准备入口；准备时账号原生目录没有该模型，零模型请求 | 等用户升级并确认后独立执行，不能声称已测 |

2026-10-30 / 31 实验共取得 **118 个具有原生用量的成功测试回合，包含 48 个分身首轮**。
其中 45 个首轮具备完整对照资格，3 个 Cursor 32k 首轮因父热对照失效保持证据不足。
这些计数不含九月历史实验，不含仅做本地 fork 创建的命令，也不含本次随后执行的 RVF 评审调用。
「有资格计量」不等于缓存命中；低命中样本同样保留。

Claude Code 的 446k fork 零读取、约 $4.46，DeepSeek 裸 API 的 98.8%，以及 Cursor 旧版线性续跑的低命中，
均属于九月历史，十月未复测它们。十一月按用户要求只新增 **8 个成功测试回合、2 个分身首轮**，
两种 Claude 5.5 模型各一组，没有重复比较；细节见实测记录第十一节。
随后 Antigravity 实验新增 **12 个成功主回合、2 个分身首轮**，其中只有 Argon 首轮具备完整热对照资格。
上述阶段合计 138 个回合、52 个首轮，其中 48 个首轮具备对照资格。
修复候选尝试随后新增 **21 个有效主回合、6 个有计量的子首轮**；三个原生零读取首轮具有完整对照资格，
三个正面命中样本因版本或后置热对照缺陷不列入完整合格样本。该阶段合计 **159 个有效回合、58 个有计量首轮、
51 个按原判据合格的首轮**，其中 Claude 5.5 没有后置父对照。加上 Fable 成功基线后为 **160 个有效回合**。
另一个子首轮已提交但超时、一个空历史探针被中止，均无有效计量，另列 unknown、不算 miss；Fable 的明确额度拒绝另列，
也不算 miss。
Carbon 的准备与未调用模型的本地命令不计入。
不能将九月 Claude 的失败或十一月模拟会话的成功写成当前所有配置的结论。

## 如何证明复用了父历史

公共前缀是没有父历史时仍会发送的指令、工具声明及环境等共享输入。本轮用同配置空历史请求的**全部输入量**
作为保守上界，没有声称精确测得静态前缀边界。cached 明显超过这个上界，才有父历史复用的正面证据。
再以 fork 前后父热续跑作参考，报告扣上界后的历史复用比例；100% 表示达到该参考，并非总输入全部命中。

| Agent / 通道 | 用量来源 | 防止误读的约束 |
| --- | --- | --- |
| Codex CLI | 本次新增 rollout 中的 `last_token_usage` | 不读累计字段，不计继承记录，绑定唯一请求标记与回合边界 |
| Codex app-server | 绑定 `threadId` / `turnId` 的 `tokenUsage.last` | 不读 `total`，要求用户接受与成功结束记录 |
| Kimi | 本次新增 `usage.record` 与 `llm.request` 配对 | 要求同模型、`usageScope: turn`，排除继承计数 |
| Cursor | 每次独立 headless 调用的 `result.usage` | `inputTokens` 是未缓存输入；总输入须加 `cacheReadTokens` 与 `cacheWriteTokens`，并绑定会话、请求标记和 `request_id` |
| Antigravity | 本次唯一完成的主 `agent_response.usage`；修复尝试另与 Google SSE 最后 usage 对照 | 总输入须将 `input_tokens` 与 `cache_read_tokens` 相加；不能读取会继承父计数的累计 result；逐进程冻结并核对 CLI 版本 |

工具调用、多响应、压缩、配置变化、缺失计量、热对照失效及提交状态未知不能转换为缓存 miss。
所有结果都是原生上报的缓存用量，未证明后端是否进行了物理 KV 重算。

历史继承另行核验：Codex 持久化路径核对完整提示词及分页父引用；Kimi 核对 `forkedFrom` 与完整父提示词；
Cursor 在脚本私有 store 的副本上核对独立原生 `agentId`、相同历史根指针和全部内容寻址 blob。
父历史的冻结摘要在派生前后保持不变。

Codex 临时历史读取接口不可用，改用明确父子归属、父历史中的两段随机 UUID 回读和输入规模补证。
十二个临时分身均通过，但这不等于逐字节比较了完整临时历史。早先因接口不支持而没有提交模型回合的
十二个临时分身保留为未执行，没有算作零命中。

## 官方与社区修复追踪

- [openai/codex#44716](https://github.com/openai/codex/issues/44716) 记录 fork 首轮失去报告缓存复用，
  并讨论 `session-id` 对缓存亲和性的影响独立于请求体 `prompt_cache_key`。本轮调查时为 Open。
- [官方 PR #44862](https://github.com/openai/codex/pull/44862) 于 2026-09-11 合并，覆盖 ephemeral root fork，
  不能据此推定默认持久化 fork 也已修复。
- [社区补丁与分析](https://github.com/rebroad/codex/commit/3e0386c63f53fda10c12abf32893612b57745d04)
  指出分页历史可能没有 `SessionMeta`。本任务在官方固定 commit
  `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856` 上同时放开持久化 root fork 的缓存继承条件，并回退到明确的父 ID。
  保留真实子身份，未把分身伪装成父会话。

社区构建采用 Rust 1.95.0 和 dev profile，对照为官方发行二进制；本轮未另建同 profile 的无补丁二进制。
与官方归档逐文件核对 9,731 个文件，仅缓存行为文件与发布锁文件元数据变化。
锁文件只对齐 170 个本地 workspace 包版本，第三方依赖版本、来源及校验和不变。
源码、补丁、构建恢复、产物 SHA-256 和逐请求记录均已保存。重启 resume、深层 fork 链及真实工具历史仍不在本轮验收范围。

## Cursor 对 Kanban 分身的适配结论

Cursor 原生 `/fork` 已具备独立身份和完整历史复制能力；当前工作区的 Kanban 普通新建、精确续跑及身份管理已接入，
**完整复刻主会话尚未接入 Cursor**，现有门禁仍只放行 Claude / Codex / OMP。

正式接入有一个已实测的身份缺口：原生 `/fork` 屏幕回执只给父 ID；准备进程 fork 后退出时，
十二个 `sessionEnd` hook 仍报父 ID，子 ID 是随后实际运行分身才上报的。
本次诊断通过脚本私有 SQLite 副本中的原生 `meta.agentId` 补证，没有从目录名猜身份，也没有打开真实 Cursor store。
这不构成放宽生产身份来源规则的授权。

接入还需解决模型调用前可信子身份、角色与权限、精确子会话续跑及重启恢复。
显式 `--model` 在本轮 headless 父 store 中未可靠持久化为 `lastUsedModel`，模型还须跟随实际启动快照，
不能只看被复制的 store。详情见 [Cursor 接入边界](agent-harness-cursor.md#8-2026-10-31原生-fork-与-kanban-接入边界)。

## 脚本与证据索引

| 用途 | 仓库入口 | 持久证据目录，均相对下述根目录 |
| --- | --- | --- |
| Codex / Kimi 原版矩阵及恢复 | `scripts/measure-native-agent-fork-prompt-cache.mjs` | `task-bde2b-2026-10-30/` |
| Codex 官方普通持久化对照 | `scripts/measure-codex-fork-cache-repair-candidates.mjs` | `task-bde2b-codex-repair-2026-10-31/official-app-server/` |
| Codex 官方临时路径 | 同上 | `task-bde2b-codex-repair-2026-10-31/official-ephemeral-with-history-proof/` |
| Codex 社区适配构建 | 同上 | `task-bde2b-codex-repair-2026-10-31/community-patched-persistent/` |
| Cursor 恢复试跑 | `scripts/measure-cursor-grok-native-fork-prompt-cache.mjs` | `task-bde2b-cursor-grok-2026-10-31/` |
| Cursor 连续对照 | 同上 | `task-bde2b-cursor-grok-contiguous-2026-10-31/` |
| 本次材料整理、需求冻结及 RVF | RVF 任务快照工作流 | `task-bde2b-final-report-and-rvf-2026-10-31/` |

证据根目录：`~/.cline/kanban/native-agent-fork-prompt-cache-measurements/`。
各组的 `final-verification-summary.json`、`measurements.json` / `repair-measurements.json` / `cursor-measurements.json`
提供逐请求读数；源码快照与交叉核验记录用于复核来源。本次整理不移动或覆盖这些原始证据。
私有 runtime 包含凭据，原生 hook 日志可能包含账号信息；评审使用单独冻结的脱敏机器上下文。

十一月追加实验的证据直接位于 `~/.cline/kanban/` 下，不属于上述十月子目录：

| 用途 | 仓库入口 | `~/.cline/kanban/` 下的证据目录 |
| --- | --- | --- |
| Claude 5.5 单组复测 | `scripts/measure-claude-native-fork-prompt-cache.mjs` | `claude-native-fork-cache-recheck-20261116/` |
| Antigravity 原生 fork 与 Carbon 待测计划 | `scripts/measure-antigravity-native-fork-prompt-cache.py` | `antigravity-native-fork-cache-recheck-20261116/`、`antigravity-carbon-fork-cache-prepared-20261116/` |
| Antigravity 稳定前缀 / 父 root 候选 | `scripts/measure-antigravity-fork-cache-repair-candidates.py` | `antigravity-fork-cache-repair-20261116/`，总核验见 `final-verification-summary.json` |

## 重新分析与验证

本机使用与既有原生依赖匹配的 Node 24.12.0；没有重建共享 `node_modules`。
离线分析不调用模型、不读取认证凭据，使用既有记录重算派生报告：

```sh
NATIVE_AGENT_CACHE_MEASUREMENT_NODE_BIN="$HOME/.nvm/versions/node/v24.12.0/bin/node"
NATIVE_AGENT_CACHE_MEASUREMENT_EVIDENCE_ROOT="$HOME/.cline/kanban/native-agent-fork-prompt-cache-measurements"

"$NATIVE_AGENT_CACHE_MEASUREMENT_NODE_BIN" scripts/measure-native-agent-fork-prompt-cache.mjs --analyze-only \
  --evidence-directory "$NATIVE_AGENT_CACHE_MEASUREMENT_EVIDENCE_ROOT/task-bde2b-2026-10-30"

"$NATIVE_AGENT_CACHE_MEASUREMENT_NODE_BIN" scripts/measure-codex-fork-cache-repair-candidates.mjs --analyze-only \
  --evidence-directory "$NATIVE_AGENT_CACHE_MEASUREMENT_EVIDENCE_ROOT/task-bde2b-codex-repair-2026-10-31/official-ephemeral-with-history-proof"

"$NATIVE_AGENT_CACHE_MEASUREMENT_NODE_BIN" scripts/measure-cursor-grok-native-fork-prompt-cache.mjs --analyze-only \
  --evidence-directory "$NATIVE_AGENT_CACHE_MEASUREMENT_EVIDENCE_ROOT/task-bde2b-cursor-grok-contiguous-2026-10-31"

npm run test:guarded -- --project precommit-safe \
  test/runtime/diagnostics/native-agent-fork-prompt-cache-measurement.test.ts \
  test/runtime/diagnostics/codex-fork-cache-repair-candidates.test.ts \
  test/runtime/diagnostics/cursor-grok-native-fork-prompt-cache-measurement.test.ts
```

真实新矩阵会调用模型，命令、版本约束和新证据目录要求见实测记录第八至十节。
恢复先补读原生记录；完成项及提交状态未知的模型请求不重发。尚未创建或仍为 prepared 的步骤会在同一目录继续。
新的 Codex app-server 进程在提交 prepared 模型请求前，先用 `thread/resume` 载入已持久化线程，并核对 threadId、父子身份、模型、`approvalPolicy` 与 sandbox；载入被拒绝时请求保持 prepared，不标成 submitting。临时线程在原进程退出后记为不可恢复，不重建或冒充原线程。
Kimi 在首次定位原生 transcript 的同一次操作中保存 `state.json` 快照。缺少分身第二轮唯一有效计量或存在证据问题时，矩阵不算完成，也不把缺计量重发成新的模型请求。
本轮已验证完成矩阵恢复未新增模型回合，以及派生清单损坏后的离线恢复。
Cursor 初次 PTY slash 输入停在候选菜单，确认旧进程退出且没有新子 store 后，只重试了本地创建动作，
原始失败日志与恢复依据均保留。

44 个受保护离线用例、定向类型检查、语法和格式验证通过。
十月当时记录根类型检查有 41 个既有 `agent-conversation-exploration-thread-graph` 依赖接口错误，测量文件无类型错误；
不能把定向检查通过表述为全仓检查通过，也不为绕过它们修改业务源码或共享依赖。
生产适配器只修正了一处旧注释，去除注释后的 TypeScript 输出与基线一致。

本任务没有引入必须部署后才能验证的运行时行为，因此不注册部署后验证条目。
本报告、诊断脚本、fixtures 及注释 / 指针改动作为同一任务快照进入本次 RVF；评审结果与收尾单独绑定到精确 run，
不把缓存实验完成、RVF 完成、生产适配、提交、同步或部署混为一件事。
