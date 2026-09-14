# 外部 agent CLI 的低成本能力探测

接入或维护一个外部 agent harness（claude / codex / kimi / droid / kiro / opencode …）时，经常要回答「这个 CLI 到底支持什么」——某个 `--model <id>` 解析成哪个真实模型、上下文窗口多大、某旗标是否生效。本 runbook 的原则只有一条：

> **别读 `--help`、别读二进制 strings、别靠推断——用最小成本真跑一次，回读结构化输出里的真实结果。**

`--help` 只写示例（`claude --help` 的 `--model` 行只举三个别名，不是模型目录）；二进制 strings 是未承诺的内部细节；推断会随上游发版静默失效。只有运行结果不会说谎。

## 配方（以 claude 为例）

```bash
claude --model <id> -p 1 --output-format json --tools "" \
  --system-prompt "Reply ok" --strict-mcp-config --no-session-persistence
```

读返回 JSON 里的：

- `modelUsage` 的**键名** = 实际跑的模型（别名解析后的真身）；
- `contextWindow` = 实际上下文窗口（验证 `[1m]` 变体是否生效就看它是不是 `1000000`）；
- `canonicalModel` = 规范化模型名。

每个旗标都在压成本或压副作用：

- `-p 1`：单发 print 模式，prompt 内容本身无所谓（`1` 即可），跑完即退；
- `--output-format json`：结构化输出，免刮 TUI；
- `--tools ""`：**成本关键，见下节**；
- `--system-prompt "Reply ok"`：压住输出长度；
- `--strict-mcp-config` + `--no-session-persistence`：不加载 MCP、不落盘会话，排除环境污染。

## 成本对比（2026-07-25 实测）

不加 `--tools ""` 时，约 23k tokens 的 tool 定义随请求发出，是开销大头，单次探测约 **$0.24**；加上 `--tools ""` 后降到约 **$0.003**（约 80 倍）。26 个候选 id 全量探测总成本 < $0.1——全量实测完全负担得起，没有任何理由靠猜。

## 结果判读

- **返回 404** → 该 id 不可用。
- **返回 503** → 上游**瞬时故障，不是拒绝**，不能据此判定 id 无效。实证：`claude-sonnet-4-6[1m]` 曾连续 5 次 503，最终按「无法证实」处理（不进策展表、也不标记为无效），而非「无效」。503 的唯一正确应对是改天重试。
- **返回的模型与请求的不同** → 上游做了 legacy remap（旧 id 被映射到新模型）。探针能直接发现它——这正是「回读真实结果」优于「读文档」的地方。

## 泛化到其它 harness

同一配方精神适用于任何外部 agent CLI，逐 harness 换掉具体旗标即可：

1. 找到该 CLI 的**单发/只读**调用形态（print 模式、只读子命令），避免拉起全屏 TUI 或持久会话；
2. 要**结构化输出**（json / jsonl），不要刮人类可读输出；
3. **关掉一切可关的开销与副作用**：工具定义、MCP、会话持久化、遥测；
4. **回读输出里的真实结果字段**（模型真身、能力位、版本号），而不是把请求值当事实；
5. 瞬时故障（5xx、连接重置）一律记「无法证实」，绝不记「无效」。

## 与仓内 probe runner 的关系

本 runbook 是**人工/策展期**的探测配方（典型场景：维护 `src/terminal/terminal-agent-model-selection.ts` 的策展表——该表条目就是逐条用上方配方实测过的，见其模块头注释）。

仓内另有**运行期**的同一思想产物：`src/terminal/agent-cli-capability-probe-runner.ts` 把「跑某 CLI 的只读子命令、把 stdout 解析成结构化能力信息」做成声明式契约表（binary / args / timeout / maxBuffer 为纯数据，`parseStdout` 为函数），driver 统一带缓存并把失败收敛为 `{ ok: false, warning }`。运行期路径（模型选择器、会话启动）走它；人工排查与策展表维护走本 runbook。
