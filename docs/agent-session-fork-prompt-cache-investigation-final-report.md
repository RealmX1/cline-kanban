# 原生分身缓存调查最终报告

调查日期：2026-09-11 / 12 的历史记录，以及 2026-10-30 / 31 的本任务复测。
本报告是结论与证据入口；逐请求数据、恢复经过和完整命令保留在
[实测记录](agent-session-fork-prompt-cache-measurements.md)。

## 结论与适用范围

**原生分身可以复用父历史缓存，但须按 harness、fork 路径、模型、配置和规模判断。**
本轮 Kimi、Codex 官方临时 fork、Codex 社区适配的持久化 fork，以及 Cursor Grok 的部分样本都读取了明显超过
公共前缀上界的缓存。原版 Codex 普通持久化 fork 首轮仍未观察到该复用；Cursor 32k 的缓存表现存在波动。

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

当前实验共取得 **118 个具有原生用量的成功测试回合，包含 48 个分身首轮**。
其中 45 个首轮具备完整对照资格，3 个 Cursor 32k 首轮因父热对照失效保持证据不足。
这些计数不含九月历史实验，不含仅做本地 fork 创建的命令，也不含本次随后执行的 RVF 评审调用。
「有资格计量」不等于缓存命中；低命中样本同样保留。

Claude Code 的 446k fork 零读取、约 $4.46，DeepSeek 裸 API 的 98.8%，以及 Cursor 旧版线性续跑的低命中，
均属于九月历史，本轮未复测它们。不能将这些旧结论写成当前所有配置的结论。

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
根类型检查仍有 41 个既有 `agent-conversation-exploration-thread-graph` 依赖接口错误，测量文件无类型错误；
不能把定向检查通过表述为全仓检查通过，也不为绕过它们修改业务源码或共享依赖。
生产适配器只修正了一处旧注释，去除注释后的 TypeScript 输出与基线一致。

本任务没有引入必须部署后才能验证的运行时行为，因此不注册部署后验证条目。
本报告、诊断脚本、fixtures 及注释 / 指针改动作为同一任务快照进入本次 RVF；评审结果与收尾单独绑定到精确 run，
不把缓存实验完成、RVF 完成、生产适配、提交、同步或部署混为一件事。
