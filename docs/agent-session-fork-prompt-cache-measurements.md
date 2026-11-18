# 从既有会话 fork 出分身：多家 harness 的 prompt cache 实测

本文件记录 2026-09-11 / 09-12 两天对「**从一个既有 agent 会话 fork 出一次性分身**」这件事做的跨 harness
缓存实测。它服务于 exploratory mode 的维护作业——那个作业每跑一次就 fork 一次，所以「fork 能不能复用父会话
的 prompt cache」直接决定这个功能是几分钱还是几美元一次。

**日期边界**：第一至七节保留 2026-09-11 / 09-12 的历史记录（提交 `c6880b232`）。2026-10-30 / 10-31
的脚本、配置、复测数据及复现命令见第八至十节；2026-11-16 的 Claude Opus / Sonnet 5.5 单组复测见第十一节。
历史能力扫描与结论不能自动当作当前状态。
2026-11-16 的 Antigravity CLI / Gemini 4 Hydrogen、Argon，以及仅准备的 Carbon 入口见第十二节。
方法论审计见第十三节；经隔离中继实测稳定前缀 / 父 root 锚点的结果见第十四节。

**最终结论入口**：[原生分身缓存调查最终报告](agent-session-fork-prompt-cache-investigation-final-report.md)。
本文件继续保留历史原文、逐请求样本与各轮复现经过，最终报告负责汇总当前结论和证据索引。

**2026-09-11 / 12 的历史结论**：fork 拿不到缓存**不是 prompt cache 机制的上限**，而是各家 fork 实现的缺陷。
同一件事 Kimi 做到了 99.3%，裸 DeepSeek API 做到了 98.8%，而 Claude Code 与 Codex 是 0%。

## 一、总表

| harness | fork 原语 | 遥测在哪 | **fork 首轮对父会话前缀的复用** |
| --- | --- | --- | --- |
| Claude Code | `--resume --fork-session`（CLI 一等公民） | `--output-format json` 的 `usage`，完整 | **0%** — 446k opus 实测，整段重写，单次 **$4.46** |
| Codex | `codex exec fork <id>`（CLI 一等公民） | rollout 的 `last_token_usage` | **0%** — 只拿到全机共享静态前缀 |
| Kimi Code | **有**，但在 REST / ACP / Web UI，不在 CLI flag | `wire.jsonl` 的 `usage.record` | **99.3%** |
| Cursor | **无**（全文关键词扫描 0 命中） | `usage.{input,output,cacheRead,cacheWrite}Tokens` | 不适用 |
| DeepSeek（裸 API） | 协议层无会话概念，fork = 重放前缀 | `prompt_cache_hit_tokens` / `miss` | **98.8%** |

## 二、机制：为什么 fork 本该几乎免费

prefix cache 不知道「会话」是什么。它只把请求的 token 序列从第 0 位起与缓存前缀比对，一路匹配到**第一个
不同的 token** 为止。按这个机制，fork 是缓存的**理想情形**：前缀与父会话逐字相同，只有末尾多一条新消息。

DeepSeek 的四次调用把这条钉死了（前缀约 15.7k token，四次逐字节同源）：

| 调用 | 前缀 | 后缀 | cache_hit | 命中率 |
| --- | --- | --- | --- | --- |
| 1 冷启动 | P | A | 0 | 0.00% |
| 2 逐字节完全重放 | P | A | 15,488 | 98.79% |
| 3 **fork 形态** | P | **B** | **15,488** | **98.80%** |
| 4 前缀开头改 1 字符 | P′ | A | 0 | 0.00% |

三个要点：

- 调用 3 与调用 2 的命中**绝对值一模一样**（都是 15,488），而后缀完全不同。⇒ 复用严格按前缀算，换尾巴零代价。
- `15,488 = 242 × 64`，正好卡在 DeepSeek 声明的 64-token 块边界。剩下约 188 个 miss 就是「块余数 + 新尾巴」，
  即**理论下限**。所以 98.8% 不是「还不错」，是这个机制能给的上限。
- 调用 4 是防伪：前缀开头动一个字符，15,488 全部作废。**我们在 Claude Code 与 Codex 上测到的 0%，形态上
  等价于调用 4**。

### 三家差异只有一个变量：发散点落在前缀的哪一段

上表里最容易被误读的一点：**调用 3 复用的不只是「公共前置」，而是父会话的全部对话历史。**
调用 3（换尾巴）与调用 2（逐字节全量重放）的命中**绝对值完全相同**——如果 fork 只能吃到 system prompt
与工具 schema，调用 3 必然远低于调用 2。两者相等，说明历史轮次整块都算进了那 15,488 里。

把五家放到同一根前缀上看，差别就只剩「第一个不同的 token 出现在哪」，它之后的一切一律作废：

```
 [ system prompt ][ 工具 schema ][ 父会话对话历史 · · · · · · ][ 新尾巴 ]
        ▲                 ▲                                       ▲
        │                 │                                       │
   Claude Code          Codex                        DeepSeek 调用 3 / Kimi fork
   发散点在这里        发散点在这里                        发散点在这里
        │                 │                                       │
      0%（连前置        只吃到 12928              98.8% / 99.3%（父会话历史全吃）
      都一起作废）      （公共前置），
                        对话历史复用 0
```

- **Claude Code 的 0% 不是「吃不到对话历史」，是连公共前置都作废了**：scratchpad 路径嵌了 session id，
  fork 换 id ⇒ system prompt 内部就差一行 ⇒ 发散点比公共前置还靠前。这正是读数为干脆的 0 而非
  「吃到一半」的原因。
- **Codex 的 12928 才是「只吃到前置」的标准形态**：三次长度与内容都不同的请求，命中绝对值分毫不差。
- **DeepSeek 调用 3 与 Kimi fork 把发散点推到了最后一条消息**，于是拿到机制上限。

Kimi 的 turn 1（65.7%）是同一规律的第四个样本：`toolsHash` 变化把发散点从「对话历史末尾」前移到
「工具 schema」，命中立刻掉一大截；稳定后才回到 99.3%。**变动越靠前，作废越多。**

## 三、逐家细节

### Claude Code —— 0%，且与会话类别强相关

- 生产量级实测（2026-09-12，2.1.269，opus-5[1m]，446k 上下文）：
  `cache_read_input_tokens = 0` / `cache_creation_input_tokens = 445,912` / `total_cost_usd = 4.46`。
- 同期对照：父会话自己的调用是 `cache_read 456,333 / creation 6,225`，**同一前缀在父会话那边是热的**。
  所以不是缓存过期，是 fork 路径没能复用。
- 成因是上游 open bug [anthropics/claude-code#77306](https://github.com/anthropics/claude-code/issues/77306)：
  system prompt 里嵌了含 session id 的 scratchpad 路径，fork 铸造新 session id ⇒ system prompt 差一行 ⇒
  而缓存断点就在 system prompt 末尾 ⇒ **整段下游前缀作废**。这解释了为什么读数是干脆的 0 而不是「读到
  发散点为止的一部分」。
- 官方 2026-08-17 已复现并承认是 2026-06 下旬 scratchpad 特性引入的 regression，表态「在研究让 scratchpad
  路径跨 fork 稳定」，此后无 ETA。截至 2.1.269（2026-09-11）CHANGELOG 无对应修复条目，issue 仍 open。
- 2.1.257 有一条「改进 /fork 以保住原对话 prompt cache」，但针对的是后台 fork 的 worktree briefing，
  **不是本根因**。

#### 为什么轻量会话测不出问题（这一条最容易骗人）

scratchpad 段由 statsig flag（`tengu_scratch`）门控，**并非每个会话都注入**。因此：

- 轻量会话（headless `-p`、无 scratchpad 段）：fork 满命中。2026-09-12 用 haiku 做的两次 25k 探针，
  一次即时 fork、一次隔 7 分钟 fork，`cache_read` 都等于父会话 `read + creation` 全额，**看起来像「bug 已修」**。
- 真实 Kanban 会话（交互式、有 scratchpad 段）：恒为 0。

**结论：在小会话上验证这件事会得出「已修复」的假结论。** 任何关于 fork 缓存的验证都必须在生产量级、
用真实交互式会话做。这是本轮调查里代价最高的一个教训（一次 $4.46 的复测才把它揪出来）。

#### 顺带坐实的一条设计

复测第一次尝试失败，报 `Prompt is too long`、零成本未发 API。原因：父会话 transcript 里 1226 条记录写的
model 全是 canonical 名 `claude-opus-5`，而真正在跑的启动形态是 `claude-opus-5[1m]`（1M 上下文变体）。
**从 transcript 反推不出真正的启动参数**——这正是 `agentSessionForkReplayLaunchArguments` 必须在启动那一刻
盖章、绝不事后重算的实证理由。

### Codex —— 0%，但副作用干净

时间线（同一批实验，UTC）：

| 时刻 | 会话 | input | cached | 命中率 |
| --- | --- | --- | --- | --- |
| 09:01:25 | 父会话 turn 1 | 26593 | 12928 | 48.6% |
| 09:02:52 | **fork #1** | 27879 | **0** | **0%** |
| 09:04:19 | **父会话 turn 2（对照）** | 27874 | 26368 | 94.6% |
| 09:05:42 | fork #2 | 29156 | 12928 | 44.3% |
| 09:07:23 | fork #3 | 29156 | 12928 | 44.3% |
| 09:08:48 | fork #3 的第 2 轮 | 30438 | 28928 | 95.0% |

- **那 44% 是分母造出来的假象。** 真正的常量是 **12928**——三次内容与总长都不同的请求，命中的绝对 token 数
  分毫不差。这是一段逐字节固定的共享前缀（system prompt + 工具 schema），发散点紧贴其后。父会话对话内容的
  复用是 **0**。
- **不是父会话冷掉**：对照组（父会话 turn 2）跑在 fork #1 **之后** 87 秒，仍拿到 94.6%。父会话那一刻显然是热的。
- fork 的**第 2 轮**回到 95%，说明冷 miss 是一次性的、只落在「新身份的第一次请求」——而一次性判定作业
  **只用得到第一轮**。
- 副作用干净：fork 新建独立 rollout，父 rollout 的 mtime / size / md5 三项在 fork 前后完全相同。
  **Pass A 交接文档里「`codex exec resume` 会不会写回同一 rollout」的顾虑可以销案——根本不该用 resume，
  Codex 有 `exec fork`。**

### Kimi Code —— 99.3%，唯一做对的

| 轮次 | 方式 | inputOther | cacheRead | cacheCreation | 命中率 |
| --- | --- | --- | --- | --- | --- |
| turn 0 | 全新会话 | 29880 | 0 | 0 | 0% |
| turn 1 | `-S <id>` 续跑 | 10018 | 19200 | 0 | 65.7% |
| turn 2 | **fork 后第一轮** | **199** | **29184** | 0 | **99.3%** |

- fork 原语**不在 CLI flag 层**：`POST /api/v1/sessions/{id}:fork`（REST）、`agent.session.fork`（ACP）、
  Web UI 右键。只看 `kimi --help` 会误判为「没有 fork」。
- fork 是真·深拷贝：新会话 `wire.jsonl` 完整复制父会话记录，`state.json` 带 `forkedFrom` 血缘，
  之后 `kimi -p -S <fork_id>` 可直接续跑。
- `inputCacheCreation` 恒为 0 ⇒ Moonshot 侧是隐式自动前缀缓存，**没有「为 fork 预热额外付一次写入费」**。
- turn 1 只有 65.7% 是因为 `toolsHash` 在两轮间变了（MCP 工具晚发现），把 tools 段之后的前缀打掉；
  稳定后即冲到 99.3%。这个细节本身也印证机制：**变动越靠前，作废越多**。

### Cursor —— 没有 fork

- 对主 help 加 11 个子命令做关键词扫描：`fork` / `derive` / `copy` / `checkpoint` / `rewind` / `duplicate` /
  `from-chat` / `parent` / `split` **全部 0 命中**。`create-chat` 是「建一个**空** chat」，不接受任何
  「从既有会话派生」的入参。会话相关只有 `--resume [chatId]` / `--continue` / `resume` / `ls`，全是线性续跑。
- 线性续跑的基线也不乐观：input 随会话增长（12.3k → 17.0k → 19.3k），但 `cacheReadTokens` 塌到约 2k 且不动，
  占比 72.6% → 10.5% → 11.9%。**命中量不随会话长度增长。**
- 保留：`cacheWriteTokens` 三次恒为 0，这套遥测并不完整，不能据此断言服务端绝对没缓存。

## 四、三家遥测都能把人读错（做实现时必看）

| harness | 陷阱 |
| --- | --- |
| Codex | `--json` 事件流里的 `turn.completed.usage` 是**该 thread 的累计值**，fork 会继承父会话计数器。直接读会得出「命中了」的错误结论。**必须读 rollout 里的 `last_token_usage`**。 |
| Kimi | `--output-format stream-json` 的输出只有 3 行，**零 token/cache 字段**。真数据在 `~/.kimi-code/sessions/.../agents/main/wire.jsonl` 的 `usage.record`。REST 面读历史会话全是 0。 |
| Cursor | `cacheWriteTokens` 恒为 0，缓存写入成本不可观测，只能靠读取单边推断。 |

九月测量时 Claude Code 与 DeepSeek 未遇到上述计量问题。当前 Claude Code 的累计费用与流式暂态 usage
另见第十一节，不能沿用「所有 result 字段都是本轮增量」的假设。

## 五、对本仓库的影响

1. **`AGENTS.md` 的成本铁律成立**，数字更新为 446k ≈ $4.46（与上下文规模成正比）。四道闸保留。
2. **节流闸维持默认 5 轮**。理由比原先更硬：不是「可能贵」，是实测贵。
3. **单飞闸与防抖闸与成本无关**，即便将来 fork 变便宜也不能拆——前者防同一 exploration 并发争跨进程写锁，
   后者防连续 Stop 把一次判定打成几次。
4. **Codex 不是逃生口**：它的 fork 首轮同样 0，而作业只用第一轮。
5. **真正的逃生口有两条**，都不是改个 flag 能拿到的：
   - 进程内 fork（Claude Code 的 `/subtask`，issue 里实测 574,953 读 / 345 写 ≈ 99.94%）——但它要求由**活体
     会话自己派出**，与现在「Stop 之后带外干活」的架构冲突。
   - 换宿主到 Kimi（99.3%）——需要核心包新写一个 harness 适配器（wire.jsonl 的 turn 投影 + REST fork 执行器），
     且 REST 面要求有活着的 `kimi web` 服务。这是一次真正的移植，不是配置改动。

## 六、怎么复现（便宜的那几个）

- **DeepSeek（约 1 美分）**：构造一段约 15k token 的固定前缀，依次发四个请求——冷启动 / 逐字节重放 /
  同前缀异后缀 / 前缀开头改一字符，比对 `prompt_cache_hit_tokens`。第 2 与第 4 个调用是防伪，缺一不可。
- **Claude Code 轻量探针（约 $0.06）**：haiku、headless、先 fork 后 resume（fork 不改父会话、resume 会）。
  **注意：这个探针恒为「满命中」，它验证不了生产问题**，只适合验证「对照方法本身成立」。
- **Claude Code 生产量级（约 $4.5）**：对一个真实交互式重型会话跑 `--resume --fork-session`。这是唯一能
  真正回答问题的测法。做之前先确认没有更便宜的替代——它每跑一次都是真金白银。

## 七、未决

- Claude Code 那条「轻量会话无 scratchpad 段」的解释是**推断**，未直接比对过两类会话的 system prompt
  （transcript 不存 system prompt）。现象一致，机制未直接证实。
- 未正面验证 fork 的 1h 缓存档位真能撑满一小时（只证伪了 issue #88444 说的「fork 用 5m 档」——实测所有写入
  都落在 `ephemeral_1h_input_tokens`，5m 档恒为 0）。
- Cursor 的 `cacheWriteTokens` 恒 0 是上报缺失还是真的不计费，未查证。

## 八、2026-10-30 / 10-31：可重复脚本与复测

### 配置与流程

独立入口为 `scripts/measure-native-agent-fork-prompt-cache.mjs`，复用已有 `smol-toml`、`proper-lockfile`
和 Node 标准库，不依赖 Kanban 运行时或打包产物。固定本轮配置：

| Agent | CLI | 模型 | 推理配置 |
| --- | --- | --- | --- |
| Codex | `0.166.0` | `gpt-6.1-sol` | `max` |
| Kimi | `2.3.1` | `kimi-code/k3.1-pro` | enabled / `high` |

每档先测一个空历史冷会话作为公共前缀基线，再创建约 32k / 128k 的合成父会话，执行父热续跑、从该状态
派生三个独立 fork 并测首轮、fork #1 的第二轮、父再次热续跑。规模按冷基线校准，以原生 usage 的实际输入量为准。
所有工作目录、`HOME`、`CODEX_HOME`、`CODEX_SQLITE_HOME`、`KIMI_CODE_HOME` 均隔离，只复制必要凭据，
不复制用户 hooks、MCP、plugins 或真实任务身份；测试仅使用脚本创建的会话。

Codex 使用 `codex exec fork <明确父 ID>`；Kimi 使用 `kimi fork <明确父 ID> --yes`，再以完整原生 ID
执行 `kimi --session <分身 ID> --prompt ...`。Kimi ID 从原生 `state.json` 读取，保留 `session_` 前缀，
不从目录名截取 UUID，也不使用最近会话选择。

### 计量与结论边界

Codex 只取本次唯一请求 marker 之后、该回合结束之前的 `last_token_usage`，去重重复通知，排除累计值与
继承记录。Kimi 将本次新增的 `usage.record` 与 `llm.request` 配对，只接受 `usageScope: "turn"`；
总输入为 `inputOther + inputCacheRead + inputCacheCreation`，同时核对模型、推理与工具摘要。

冷基线本身也可能 miss，不能直接把其 cached 值当成公共前缀长度。因此使用保守上界：

```text
公共前缀上界 = max(空历史冷基线 input, 父首次请求 cached)
父热历史参考 = min(前热对照 cached, 后热对照 cached) - 公共前缀上界
保守历史复用比例 = clamp((fork cached - 公共前缀上界) / 父热历史参考, 0, 1)
```

这个比例是扣除上界后的保守比较值，不能证明服务端绝对没有复用任何历史 token。前后热对照扣除上界后的
命中率均须至少 80%；缺遥测、配置变化、压缩、无法唯一归属请求或父子身份不明时，结论为证据不足。
逐个报告三个 fork，不以平均值掩盖首轮失败。未执行、调用前拒绝、额度耗尽与缓存未命中分别记录。

### Codex 实测

| 目标规模 | fork | 实际 input | cached | 总命中率 | 保守历史复用比例 |
| --- | --- | ---: | ---: | ---: | ---: |
| 32k | #1 首轮 | 32,142 | 5,504 | 17.12% | 0% |
| 32k | #2 首轮 | 32,142 | 4,480 | 13.94% | 0% |
| 32k | #3 首轮 | 32,144 | 0 | 0% | 0% |
| 128k | #1 首轮 | 128,145 | 9,600 | 7.49% | 0% |
| 128k | #2 首轮 | 128,144 | 0 | 0% | 0% |
| 128k | #3 首轮 | 128,146 | 9,600 | 7.49% | 0% |

| 对照 | 32k：input / cached | 128k：input / cached |
| --- | ---: | ---: |
| 空历史冷基线 | 11,381 / 0 | 11,380 / 0 |
| 父首次请求 | 32,021 / 0 | 128,025 / 0 |
| 父热续跑，fork 前 | 32,080 / 31,872 | 128,085 / 127,872 |
| fork #1 第二轮 | 32,201 / 32,000 | 128,210 / 128,000 |
| 父热续跑，fork 后 | 32,146 / 31,872 | 128,144 / 127,872 |

**本轮 Codex 的普通持久化 fork 未观察到超过公共前缀上界的父历史复用**。六个 fork 首轮的 cached 都低于空历史输入量，
而父热对照与分身第二轮均接近全量命中。现象与九月「首轮失效、后续热起来」一致，但不能据此推定当前内部根因。

新版 Codex fork 不再把全部父记录逐行复制到子 rollout，而以 `history_base` 引用父历史。六个子记录均核对
`forked_from_id`、父 ID、字节边界、ordinal 边界及冻结父快照的 SHA-256；两个父边界分别为 341,949 / 1,446,721
bytes，`end_ordinal_exclusive` 均为 28。基础指令摘要一致，六次 fork 前后父 transcript 的内容摘要与长度不变。

### Kimi 实测

| 目标规模 | fork | 实际 input | cached | 总命中率 | 保守历史复用比例 |
| --- | --- | ---: | ---: | ---: | ---: |
| 32k | #1 首轮 | 32,424 | 32,000 | 98.69% | 100% |
| 32k | #2 首轮 | 32,424 | 32,256 | 99.48% | 100% |
| 32k | #3 首轮 | 32,429 | 32,256 | 99.47% | 100% |
| 128k | #1 首轮 | 128,423 | 128,000 | 99.67% | 100% |
| 128k | #2 首轮 | 128,423 | 128,256 | 99.87% | 100% |
| 128k | #3 首轮 | 128,425 | 128,256 | 99.87% | 100% |

| 对照 | 32k：input / cached | 128k：input / cached |
| --- | ---: | ---: |
| 空历史冷基线 | 20,134 / 19,200 | 20,138 / 19,712 |
| 父首次请求 | 32,018 / 19,712 | 128,015 / 19,712 |
| 父热续跑，fork 前 | 32,223 / 32,000 | 128,227 / 128,000 |
| fork #1 第二轮 | 32,627 / 32,256 | 128,622 / 128,256 |
| 父热续跑，fork 后 | 32,425 / 32,256 | 128,424 / 128,256 |

**Kimi 本轮六个 fork 首轮均复用了父历史缓存**。表内 100% 表示达到前后热对照中较低的历史缓存参考，
并非总输入百分之百命中；总命中率仍应读取相邻一列。六个 fork 均有独立原生 ID，`state.json.forkedFrom`
绑定同一档的明确父 ID，并继承完整父提示词；fork 前后父 wire 的内容摘要与长度不变。

所有请求的模型、推理、`toolsHash` 与 `systemPromptHash` 均一致，`inputCacheCreation` 均为 0。
公共前缀上界分别为 20,134 / 20,138 tokens，六个 fork 的 cached 明显超出该上界，区别于 Codex 的静态前缀读数。
这复现了九月 Kimi 已成功的结果，并未推定 Claude Code 或其他 harness 当前也具有相同行为。

### 证据、恢复与调用

本轮证据目录：

```text
~/.cline/kanban/native-agent-fork-prompt-cache-measurements/task-bde2b-2026-10-30/
```

其中 `manifest.json` 保存步骤、父子身份、配置及 CLI 摘要与每次尝试；`request-artifacts/` 保存 prompt、原生转录、
stdout / stderr；`measurements.json` 保存逐请求读数与判定；`report.zh-CN.md` 为自动生成的中文报告。
`private-agent-runtime/` 含凭据副本，仅供本机恢复，不应分享。完整数据与来源路径以这组原始工件为准。

每次发送前原子写入清单。恢复先补读绑定请求的原生记录，已完成项不重发；提交状态未知时只暂停该项，继续其他
独立测试。只有明确未 spawn 或有原生记录和精确 CLI 拒绝信息证明尚未提交的请求，才允许至多两次尝试。
已保留首次登录缺失及会话 ID 解析修正的调用前拒绝记录，随后在同一目录恢复；已完成的 Codex 请求没有重发。

```sh
# 新运行：默认测试 Codex、Kimi，两档规模，各三个 fork。
node scripts/measure-native-agent-fork-prompt-cache.mjs

# 自选矩阵；新矩阵使用新目录。
node scripts/measure-native-agent-fork-prompt-cache.mjs \
  --agents codex,kimi --context-tokens 32000,128000 --fork-count 3 \
  --evidence-directory "$HOME/.cline/kanban/native-agent-fork-prompt-cache-measurements/new-run"

# 恢复本轮：沿用原矩阵，完成项不重发。
node scripts/measure-native-agent-fork-prompt-cache.mjs \
  --evidence-directory "$HOME/.cline/kanban/native-agent-fork-prompt-cache-measurements/task-bde2b-2026-10-30"

# 离线重算：不启动 CLI，不调用模型，不读取凭据。
node scripts/measure-native-agent-fork-prompt-cache.mjs --analyze-only \
  --evidence-directory "$HOME/.cline/kanban/native-agent-fork-prompt-cache-measurements/task-bde2b-2026-10-30"

# 离线 fixtures，包含累计计数、继承记录、缺字段、公共前缀假命中与恢复。
npm run test:guarded -- --project precommit-safe \
  test/runtime/diagnostics/native-agent-fork-prompt-cache-measurement.test.ts
```

执行退出码 `0` 表示完整矩阵获得可用计量，`2` 表示有未执行或证据不足，`1` 表示入口错误，`130` 表示中断。
离线分析成功生成报告时返回 `0`，具体结果读取 `measurements.json`。

本轮 Cursor 只核对能力：安装版本 `2026.10.22-27dcf5f` 的 `8008.index.js` 包含 `Fork Chat`，
[官方 slash commands 文档](https://prod.cursor.com/docs/cli/reference/slash-commands) 也列出 `/fork`。
因此九月「没有 fork」只保留为历史扫描结果，当前 fork 缓存表现仍未知。Codex 的无交互 fork 语法亦已核对
[官方 CLI 参考](https://learn.chatgpt.com/docs/cli/reference)。Cursor、Claude Code、DeepSeek 本轮均未发模型请求。

这些结果只适用于本轮配置与合成 headless 会话，不直接外推真实重型交互式会话，也不改变生产成本闸。

### 验证范围

离线 fixtures 覆盖累计计数与继承污染、回合边界、缺失或非法字段、请求配对、压缩、公共前缀假命中、
热对照失效、配置变化、Codex 分页父历史、Kimi 原生身份与 `forkedFrom`、调用前拒绝的有界恢复及隔离环境。
真实矩阵包含 32 次获得原生逐请求 usage 的模型请求和 6 次不调用模型的 Kimi fork 创建。
恢复检查核对完成项的会话 ID 与尝试次数保持不变；离线重算不调用模型。

新增文件的定向 TypeScript 检查、Node 语法检查与受保护测试通过。根 `npm run typecheck` 的结果另行保存在
证据目录的验证日志中：现有 `agent-conversation-exploration-thread-graph` 安装产物缺少仓库引用的接口，
因此全量类型检查未通过；没有为绕过这些现有错误修改业务源码或共享依赖。
本次没有修改运行时 / Web UI / desktop 代码，也没有构建或覆盖共享 `dist`、提交、同步、推送、部署。

## 九、2026-10-31：官方临时 fork 与社区修复的隔离复测

### 追踪来源与实验边界

用户授权利用官方与开发者社区的相关修复重新测试。官方
[issue #44716](https://github.com/openai/codex/issues/44716) 记录 fork 首轮失去报告缓存复用，
并指出 `session-id` 的路由作用独立于请求体的 `prompt_cache_key`；本轮查询时仍为 OPEN。
官方 [PR #44862](https://github.com/openai/codex/pull/44862) 已于 2026-09-11 合并，
只让 ephemeral root fork 继承父缓存亲和性，没有覆盖所有持久化 fork。

社区 [2026-10-10 的分析与复测](https://github.com/openai/codex/issues/44716#issuecomment-6102504450)
指出分页历史可能没有 `SessionMeta`，并给出
[父线程 ID 回退补丁](https://github.com/rebroad/codex/commit/3e0386c63f53fda10c12abf32893612b57745d04)。
该 commit 的前序实现已放开持久化 root fork，因此移植到官方 tag 时须同时处理许可条件与分页回退，
不能把单独增加回退的那一行当成完整修复。
[issue #21796 的官方预测 fork 用法实测](https://github.com/openai/codex/issues/21796#issuecomment-6135966700)
提供另一条可复现路径：`thread/fork` 加 `ephemeral: true` 和 `experimentalPredictionMode: true`。

新增入口 `scripts/measure-codex-fork-cache-repair-candidates.mjs`，使用
[官方 app-server 协议](https://learn.chatgpt.com/docs/app-server)，在独立进程中比较普通持久化、临时、预测临时三种 fork。
三种模式均有独立 child ID，且原生 `forkedFromId` 必须指向脚本创建的明确父 ID。
`excludeTurns: true` 仅减少 fork 响应中的历史返回数据，不是清除继承上下文。
固定模型 `gpt-6.1-sol`、推理 `max`，两档目标规模 32k / 128k，各三个独立 fork；每档均有空历史基线、
fork 前后父热续跑和一个分身的第二轮对照。`historyMode` 固定 `paginated`。

本轮计量取与本次 `threadId` / `turnId` 绑定的原生 `thread/tokenUsage/updated.tokenUsage.last`，
不读取 `total`；同时要求原生用户接受记录与成功结束记录。一回合出现多个不可拆分用量、压缩、配置变化或
热对照失效时保留证据不足。以下数字都是服务端**报告的 cached tokens**，不能据此证明后端是否发生了物理 KV 重算。

### 官方 0.166.0 的结果

使用本机既有二进制，SHA-256 为 `39acf979729dd290f9a24ee38b2914e036c91b65952872e28ae2a6b88a7db7c1`。

| 目标规模 | 模式 | 三个独立 fork 首轮 cached，按顺序 | 首轮总命中率 | 扣公共前缀上界后的历史复用参考 |
| --- | --- | --- | --- | --- |
| 32k | 普通持久化 | 0 / 0 / 9,600 | 0% / 0% / 29.88% | 0% / 0% / 0% |
| 128k | 普通持久化 | 0 / 0 / 9,600 | 0% / 0% / 7.49% | 0% / 0% / 0% |
| 32k | ephemeral | 31,872 / 31,872 / 31,872 | 99.05% / 99.05% / 99.05% | 100% / 100% / 100% |
| 128k | ephemeral | 127,872 / 127,872 / 127,872 | 99.76% / 99.77% / 99.76% | 100% / 100% / 100% |
| 32k | prediction-ephemeral | 31,872 / 31,872 / 31,872 | 99.06% / 99.04% / 99.05% | 100% / 100% / 100% |
| 128k | prediction-ephemeral | 127,872 / 127,872 / 127,872 | 99.76% / 99.76% / 99.77% | 100% / 100% / 100% |

这里的「公共前缀」指没有父会话内容时仍会发送的指令、工具声明及环境等共享输入。
用同配置的空历史请求**全部 input tokens** 作保守上界，而非宣称精确测得某个静态前缀的长度。
普通持久化组两档上界为 11,388 / 11,384，临时组为 11,399 / 11,401 tokens；前者的首轮读数均未越过上界，
后者的 12 个样本则都远超上界。父热对照前后分别读取 31,872 / 127,872，普通持久化 fork 的第二轮读取
32,000 / 128,000。临时组第二轮读取 32,256 / 128,128，热对照全部有效。
表中历史复用参考 100% 是达到父热对照扣除该上界后的参考量，不是总输入百分之百命中。

因此，「Codex fork 首轮不能复用父历史」必须限定路径：**官方临时 root fork 在本轮两档的 12 个样本中已经成功，
普通持久化 fork 的六个样本仍失败**。预测模式在本轮没有表现出超过普通 ephemeral 的额外缓存收益；
这不意味着二者在生命周期和其他行为上完全等价。

### 历史继承的替代核验

普通持久化组逐字核对原生 `thread/items/list` 中的完整父提示词。0.166.0 的临时 fork 尚不支持该历史读取接口，
`thread/read(includeTurns)` 与 `thread/turns/list` 也不能读取临时历史；对应限制已在固定版本源码中核实。
首次尝试因此在提交临时 fork 的模型回合前停止，保留为「未执行」，没有把它们计为缓存 miss。

随后用新的独立实验目录自动补证：要求子回合回读父历史中前两条带随机 UUID 标记的用户消息，当前问题不含答案；
答案须完全匹配，实际输入量还须保留父热输入的规模。两档 12 个分身全部通过，同时有独立 child ID、明确父归属，
每次 fork 前后父 transcript 的 SHA-256 不变。这能证明模型读取了父内容的两个位置及大致输入规模，
**不等同于对临时 fork 完整历史作逐字节比较**。

临时 fork 的用法需要存活的 app-server，也不提供普通持久化会话在重启后的续跑能力。
本轮没有把生产 fork 路径改为 ephemeral，也没有修改维护作业的成本闸或替换已安装的 Codex。

### 证据与复现入口

本轮持久证据根目录：

```text
~/.cline/kanban/native-agent-fork-prompt-cache-measurements/task-bde2b-codex-repair-2026-10-31/
```

`official-app-server/` 保存普通持久化对照与历史接口不支持的调用前记录；
`official-ephemeral-with-history-proof/` 保存临时 fork 的完整真实矩阵。
每个目录包含运行清单 `repair-run-manifest.json`、逐请求 `repair-measurements.json`、
原生收发协议 `native-app-server-protocol.jsonl`、冻结父转录和中文报告。
私有 runtime 含凭据副本，不能作为公开 issue 附件。

```sh
# 官方普通持久化 fork；必须传明确二进制与新的持久目录。
node scripts/measure-codex-fork-cache-repair-candidates.mjs \
  --codex-binary /absolute/path/to/codex --binary-label official-0.166.0 \
  --fork-modes persistent --evidence-directory "$HOME/.cline/kanban/native-agent-fork-prompt-cache-measurements/new-persistent-run"

# 官方临时与预测临时 fork；两档各三次，不改变安装或生产配置。
node scripts/measure-codex-fork-cache-repair-candidates.mjs \
  --codex-binary /absolute/path/to/codex --binary-label official-0.166.0 \
  --fork-modes ephemeral,prediction-ephemeral \
  --evidence-directory "$HOME/.cline/kanban/native-agent-fork-prompt-cache-measurements/new-ephemeral-run"

# 离线重算不启动 app-server、不读取凭据、不调用模型。
node scripts/measure-codex-fork-cache-repair-candidates.mjs --analyze-only \
  --evidence-directory "$HOME/.cline/kanban/native-agent-fork-prompt-cache-measurements/task-bde2b-codex-repair-2026-10-31/official-ephemeral-with-history-proof"
```

同一目录保留所有已开始的 case，不重发提交状态未知的请求；尚未创建或仍为 prepared 的步骤会继续执行。`--analyze-only` 先从原生协议补读原回合。
因临时会话随进程退出而消失，缺少原始结束证据时仍保持未知；新的独立实验使用新目录，不能覆盖旧失败记录。

### 社区补丁的源码与构建归属

从官方 0.166.0 tag 的固定 commit `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856` 创建本任务专属源码副本，
仅移植 `codex-rs/core/src/session/session.rs` 的两处缓存行为：去掉 root fork 缓存继承的 ephemeral 限制；
若继承项没有 `SessionMeta`，以原生 `forked_from_thread_id` 回退。保留非 root agent 分支、真实 child 会话身份与存储，
不通过复用父 session ID 冒充分身。此为对社区思路的最小适配，并非直接运行社区整个分支。

源码归属、下载归档 SHA-256、修改前后文件 SHA-256、完整 diff、固定 Rust 1.95.0、构建参数与逐次日志都保存在
上述证据根目录。`community-portable-fork-cache.patch` 为行为补丁；源码文件从
`5744a8ae7ea56424735be322a2b3437221f1be9208c8632fc44d1e06da0d0710` 变为
`87b538c8e950f9ef8c6f7140b5f725a08ee6dba2eb95584e781f5cf8c60685d9`。

官方 tag 的 workspace 版本已改为 0.166.0，但 `Cargo.lock` 中 170 个本地包仍为 0.0.0；
构建前只对齐这些本地包版本，逐条确认第三方依赖记录、版本、来源与校验和完全不变。
这一发布元数据处理另存为 `release-local-package-version-normalization.patch`，不混入缓存行为补丁。
构建继续使用 `--locked`。网络恢复使用
[Cargo source replacement](https://doc.rust-lang.org/cargo/reference/source-replacement.html) 指向
Rust 官方 `rust-lang/crates.io-index` 的 GitHub sparse 入口，TLS 校验保持开启，包仍从 `static.crates.io` 下载；
本机缓存复用也须匹配固定锁文件的 SHA-256。

构建产物只放在本任务证据目录 `build-target/debug/codex`，未覆盖已安装二进制、全局配置或共享构建目录。
使用 `dev` 未优化 profile，关闭调试信息与增量编译，`-j 2`；构建二进制 SHA-256 为
`5afbb4a4077cbeddd4e83fa6f5a84b88c1522707f6ff8f6f028185cdf22b649b`，原生版本为 `codex-cli 0.166.0`。
逐文件与官方归档核对了 9,731 个普通文件，仅上述缓存行为文件与发布锁文件变化。
对照使用官方发行二进制，本轮未再构建一个无补丁的同 profile 二进制。
此补丁的验收范围是当前进程内的 fork 首轮及第二轮缓存；重启后 resume 的缓存路由、深层 fork 链与生产工具历史
均需要单独实验，不能因本轮结果自动视为已经解决。

### 社区补丁的真实持久化 fork 结果

| 目标规模 | fork | 实际 input | cached | 总命中率 | 保守历史复用参考 |
| --- | --- | ---: | ---: | ---: | ---: |
| 32k | #1 首轮 | 32,133 | 31,872 | 99.19% | 100% |
| 32k | #2 首轮 | 32,132 | 31,872 | 99.19% | 100% |
| 32k | #3 首轮 | 32,134 | 31,872 | 99.18% | 100% |
| 128k | #1 首轮 | 128,135 | 127,872 | 99.79% | 100% |
| 128k | #2 首轮 | 128,133 | 127,872 | 99.80% | 100% |
| 128k | #3 首轮 | 128,134 | 127,872 | 99.80% | 100% |

| 对照 | 32k：input / cached | 128k：input / cached |
| --- | ---: | ---: |
| 空历史冷基线 | 11,392 / 9,600 | 11,391 / 0 |
| 父首次请求 | 32,029 / 4,480 | 128,034 / 9,600 |
| 父热续跑，fork 前 | 32,081 / 31,872 | 128,083 / 127,872 |
| fork #3 第二轮 | 32,183 / 32,000 | 128,185 / 128,000 |
| 父热续跑，fork 后 | 32,131 / 31,872 | 128,134 / 127,872 |

**这份社区适配补丁在本轮六个持久化 fork 首轮中全部有效**，读取量远超 11,392 / 11,391 的公共前缀上界，
并达到父热对照的缓存参考。六个分身均逐字继承完整父提示词，原生父子身份与父转录不变核验通过。
官方组与社区构建组的基础指令、额外工具声明摘要完全一致，模型与推理配置一致。
临时组的首轮还要求回读随机标记，因此不同组的末尾问题长度不同；不要把总命中率的小幅差异当成路径性能排序。

综合本轮数据：官方 0.166.0 的普通持久化路径仍失效；官方临时路径已经能复用父缓存；
社区适配让本次持久化路径也恢复了首轮复用。这与上游 issue 的缓存亲和性分析吻合，
支持将它视为有效修复候选，不能写成「官方默认持久化 fork 已全面修复」。
本轮没有把候选安装到生产，也没有验证重启后 resume 的缓存延续。

该组完整证据在 `community-patched-persistent/`。本轮三组共 54 个具有单次原生用量的测试回合，
其中 24 个为 fork 首轮；另有 12 个因历史接口不支持而没有提交模型回合的临时分身，保留为未执行。
`native-evidence-cross-verification.json` 记录原生协议与清单的逐请求交叉核验；
`source-archive-difference-verification.json`、`community-build-provenance.json` 和 `community-build-result.json`
记录源码、构建恢复与产物来源。已安装 Codex 的 SHA-256 保持不变。

```sh
# 运行本轮已构建的社区适配版本；给新实验使用新的持久目录。
node scripts/measure-codex-fork-cache-repair-candidates.mjs \
  --codex-binary "$HOME/.cline/kanban/native-agent-fork-prompt-cache-measurements/task-bde2b-codex-repair-2026-10-31/build-target/debug/codex" \
  --binary-label community-adapted-0.166.0 --fork-modes persistent \
  --evidence-directory "$HOME/.cline/kanban/native-agent-fork-prompt-cache-measurements/new-community-persistent-run"

# 包含逐请求计量、压缩、继承与响应落盘前中断恢复的离线用例。
npm run test:guarded -- --project precommit-safe \
  test/runtime/diagnostics/native-agent-fork-prompt-cache-measurement.test.ts \
  test/runtime/diagnostics/codex-fork-cache-repair-candidates.test.ts
```

此入口锁定已验证的 0.166.0 协议与模型配置，其他版本须先复核协议，再显式扩展版本约束。
29 个受保护离线用例、Node 语法与定向类型检查通过。根类型检查仍有 41 个既有依赖接口错误，
本次测量文件无类型错误；没有为绕过它们修改共享依赖或业务源码。
同目录恢复控制运行保持 16 个已完成模型回合，未新增 `turn/start`；离线重算保持用量与原生协议不变。
另从真实协议派生离线中断 fixture，删除一条回合响应身份和用量后，成功从唯一原生接受记录恢复，未调用模型；
这是人工损坏清单的恢复测试，不冒称真实运行发生过该次中断。记录见 `resume-and-offline-recovery-verification.json`。
本轮属于隔离诊断与报告，不依赖运行实例部署，因此不注册部署后验证条目，也不启动 RVF / Land 流程。

## 十、2026-10-31：Cursor Grok 4.7 原生分身与缓存复测

### 历史结果与当前适配

九月没有测得 Cursor 的 fork 缓存表现：当时扫描不到 fork，只测了线性续跑，输入约 12.3k → 17.0k → 19.3k，
报告命中率 72.6% → 10.5% → 11.9%，后两轮 cached 约 2k。这是历史记录，不能当成当前 Grok 分身的结论。
十月上轮只确认原生 `/fork` 已存在，没有调用 Cursor 模型。

本轮官方 [slash commands](https://cursor.com/docs/cli/reference/slash-commands) 与本机安装包均确认 `/fork`。
当前工作区的 Kanban 完整复刻门禁仍只放行 Claude / Codex / OMP，Cursor 的普通新建、按 ID 续跑、身份管理已接入，
原生分身尚未接入生产。`src/terminal/agent-session-adapters.ts` 只修正了旧注释，未放开契约或改变运行时行为。

### 配置、原生用量与证据口径

- CLI：`2026.10.22-27dcf5f`，安装包 `8008.index.js` SHA-256 为
  `448a22d3908279dbfd7ac47c014979643add4d73b63f2bd880dce6501abec678`。
- 模型目录动态解析后固定 `grok-4.7-high`，非 Fast；原生初始化报告 `Grok 4.7 256K High`。
- 每组均为两档 32k / 128k、各三个独立原生 fork，含冷基线、父热续跑前后及一个分身第二轮。
  第一组在适配修正后恢复，第二组用同一模型完整连续执行；两组共 32 个成功模型回合、12 个真实分身首轮。
- HOME、Cursor 配置 / 数据目录、hooks 和工作目录隔离；只读复制必要凭据到私有文件凭据库。
  原安装包、真实会话、真实 Keychain 与生产 fork 路径均未修改。
- 用量取每次独立 headless 进程的原生 `result.usage`，须有绑定会话 ID、用户随机请求标记、成功结果及 `request_id`。
  `usage.inputTokens` **已经扣除 cached / cache write**；总输入须相加，不能再直接用它作命中率分母。
  本机源码的原生转换逻辑与原始 stdout 一起留存。工具、多响应、压缩、缺字段或破损记录不作为单请求有效证据。

本轮读取 32 个 `result` 均有独立请求 ID、实际模型与用量，未混入父会话累计值；cache write 全部为 0。
配置摘要检查的是固定 CLI / 模型、私有 hook 配置与启动参数，没有抓取服务端完整 gRPC 请求体和实际工具声明。
以下都是原生上报的缓存用量，不证明物理 KV 重算原因。

### 每个首轮样本

「恢复试跑」的父热对照到首个 fork 分别隔了 366.401 / 393.180 秒。第二组连续执行是为检查这个时间间隔的影响，
不是删除低命中样本再挑选成功结果。第二组仍有 32k 波动，因此不能把试跑的低命中简单归因为等待过久。

| 组别 | 目标规模 | fork | 实际总输入 | cached | 总命中率 | 相对父热历史缓存参考 | 资格 |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| 恢复试跑 | 32k | #1 | 32,336 | 6,016 | 18.60% | 0% | 有效计量 |
| 恢复试跑 | 32k | #2 | 32,332 | 32,128 | 99.37% | 100% | 有效计量 |
| 恢复试跑 | 32k | #3 | 32,334 | 32,256 | 99.76% | 100% | 有效计量 |
| 恢复试跑 | 128k | #1 | 128,343 | 128,128 | 99.83% | 100% | 有效计量 |
| 恢复试跑 | 128k | #2 | 128,346 | 128,256 | 99.93% | 100% | 有效计量 |
| 恢复试跑 | 128k | #3 | 128,344 | 128,256 | 99.93% | 100% | 有效计量 |
| 连续对照 | 32k | #1 | 32,335 | 32,128 | 99.36% | 未知 | 热对照失效，证据不足 |
| 连续对照 | 32k | #2 | 32,337 | 32,256 | 99.75% | 未知 | 热对照失效，证据不足 |
| 连续对照 | 32k | #3 | 32,335 | 6,016 | 18.61% | 未知 | 热对照失效，证据不足 |
| 连续对照 | 128k | #1 | 128,409 | 128,256 | 99.88% | 100% | 有效计量 |
| 连续对照 | 128k | #2 | 128,414 | 128,256 | 99.88% | 100% | 有效计量 |
| 连续对照 | 128k | #3 | 128,416 | 128,256 | 99.88% | 100% | 有效计量 |

公共前缀上界仍取同组空历史请求的全部输入：恢复组 11,181 / 11,178；连续组 11,189 / 11,190 tokens。
表中远超上界的 cached 读数表明可复用对话历史，不能只解释为系统指令等公共前缀。100% 仍是达到父热对照
扣上界后的参考量，不等于总输入全命中。连续组 32k 的参考比例因对照失效保持未知，原始用量照常展示。

| 组别 / 规模 | 父首次：input / cached | 父热续跑前：input / cached | 分身第二轮：input / cached | 父热续跑后：input / cached |
| --- | ---: | ---: | ---: | ---: |
| 恢复 / 32k | 32,022 / 6,016 | 32,205 / 32,000 | 32,457 / 32,256 | 32,334 / 32,256 |
| 恢复 / 128k | 128,030 / 6,016 | 128,213 / 128,000 | 128,474 / 128,256 | 128,342 / 128,256 |
| 连续 / 32k | 32,023 / 11,136 | 32,206 / 1,152 | 32,454 / 2,688 | 32,338 / 32,256 |
| 连续 / 128k | 128,027 / 6,016 | 128,282 / 128,000 | 128,540 / 128,384 | 128,413 / 128,256 |

**结论：Cursor Grok 原生 fork 能复用父历史；本轮 128k 的六次首轮都接近全量命中，32k 存在明显波动，
且波动也出现在普通热续跑。不能宣称 Cursor fork 恒定命中，也不能把所有低命中归为 fork 独有缺陷。**
连续组执行退出码为 2，原因是三个 32k 样本的热对照不满足资格，不是模型调用失败或额度耗尽。
这些证据不支持取消生产成本闸，也不直接外推 Kanban 角色指导、权限变化或真实重型工具历史。

### 分身语义与正式接入的缺口

原生 `/fork` 经 PTY 触发，再以明确子 ID 执行 headless 首轮；没有通过手写复制数据库冒充原生 fork。
12 个分身都核对原生成功回执、独立 `meta.agentId`、相同历史根指针以及全部历史 blob 的内容校验和。
blob 的原生 ID 与内容 SHA-256 一致；父历史的根指针和 blob 集合在派生前后均不变。
SQLite 只打开脚本私有目录的副本，没有读取真实任务的 store，也不从目录名反推子身份。

存储格式为 `meta` 表 `key='0'` 行中的十六进制 JSON；解码只返回身份、根指针及模型 / 模式字段，
不输出私有加密字段。headless 显式 `--model` 没有在这些父 store 中可靠持久化 `lastUsedModel`，
所以测试同时固定模型参数并核对原生初始化，不能把模型继承完全交给 store。

**子身份回执仍需适配。** 原生 `/fork` 的屏幕回执只给旧父 ID；准备进程 fork 后 `/quit` 的 `sessionEnd`
仍报告父 ID，而不是新子 ID。时间关联核验显示，子 ID 是后续实际运行分身才在 hook 中出现。
因此不能把退出准备进程的 hook 当成首条消息之前的可信子身份。本次通过私有 store 补证可完成研究，
但没有据此放宽生产身份来源规则。正式接入还须实现可信子身份、精确续跑、权限 / 角色指导与重启恢复，
不是简单将 Cursor 加入能力白名单。

原生 PTY slash 输入最初停在候选菜单，已改为先写文本、待渲染后单独写 Enter。
在确认原控制进程退出、没有原生成功回执且私有桶没有新子 store 后，仅重试了本地创建动作；
所有成功模型回合均从原始 stdout 补读，没有重发。原失败日志和有界恢复依据保留在恢复组目录。

### 证据与复现

```text
~/.cline/kanban/native-agent-fork-prompt-cache-measurements/task-bde2b-cursor-grok-2026-10-31/
~/.cline/kanban/native-agent-fork-prompt-cache-measurements/task-bde2b-cursor-grok-contiguous-2026-10-31/
```

每组包含 `cursor-run-manifest.json`、`cursor-measurements.json`、`cursor-report.zh-CN.md`、逐请求 stdout / stderr、
原生 PTY 回执及私有 store 快照。私有 runtime 含凭据，原生 hook 日志还可能包含账号信息，不能打包为公开附件。

```sh
# 本机已验证的 Node；其他环境须使用与其原生依赖绑定匹配的版本。
CURSOR_CACHE_MEASUREMENT_NODE_BIN="$HOME/.nvm/versions/node/v24.12.0/bin/node"

# 新实验；省略 --model 时从原生目录选择最新一代非 Fast Grok high。
"$CURSOR_CACHE_MEASUREMENT_NODE_BIN" scripts/measure-cursor-grok-native-fork-prompt-cache.mjs \
  --model grok-4.7-high \
  --evidence-directory "$HOME/.cline/kanban/native-agent-fork-prompt-cache-measurements/new-cursor-grok-run"

# 同目录恢复会先补读已有结果，不重发已完成或提交状态未知的模型请求。
"$CURSOR_CACHE_MEASUREMENT_NODE_BIN" scripts/measure-cursor-grok-native-fork-prompt-cache.mjs \
  --evidence-directory "$HOME/.cline/kanban/native-agent-fork-prompt-cache-measurements/task-bde2b-cursor-grok-2026-10-31"

# 离线重算：不调用模型、不读取认证凭据。
"$CURSOR_CACHE_MEASUREMENT_NODE_BIN" scripts/measure-cursor-grok-native-fork-prompt-cache.mjs --analyze-only \
  --evidence-directory "$HOME/.cline/kanban/native-agent-fork-prompt-cache-measurements/task-bde2b-cursor-grok-contiguous-2026-10-31"
```

本机测量和受保护测试使用 Node 24.12.0，以匹配已安装的原生依赖；没有重建或覆盖共享 `node_modules`。
入口在调用模型前先检查 SQLite 原生绑定，ABI 不匹配时直接拒绝，不先发请求再在读取 store 时失败。
新建实验的凭据准备当前仅验证 macOS。离线 fixtures 覆盖输入口径、缺字段、继承污染、多响应、工具与压缩、
模型目录选择、十六进制元数据及完整 blob 继承。生产分身行为、共享构建产物与全局配置均未改动。

## 十一、2026-11-16：Claude Opus / Sonnet 5.5，各一组热父会话与 fork 首轮

**所测两种模型均成功复用父历史缓存，首轮总输入命中率约 99.9%。** 这是当前模拟会话的正面证据，
不是九月 446k 交互式 scratchpad 故障已修复的证据。本次捕获的默认 system prompt 没有 scratchpad 段。

### 方法与边界

先审阅 `measure-native-agent-fork-prompt-cache.mjs` 和 Cursor 入口；原脚本没有 Claude 执行器，
因此新增仅依赖 Node 标准库的 `scripts/measure-claude-native-fork-prompt-cache.mjs`，沿用环境白名单、
合成词序列、空历史公共前缀上界和提交前持久化方法。没有为此安装仓库依赖。

- CLI：本机 Claude Code **2.1.323**，没有更新全局 CLI。认证为 first-party OAuth。
- 模型：明确指定并核验原生回执中的 `claude-opus-5-5`、`claude-sonnet-5-5`，均为 `high` effort。
  模型名称与 ID 经 [Opus 官方文档](https://platform.claude.com/docs/en/models/opus-5-5/overview) 和
  [Sonnet 官方文档](https://platform.claude.com/docs/en/models/sonnet-5-5/overview) 核对。
- 独立 HOME、CLAUDE_CONFIG_DIR 与 cwd；不导入仓库指导、用户 hooks、MCP 或 plugins。
  保留默认 system prompt 和工具集；`dontAsk` 权限模式；所有测试回合都没有工具调用或压缩。
  父子均用 `-p` headless（SDK 入口的默认 system），不是 PTY 交互式会话。
- 每模型只有一组：空历史基线 → 父 seed → 同 ID 父 hot → `--resume <父 ID> --fork-session` 首轮。
  父会话共两轮；没有重复比较、多规模矩阵、分身第二轮或 fork 后的父续跑。
- `--context-tokens 64000` 控制合成词数，并不是模型 tokenizer 的精确输入目标。本轮实际输入为约 116k / 119k。
  fork 提问不携带答案，要求回读父首条 user 消息中的随机 UUID。
- 父 hot 请求完成后分别 **0.034 / 0.041 秒**开始启动 fork 命令；首轮在其后约 8 / 6 秒完成。
  这是本地命令间隔，不声称测得服务端到达时间。

原生 fork 语义参照 [官方 CLI 文档](https://code.claude.com/docs/en/cli-reference)。本次没有设置自定义
system prompt、关闭默认 snapshot，或手工复制历史来制造 fork。

### 全部八个模型回合

`总输入 = input_tokens + cache_read_input_tokens + cache_creation_input_tokens`。

| 模型 | 步骤 | 总输入 | cache read | cache write | 非缓存 input | output |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Opus 5.5 | 空历史基线 | 18,071 | 11,370 | 6,699 | 2 | 4 |
| Opus 5.5 | 父 seed | 116,366 | 11,370 | 104,994 | 2 | 4 |
| Opus 5.5 | 父 hot | 116,447 | 112,218 | 4,227 | 2 | 4 |
| Opus 5.5 | **fork 首轮** | **116,562** | **116,425** | **135** | **2** | **25** |
| Sonnet 5.5 | 空历史基线 | 17,961 | 11,370 | 6,589 | 2 | 4 |
| Sonnet 5.5 | 父 seed | 118,972 | 13,291 | 105,679 | 2 | 4 |
| Sonnet 5.5 | 父 hot | 119,049 | 114,820 | 4,227 | 2 | 4 |
| Sonnet 5.5 | **fork 首轮** | **119,164** | **119,027** | **135** | **2** | **33** |

| 模型 | fork 总命中率 | 公共前缀保守上界 | 超出上界的 cache read | 相对父 hot 历史缓存参考 | fork 首轮增量估算费用 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Opus 5.5 | **99.8825%** | 18,071 | 98,354 | 100% | **$0.0248730** |
| Sonnet 5.5 | **99.8850%** | 17,961 | 101,066 | 100% | **$0.0127767** |

公共前缀上界取空历史总输入与父 seed 已读缓存中的较大值。100% 为达到父 hot 扣上界后的参考量，
上限截为 100%；不表示 fork 全部输入命中。此次 fork 只重写 135 tokens，另有 2 个非缓存输入 tokens，
cache read 明显覆盖了父对话历史，不能用「只复用共享工具或 system prompt」解释。
两组含冷建父会话与空历史基线的 CLI 累计估算增量分别约 **$0.97949 / $0.49284**，合计 **$1.47233**；
这是 CLI 按价目估算的费用，不是订阅账户的额外扣款账单。

### 继承、前缀与计量核验

两次均取得独立子 session ID；父 transcript 在 fork 前后逐字节 SHA-256 相同；父 user / assistant
消息的 UUID 与内容完整出现在子历史；子首轮都准确回读随机 UUID。计量只取本次 stdout，
不把子 transcript 内复制过来的父 usage 算进首轮。

原生 transcript 现在含 `api-request-shape` 与 `api-request`：两组父 hot 与子首轮的 system、工具声明和
请求参数（模型、thinking、effort、betas 等）SHA-256 分别一致。实际 system 快照中没有 scratchpad，
因此这次仍不能覆盖九月的 session ID 路径差异。没有据此宣布上游
[issue #77306](https://github.com/anthropics/claude-code/issues/77306) 已修复；2026-11-16 查询时它仍 open，
已读取正文与全部评论。相同前缀与成功 usage 证明本次路径可用，不能证明复杂工具历史、改变角色指导、
切换 cwd / 模型 / 权限、跨重启或所有交互式会话也会命中。

本次还确认两个新版本遥测细节：

1. `result.usage.iterations` 与原生 transcript 的最终 assistant usage 一致。流式 assistant 的
   `output_tokens` 在 Opus seed 中暂报 3，最终是 4，输入与缓存三项一致。入口最初因此中止采集，
   修正后从原 stdout 补证，再执行尚未提交的步骤；没有重发任何已完成请求。
2. `total_cost_usd` 和 `modelUsage` 是继承父计数器的累计值。Opus 子结果的 $0.9235346 包含父 $0.8986616，
   本次 fork 增量为差值 $0.0248730。Sonnet 同理；把全部 result 费用直接相加会重复计算父成本。

### 证据与复现

本机私有证据目录：`~/.cline/kanban/claude-native-fork-cache-recheck-20261116/`。
包含 `manifest.json`、`measurements.json`，以及八个步骤各自的 prompt、stdout、stderr、debug 与原生
transcript 快照。私有 runtime 含账户配置，不作为公开附件。

```sh
# 新实验会真实调用模型；目录必须全新。此次只执行了一组两模型对比。
node scripts/measure-claude-native-fork-prompt-cache.mjs \
  --evidence-directory "$HOME/.cline/kanban/new-claude-fork-cache-measurement" \
  --context-tokens 64000

# 已有证据离线重算；不读取凭据、不调用模型。
node scripts/measure-claude-native-fork-prompt-cache.mjs --analyze-only \
  --evidence-directory "$HOME/.cline/kanban/claude-native-fork-cache-recheck-20261116"
```

`--continue` 只补采已成功步骤，并发送尚未登记的新步骤；提交状态未知的步骤直接拒绝重发。
语法与离线重算在 Node 22.23.4 验证。没有修改生产适配器、部署运行实例或成本闸；本次没有只能部署后验证的行为。

## 十二、2026-11-16：Antigravity CLI / Gemini 4；Carbon 仅准备

**Argon 本次原生 fork 首轮没有复用缓存，前后父热对照有效。Hydrogen 首轮同样为零，但最近的父对照也失效，
其 fork 缓存结论保持证据不足。** 两种模型各只创建一个真实分支、只执行一次分支首轮；没有重复分支比较。

### 产品入口与配置

个人 Google AI Pro / Ultra 的 coding 订阅当前应经 Antigravity CLI（`agy`）测试。此前准备的 Gemini CLI
没有发送模型请求：Google 的[个人账号弃用公告](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals)
确认个人订阅已于 2026-06-18 迁往 Antigravity；旧认证页仍存在个人登录说明，不能优先于迁移公告与当前 README。
本轮使用用户已安装并登录的 **Antigravity CLI 1.5.9**，没有替换或更新它。

| 配置 | 原生 `agy models` 中的 slug | 本轮处理 |
| --- | --- | --- |
| Gemini 4 Hydrogen / High | `gemini-4-hydrogen-high` | 实测 |
| Gemini 4 Argon / High | `gemini-4-argon-high` | 实测 |
| Gemini 4 Carbon / High | 当前账号目录中没有；待资格就绪后核对 `gemini-4-carbon-high` | 仅准备，零模型请求 |

没有选 Orchestrator，也没有混入其他 provider。每个成功回合的原生 `init.model` 均与请求 slug 一致，
`init` 中的工具集合、cwd 和 `permission_mode=request-review` 在各自父热对照与子首轮之间一致。
所有回合没有工具或子代理执行。

入口为 `scripts/measure-antigravity-native-fork-prompt-cache.py`，只依赖 Python 标准库。
真实 HOME 保留给原生账号 / keyring；会话、配置、缓存、工作目录和日志用原生 `--gemini_dir`、`--app_data_dir`
参数隔离，未复制用户会话。诊断配置关闭 `useG1Credits`，不修改用户全局设置。
直接更换 HOME 会失去原生登录可见性，本轮已在发模型请求前用只读模型目录查询确认这一点。

### 原生分支与完整性

父回合经 `--input-format stream-json --output-format stream-json` 发出。首次尝试 `--print /fork` 时，CLI
明确拒绝 print 模式，返回空会话 ID、`num_turns=0` 和全零 usage；没有模型请求，也没有创建分支。
随后按[官方原生 `/fork` 流程](https://antigravity.google/docs/cli/conversations)经自有 PTY 操作同一父会话。

Hydrogen 的第一次 PTY 只停在隔离存储的首次界面初始化，没有进入会话输入。停止后核对原生 store ID 集合与
父 steps 均未变化，再导入同账号已经完成的 onboarding 缓存；没有代替用户确认新条款或数据收集选项。
初始化延迟使最早的热对照离实际 fork 约五分钟，因此补了一次父热请求；它返回零缓存，不能冒充有效热对照。

两次真正 fork 都保存 PTY 的 `Forked conversation` 回执与退出时的完整子 ID，并与原生
`last_conversations.json` 的当前 cwd 绑定、独立 SQLite store 交叉核验。SQLite 只读备份进入私有证据目录。
父 `steps` 的 idx、type、status、payload 在 fork 前后完整一致；子首轮之前的 store 继承了全部冻结父 steps。
Hydrogen 的父参考取实际 fork 前已保存的 hot-refresh 快照，初始化前的旧快照继续保留。
这里证明的是历史步骤没有改写，不宣称 SQLite 的访问元数据或文件字节也不变化。

分支首轮的问题不携带随机 UUID 答案，两种模型都正确回读了父首条 user 消息中的 `RECALL_KEY`。
没有手工复制数据库或重放消息来冒充原生 fork。

### 全部十二个成功主回合

`--context-words 64000` 为合成词数；Gemini tokenizer 下实际请求约 43k–45k tokens，不是 64k 精确输入目标。
`总输入 = step.usage.input_tokens + step.usage.cache_read_tokens`；本 CLI 的 `input_tokens` 与
`total_tokens` 都排除了 cached，不能直接用 cached 除以它们求总输入命中率。thinking 已计入 output，不能再加一次。

| 模型 | 步骤 | 主请求总输入 | cache read | output（含 thinking） |
| --- | --- | ---: | ---: | ---: |
| Hydrogen | 空历史基线 | 10,454 | 0 | 32 |
| Hydrogen | 父 seed | 43,390 | 0 | 93 |
| Hydrogen | 最初父 hot | 43,692 | 41,336 | 30 |
| Hydrogen | 初始化等待后父 hot-refresh | 43,931 | 0 | 14 |
| Hydrogen | **唯一分支首轮** | **44,164** | **0** | **150** |
| Hydrogen | 分支后父 hot-after | 44,855 | 0 | 14 |
| Hydrogen | 最后一次父热补对照 | 45,078 | 0 | 14 |
| Argon | 空历史基线 | 9,750 | 0 | 27 |
| Argon | 父 seed | 42,914 | 0 | 89 |
| Argon | 父 hot | 43,212 | 40,865 | 27 |
| Argon | **唯一分支首轮** | **43,463** | **0** | **155** |
| Argon | 分支后父 hot-after | 43,448 | 41,163 | 27 |

两次子首轮命令分别在最近父请求结束后 **6.409 / 6.430 秒**启动，间隔主要用于原生 PTY fork。
Argon 前后父 hot 的总命中率分别约 **94.57% / 94.74%**，且 cache read 远超 9,750 的公共前缀上界。
因此 Argon 的首轮 **0 / 43,463** 是有效对比中的未命中，不是父历史根本没有缓存。

Hydrogen 最初的普通续跑曾读取 41,336，但初始化等待后的父请求及分支后的两次补对照都为零。
最后一次补对照仍冷时，入口没有再创建第二个分支或发送第二个子首轮。该模型的 **0 / 44,164** 作为观察保留，
`historyReuseRatio=null`；不能断言其原因只在 fork，也不推定任何内部 TTL、路由或 prompt 变化根因。

### 会继承的累计计数器

[官方 headless 文档](https://antigravity.google/docs/cli/headless)提供逐步 stream 事件与累计 result 的区别。
本轮还直接确认 **跨进程 resume / fork 的 result 会继承父计数器**：

| 数据 | Hydrogen | Argon |
| --- | ---: | ---: |
| 子首轮 `result.usage.cache_read_tokens` | 41,336 | 40,865 |
| 子首轮本次完成的 `agent_response.usage.cache_read_tokens` | **0** | **0** |

如果只读 result，就会把父命中错算成子首轮命中。脚本只取本次 stdout 中唯一完成的主 `agent_response`，
按 step index 去重，要求完整计量、成功结束和同一原生会话 ID；继承的数据库 usage 也不参与首轮统计。
用量表不是费用账单，本轮没有从缓存数字反推订阅额度消耗或美元费用。

### Carbon 待测入口与证据

```text
~/.cline/kanban/antigravity-native-fork-cache-recheck-20261116/
~/.cline/kanban/antigravity-carbon-fork-cache-prepared-20261116/prepared-plan.json
```

第一处包含 manifest、重算结果、十二个主回合的原始 stdout / stderr、每步原生 store 备份、PTY 回执、
失败的本地准备记录及模型目录。第二处为 Carbon 的待执行计划：记录 `currentlyAvailable=false`、
`liveModelRequests=0`，以及升级后使用相同 High / 64,000 词配置的命令。执行时必须重新命中原生模型目录，
不回落其他模型、不购买或升级订阅、不自动开始未来测试。

```sh
# 不调用模型：重算现有两模型证据。
python3 scripts/measure-antigravity-native-fork-prompt-cache.py --analyze-only \
  --evidence-directory "$HOME/.cline/kanban/antigravity-native-fork-cache-recheck-20261116"

# 不调用模型：准备或更新 Carbon 计划。
python3 scripts/measure-antigravity-native-fork-prompt-cache.py --prepare-only --models carbon \
  --evidence-directory "$HOME/.cline/kanban/antigravity-carbon-fork-cache-prepared-20261116"

# 用户确认订阅资格就绪后才执行；会真实调用模型。
python3 scripts/measure-antigravity-native-fork-prompt-cache.py --models carbon \
  --evidence-directory "$HOME/.cline/kanban/antigravity-carbon-fork-cache-prepared-20261116"
```

新的独立实验使用全新目录；已有实验只有 `--continue` 才能接续，已成功的模型回合不会重发。
提交状态未知的 PTY fork 必须先核对回执与原生事实；没有原生子身份就不发送子首轮。
Python 语法、离线计量与资格拒绝校验另行验证；没有修改生产适配器、部署实例或成本闸，无部署后待验断言。

## 十三、2026-11-16：Antigravity 方法论复核与社区修复候选

**本节没有新增模型请求，也没有再次创建分支。** 从第十二节保存的十二个 SQLite 快照离线补读原生提示词，
并查询社区原始讨论、官方维护者答复和候选实现。Carbon 继续保持未执行。

### 原实验可以与不可以证明什么

| 检查项 | 复核结果 | 结论边界或改进 |
| --- | --- | --- |
| 是否误读继承计数 | 没有；使用完成的主 `agent_response`，排除了 result 中父会话累计 cache read | Argon 子 result 的 40,865 不能冒充本次读取；本次 step 确为 0 |
| 是否没有继承父历史 | 两次原生 fork 的独立 ID、冻结 steps 和随机标记都通过 | 已证明所测分支语义，未用新建空会话冒充分支 |
| 是否没有热父缓存 | Argon 前后父热读取均有效；Hydrogen 最近父对照及后续补对照失效 | Argon 支持该原生路径的单次零读取观察；Hydrogen 继续为证据不足 |
| 是否证明请求前缀逐字一致 | 之前没有；`configurationFingerprint` 只涵盖 `init` 的模型、工具名、cwd、权限等 | 现在显式标注其 scope，并增加独立的原生 system prompt 证据，不能把 UI 配置指纹当完整请求指纹 |
| 是否只测了 fork 一个变量 | 实际路径为 headless 父 → TUI `/fork` → headless 子，包含模式 / 进程边界 | 只对该自动化路径下结论；不外推全程同一 TUI，也不由零读取直接证明后台 KV 路由故障 |
| 规模与次数 | 每模型一个真实 fork，实际约 43k–45k 输入；无真实工具历史 | 不当作大规模生产可靠性或计费测试；没有为补样本反复创建分支 |

四分钟只是本诊断的时间资格检查，不是服务端承诺的缓存 TTL。实际的前后热读取才是对照依据。
所有命中与未命中均指原生接口**报告的缓存 token 数**；物理 KV 是否复用、具体订阅额度扣减，仍须后端诊断或计费证据。

### 新增本机证据：完整 system prompt 确实发生变化

`gen_metadata` 保存了与生成 step 绑定的请求记录。诊断入口增加只读 protobuf wire 解码：按本次 `sourceStepIndex`
选择生成记录，读取已观察的 agy 1.5.9 布局 `field 1 → field 1` 的完整 system prompt。
同时验证 `<identity>` / `<user_information>` 边界；布局不匹配或缺少唯一记录时返回 unavailable，绝不猜测或补零。
这是本地保存的请求记录，**不是对实际 HTTP 请求或服务端处理后提示词的抓包**。

| 模型 | 完整 system prompt 字符数 | 父 hot → 子首轮的不同处 | 父 hot → 父 hot-after |
| --- | ---: | --- | --- |
| Argon High | 20,387 | 仅 `Conversation ID`、`Artifact Directory Path` 中的会话 UUID | 完全相同 |
| Hydrogen High | 23,682 | 同上，仅两处 UUID | 完全相同 |

两处字段均位于靠前的 `<user_information>` 中。将它们**仅在离线诊断副本中**归一化为同一占位符后，
父子完整 system prompt 的 SHA-256 完全相同；未归一化时不同。没有修改原始 prompt、数据库、发送内容或子身份。
Argon 的父 hot system SHA-256 为 `5eabf571b275b27c80642872a9abdde8ff49b6fc039b7dd886ca67e35ca4f003`，
子为 `139f9441448962fd51180b3865eb1d6b69eb4cdf0f853489dbdd40f835d25d79`；父 hot-after 恢复为前者。

因此，本次不是「已证明前缀逐字相同，fork 仍失去后端亲和性」的实验。**本机已观察到原生 fork 自身改写前部
system 内容**；按 prefix caching 机制，这足以构成历史前缀无法完整复用的候选原因，但尚未通过修正请求后的实测
隔离出其全部因果影响，也不能排除其他请求字段或后端缓存因素。

### 社区讨论与实现：可借鉴，但没有直接验证的官方 agy 修复

截至本次查询，已阅读 GitHub issues 的正文、全部评论与当前状态；来源区分如下。

| 来源 | 实际证据 / 方法 | 对当前目标的适用性 |
| --- | --- | --- |
| [官方论坛的 `/btw` 分支缓存调查](https://discuss.ai.google.dev/t/after-the-latest-antigravity-app-update-btw-side-question-kept-re-running-the-same-turn-in-a-background-loop-259-turns-30m-tokens-weekly-quota-dropped-50-30/198137) | 参与者报告多次子首轮零读取；指出相同的两处 ID 注入，并提出把子身份 / 目录覆盖移到历史末尾的 system message | 与本机 prompt 差异吻合；帖子中的移动建议未附修复后首轮数据，不能当已实现补丁。App `/btw` 与 CLI `/fork` 路径也须区分 |
| [Gemini 4 缓存异常 #1533](https://github.com/google-antigravity/antigravity-cli/issues/1533) | 作者报告固定单 IP / HTTP2、逐字相同请求下仍出现缓存回退；评论另有 1.5.9 的普通续跑瞬时零读取 | 说明还存在 fork 以外的变量；它支持保留 Hydrogen 的未知态，不证明我们的 miss 属于同一根因。issue 仍 open |
| [headless 缓存与用量 #1411](https://github.com/google-antigravity/antigravity-cli/issues/1411#issuecomment-6681347816) | 维护者建议常驻 `stream-json` 进程或精确 resume，减少新会话 / 进程开销 | 可改善同一会话的多轮调用；没有证明新独立子会话首轮能复用父缓存，不算 fork 修复 |
| [Pi provider 的亲和性实现](https://github.com/heyhuynhgiabuu/pi-oauth-antigravity) | 初始内容派生稳定 session ID、trajectory / response 链接、固定成功 endpoint、跨重启状态持久化；源码在请求中设置 sessionId 和 labels | 是可研究的亲和性设计，但自行构造另一套 provider 请求，不是官方 agy `/fork` 的补丁；本任务没有安装或实测它 |
| [Antigravity-Manager 的 SessionScope 实现](https://github.com/lbjlaq/Antigravity-Manager/blob/9b82fb7ef51c42e9d1662a14bd5b718da0525cd8/src-tauri/src/proxy/thinking_store.rs) | 路由 affinity key 与独立 store key 分离；裁掉 `:step:` / `:agent:` 等派生后缀，或按凭据保持账号粘性 | 修复其 API 代理的账号调度。原生 fork 的两个随机 UUID 没有该后缀关系，而且固定路由不会消除 agy system 中两处内容差异 |

官方 changelog 可查到规则 / 路径排序稳定化等旧的缓存改进，未找到针对本次两处分支 ID 注入、且已给出首轮验证的
可直接套用修复。headless `--fork` 的 [#982](https://github.com/google-antigravity/antigravity-cli/issues/982) 与
ACP `session/fork` 的 [#1592](https://github.com/google-antigravity/antigravity-cli/issues/1592) 查询时仍 open；
没有发现等同于 Codex 官方 ephemeral root fork 的现成 agy 路径。上述检索结果不声称穷尽所有实验分支。

### 与 Codex 修复的关系、下一步资格

第九节 Codex 已测修复的重点是**独立 child 身份与父缓存亲和性分离**，而非把父 ID 直接当子会话 ID 使用。
同样的设计原则可借鉴，但 Antigravity 至少还要处理已经观察到的提示词内容变化：

1. 父 system、工具定义与历史保持逐字稳定；子会话的真实 ID / artifact 目录在父历史之后单独告知。
2. 子存储、工具归属与行动身份继续独立；如后端缓存需要 affinity，则另行继承明确的父缓存锚点。
3. 新候选只有在原生请求证据、有效前后热对照、独立子身份以及**子第一次主响应**的计量同时成立时才算修复。
   同一子会话第二轮命中、长任务平均 98% 或换 provider 后变快，都不能代替这个断言。

这是待验证的 harness 改造方向，不是已测成功方案。当前只给用户消息加一段「沿用父 ID」并不会移除原生 system
已经生成的 UUID；直接复用父执行身份也会破坏独立分支语义。本任务未部署代理、修改安装二进制或发送社区消息。

审计证据在原私有目录的 `methodology-audit/`，包含原生提示词的私有提取副本、逐字 diff 与 hash 比较；
`measurements.json` 新增 `requestPrefixEvidence`，明确 `fullRequestPrefixEquality=not_tested`，避免再次把 init 指纹
误读成完整请求相同。Carbon 待执行计划也标明混合 transport 范围和原生 system 抓取要求，仍为零模型请求。
本次仅改诊断与调查材料，无需注册部署后验证。

## 十四、2026-11-16：Antigravity 修复候选的真实请求测试

**两个模型均观察到独立子会话首轮读取父历史缓存，约 94.5%；尚无完整合格的稳定修复样本。**
原生不修改请求的 `/fork` 对照仍为零。修复候选的首轮线上 usage 与原生本次主响应一致，缓存量明显超过空历史
全部输入，因此不是继承 result 计数器的假命中。不过同版本候选的后置父热对照失效；另一个前后对照有效的 Argon
样本跨了 CLI 版本。下面分别保留「首轮正面观察」与「完整对照资格」，不为宣布成功改变第十三节的验收条件。

### 受控改动与原生语义

入口为 `scripts/measure-antigravity-fork-cache-repair-candidates.py`。保留官方 `agy`、原生账号和订阅通道，
使用进程级 `CLOUD_CODE_URL` 指向自有 loopback 中继；中继仅转发到固定的
`https://daily-cloudcode-pa.googleapis.com`，保留 TLS 验证，不接第三方 provider，不记录认证头。
普通 CLI 不接受 ACP 的 `--cloud_code_endpoint` 参数，`--version` 又会绕过该参数检查，所以实际以只读模型目录
请求验证环境变量入口，不能用「带参数的 version 成功」作为支持证据。

父会话使用常驻 `stream-json` 进程，mock seed 为 64,000 个合成词，实际约 43k–44k 输入 tokens。
每个子会话均通过官方 TUI `/fork` 创建；没有复制数据库或重放消息来伪造原生分支。
子会话保留独立 ID、store、`cascade_id`、`trajectory_id` 和请求 ID，完整继承冻结父 steps，父历史未被子回合改写，
首轮均回读父 seed 的随机 `RECALL_KEY`；答案没有放在子 prompt 里。只测每个具体候选的第一次响应，没有子第二轮。

| 候选 | 真正转发的改动 | 保留独立性的方式 |
| --- | --- | --- |
| `passthrough` | 不修改请求内容，作为同一中继内的原生对照 | 所有原生身份和前缀原样转发 |
| `prefix` | 只把 system 的 `Conversation ID` 和 `/brain/<UUID>` 两处改为父值 | 子真实 ID / artifact 目录放在末尾新增 user 消息中；原生 store 和执行身份仍为子 |
| `affinity` | 在 `prefix` 上再将 `request.labels.root_cascade_id` 指向父 root；也检查可独立继承的 `request.sessionId` | `cascade_id`、`trajectory_id`、request ID 仍独立；不冒用父原生会话身份 |

线上抓包发现，所测父子 `request.sessionId` 原本就同为 `-3750763034362895579`，所以 affinity 样本中该字段
**没有实际变化**；不能把命中归功于更改 sessionId。实际新增改动只有 `root_cascade_id`。
转发 JSON 显示：修复候选的 system、工具定义、generationConfig 与最近父热请求完全相同，父请求的全部 contents
逐条保留为子请求的开头。局部原生 `gen_metadata` 仍记录修改前的子 system；本节以前向 Google 的 JSON 作为请求证据，
不混淆原生本地记录与线上实际转发内容，也不声称知道 Google 服务端追加或处理后的最终 prompt。

### 原始读数与资格

| 模型 / 样本 | 父 before cache read / 总输入 | 子首轮 cache read / 总输入 | 父 after cache read / 总输入 | 资格与解释 |
| --- | ---: | ---: | ---: | --- |
| Argon，1.5.9 原生对照 | 40,974 / 43,186 | **0 / 43,425** | 41,137 / 43,289 | 同版本，完整对照下未命中 |
| Argon，仅固定前缀 | 41,137 / 43,289 | **未取得有效响应** | 未执行 | 请求已发，最终超时；不是 cache=0，未重发此首轮 |
| Argon，固定前缀＋父 root，跨版本 | 41,475 / 43,627 | **41,578 / 44,010（94.474%）** | 41,578 / 43,730 | 首轮命中且前后热读取有效；父为 1.5.9、子为 1.5.10，效果归因有版本混杂 |
| Argon，固定 1.5.10 原生对照 | 41,681 / 43,965 | **0 / 44,206** | 41,916 / 44,068 | 同版本，完整对照下未命中 |
| Argon，固定 1.5.10，前缀＋父 root | 41,916 / 44,068 | **42,019 / 44,452（94.527%）** | **9,596 / 44,171** | 首轮命中；后置父缓存未超出 9,742 的公共前缀上界，完整对照不合格 |
| Hydrogen，固定 1.5.10 原生对照 | 41,266 / 43,491 | **0 / 43,721** | 41,442 / 43,582 | 同版本，完整对照下未命中 |
| Hydrogen，固定 1.5.10，仅固定前缀 | 41,442 / 43,582 | **41,533 / 43,950（94.501%）** | **0 / 44,374** | 首轮命中；后置父热对照失效，未继续追加 root 候选 |

Argon / Hydrogen 的空历史全部输入分别为 **9,742 / 10,441**。Argon 基线来自 1.5.9；1.5.10 复核继续沿用，
线上工具定义与 generationConfig 完全相同，system 仅将两处会话 UUID 离线归一化后也完全相同，未再花一次请求重测基线。
三个有正面读数的子首轮均远超各自上界；至少约 31k–32k 的读取无法由公共输入解释。
所有已完成样本均以本次唯一 `agent_response` 计量，并与 Google SSE 最后的 `usageMetadata` 交叉核验：
`promptTokenCount` 对应 native 总输入，`cachedContentTokenCount` 对应本次 cache read，
`candidatesTokenCount + thoughtsTokenCount` 对应 native output。没有使用继承的 `result.usage`。
Google 未设置 cached 字段时，原生逐步计数也必须为零，不能用缺少整个 usage 的记录补成零。

修复候选的线上前缀与后置父 system 都核对相同，原生父 steps 也保持完整；后置缓存退化的原因仍未隔离，
不能凭此次观察宣布「子分支驱逐了父缓存」或认定根因是 TTL / 路由 / 订阅扣费。
Hydrogen 说明仅稳定前缀就能出现首轮命中；Argon 仅前缀项超时，所以**不能断言父 root 锚点是必要条件**。
这些是单次存在性证据，不是连续多次成功率或费用优惠的保证。

### 异常、版本冻结与成本边界

本次新增 **21 个具有有效主响应计量的成功回合、6 个具有计量的子首轮、7 次真正原生 fork**。
其中三个原生零读取首轮具备完整同版本前后热对照；三个有命中的首轮分别因版本或后置热对照不合格而不列入
`qualifiedSuccess`。另一个 Argon 子首轮只有已提交请求和超时，没有计量，独立列为 unknown，不重发、不算 miss。

安装路径在实验中由 1.5.9 变成 1.5.10，本诊断没有执行更新命令。
逐进程原生日志暴露了父子版本差异；随后将 1.5.10 复制到私有目录并记录 SHA-256，后续启动只使用固定副本。
没有重复 Argon seed，而是在现有父历史上补同版本原生对照与同一组合候选；所有先前读数保留。
最终入口对新实验默认冻结 CLI 副本，离线分析逐进程核对实际日志版本，而不只相信实验开始时的版本字段。

中继预检最初未处理 HTTP chunked 请求，模型请求在 JSON 解码前被拒绝，未转发到 Google；修正后以假上游离线验证。
另一次 Hydrogen 空历史探针受到后台只读 RPC 断开影响被提前停止，已有生成提交状态不确定；其目录单独保留，
不纳入成功回合，不用后来的新基线覆盖它。最终中继只在生成请求异常时中止实验，普通后台客户端取消不终止模型回合。
任何未知提交都不自动重发；Carbon 未进入此脚本的允许模型集合，仍为零模型请求。

### 证据、复核与交付范围

```text
~/.cline/kanban/antigravity-fork-cache-repair-20261116/
  argon/manifest.json
  argon/audited-measurements.json
  argon/incomplete-submissions.json
  hydrogen/manifest.json
  hydrogen/audited-measurements.json
  argon-transport-preflight-no-generation/
  hydrogen-aborted-background-rpc/
```

每模型目录保存原始 / 转发后的生成 JSON、逐次 Google SSE、原生逐步输出、完整进程日志、PTY 回执和冻结数据库。
只有请求与响应体进入私有证据；认证头不写盘。文件权限为仅本用户可读写，证据不提交仓库。

```sh
# 仅离线核验，不查询模型目录、不调用模型。
python3 scripts/measure-antigravity-fork-cache-repair-candidates.py --model argon --action analyze \
  --evidence-directory "$HOME/.cline/kanban/antigravity-fork-cache-repair-20261116/argon"
python3 scripts/measure-antigravity-fork-cache-repair-candidates.py --model hydrogen --action analyze \
  --evidence-directory "$HOME/.cline/kanban/antigravity-fork-cache-repair-20261116/hydrogen"
```

`observedFirstHistoryHitVerified` 只表示本次独立子首轮的正面读取证据，`completeControlledComparison` 表示对照资格，
`qualifiedSuccess` 仍要求所有对照通过及足量历史复用，不能互相替代。未知请求另列在 `incomplete-submissions.json`。
脚本的身份限定改写、保留独立执行字段、未知格式拒发、HTTP chunked 转发与离线核验经过 stdlib 检查；
没有运行全仓测试或声称通过全仓检查。所有自有 CLI 进程和中继退出后才结束。

这仍是**诊断用改写**：末尾 user 身份说明尚未验证真实工具和 artifact 的权限 / 归属语义；后续恢复会话也没有验收。
未把中继作为生产服务安装，未改 Kanban 适配器、成本闸或用户全局设置，没有提交或部署。
本次均为独立诊断和调查材料，无新增部署后才能核验的产品行为，无需注册部署后验证。

## 十五、2026-11-17：Fable 5.2 尝试与全量离线复核

用户已明确窗口期结束，停止 Fable 续测。本节不新增模型调用；全范围的复核等级与交接事项见
[最终报告的离线复核说明](agent-session-fork-prompt-cache-investigation-final-report.md#2026-11-17-离线复核与交接说明)，
可移交的读数与来源 hash 见 [脱敏数据](measurement-evidence/agent-session-fork-cache-review-2026-11-17.json)。

Fable 入口为 Claude Code 2.1.326、精确模型 `claude-fable-5-2`、high，沿用隔离 HOME / cwd、禁 hooks / MCP、
原生 `--resume --fork-session` 的计划。脚本新增可选 `--parent-hot-after`，不改变旧组的验收要求；
继承检查加强为逐项按顺序比较 UUID 与 message。`--analyze-only` 现在也保留错误终止的原因，不把无 iteration 补成零。

| 步骤 | 原始记录 | 解释 |
| --- | --- | --- |
| 空历史小基线 | input 19,525 = uncached 2 + read 11,457 + write 8,066；output 4；实际 Fable 5.2，成功 | 只证明小请求及公共前缀读取，不证明父历史复用 |
| 长父 seed | exit 1，is_error=true，api_error_status=429，terminal_reason=api_error；usage.iterations=[] | 明确返回 “Fable 5.2 requires usage credits”；没有成功推理计量，不能用零 usage 当 miss |
| 父 hot、子首轮、后置父 hot | 均未执行 | 尚未创建原生 fork，没有首轮命中率 |

父 seed 的 transcript 已登记 api-request，所以不能声称「请求从未发出」或「完全在 API 前拒绝」。
小基线原生 list-price 估算为 $0.1315234，不等于订阅实际扣款；没有购买额度、切换模型或重发。
原始目录：`~/.cline/kanban/claude-fable-5-2-native-fork-cache-20261117/`。
该目录状态保留历史事实，**不是待自动继续的工作项**；任何未来测试均须用户重新发起。

本次离线重算 Claude 5.5、Antigravity 原生、Argon / Hydrogen 修复候选与 Fable 未完成组。
十月原始证据目录当前缺失，只核对仓库报告及受保护的 44 个解析 / 恢复测试，不冒充重新验证过历史请求。
总体 160 / 58 是含历史报告的汇总；当前机器可复算的是 42 / 10，另有拒绝与未知请求记录。
Claude 5.5 原测试只有前置热对照；它们的 measured 与 Antigravity 修复候选的双向资格不是统一统计口径。
