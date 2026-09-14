# 从既有会话 fork 出分身：五家 harness 的 prompt cache 实测

本文件记录 2026-09-11 / 09-12 两天对「**从一个既有 agent 会话 fork 出一次性分身**」这件事做的跨 harness
缓存实测。它服务于 exploratory mode 的维护作业——那个作业每跑一次就 fork 一次，所以「fork 能不能复用父会话
的 prompt cache」直接决定这个功能是几分钱还是几美元一次。

**读这份文档前先知道结论**：fork 拿不到缓存**不是 prompt cache 机制的上限**，而是各家 fork 实现的缺陷。
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

Claude Code 与 DeepSeek 的遥测是直的，没有这类坑。

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
