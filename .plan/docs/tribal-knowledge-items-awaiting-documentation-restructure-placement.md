# 待安置的 tribal knowledge 条目（等文档重构时归位）

## 这个文件是什么

2026-07-25「Claude 模型选择器双档改造」任务中踩到的坑。它们**有保留价值，但都不该直接塞进 `AGENTS.md`**——那份文件已经偏臃肿，而且这几条各自的合适抽象层面并不相同（有的属代码注释、有的属子系统架构说明、有的根本不该是文档而该机制化）。

暂存在此，等到 `AGENTS.md` 瘦身 + 整个 project documentation 重构时，按每条下面的「建议归宿」逐条搬走。

**本文件的处置：搬空即删除。** 不要让它自己长成第二份什么都往里塞的文档。

> 已刻意排除、不进本文件的两条（判断为「读几个文件就能搞清楚」，不值得长期文档化）：
> `claude --help` 的 `--model` 行只是举例而非模型目录；`deduplicateModelOptions` 逐字段重建对象、新增字段须显式透传。
> 二者都已写在 `src/terminal/terminal-agent-model-selection.ts` 的就近注释里。

---

## 条目 1 —— latest 别名不得固化其当前解析结果

### 事实

Claude Code CLI 的 `opus` / `sonnet` / `haiku` / `fable` 语义是「该家族的**最新**模型」，由 CLI 在启动时解析到当时的具体版本。把这类别名的 UI 标签写成某个具体版本号，上游一发版标签就错，而且是**静默错**——按钮写着 "Opus 4.8"，`--model opus` 实际跑的是 Opus 5。这正是本次 bug 的形态（策展表 2026-07-04 写死后未 bump）。

修复形态：别名档标签**不含版本号**（永不错标），具体版本另立一档、用完整模型名钉死（漏补只是少一个选项，不会出现标签与实跑不符）。

### 建议归宿：拆两层

- **具体层 → 就近代码注释（已完成，无需搬运）**：`src/terminal/terminal-agent-model-selection.ts` 模块头已写明双档划分理由。
- **抽象层 → 项目通用设计准则**：可提炼成一条与 Claude 无关的准则——

  > 凡标识符的含义由外部系统在运行时解析、且会随上游漂移（latest 别名、`stable` 标签、浮动 ref），
  > 就不得把「当前解析结果」固化进标签、常量或文案。要么呈现别名本身，要么钉死具体版本，不要混。

  这条属于 `AGENTS.md` 现有「Architecture opinions」那个抽象层面，或重构后独立的设计准则文档。**它不是 Claude 模型专属知识**，是本条唯一值得长期保留的部分。

---

## 条目 3 —— 外部 agent CLI 的低成本能力探针

### 事实

要确认某个 `--model <id>` 到底解析成什么，别读 `--help`、别读二进制 strings、别推断，直接回读运行结果：

```bash
claude --model <id> -p 1 --output-format json --tools "" \
  --system-prompt "Reply ok" --strict-mcp-config --no-session-persistence
```

读返回 JSON 里 `modelUsage` 的**键名**（= 实际跑的模型）、`contextWindow`、`canonicalModel`。

**`--tools ""` 是成本关键**：不加时约 23k tokens 的 tool 定义是开销大头，单次约 $0.24；加上后降到约 $0.003（约 80 倍）。26 个候选全量探测总成本 < $0.1。

配套判读：
- 返回 404 → 该 id 不可用；
- 返回 503 → 上游瞬时故障，**不是**拒绝，不能据此判定 id 无效（本次 `claude-sonnet-4-6[1m]` 连续 5 次 503，最终按「无法证实」处理而非「无效」）；
- 返回的模型与请求的不同 → 见条目 4 的 legacy remap（未收进本文件，但探针能发现它）。

### 建议归宿：terminal-agent 集成层的共享 runbook

不是设计准则，是**可执行配方**。它的通用形式是「如何对一个外部 agent CLI 做低成本能力探测并回读真实结果」，接入新 harness（kimi / droid / kiro / opencode）时同样适用。

建议落在重构后的 `docs/runbooks/`（或等价的操作手册区）下一篇「外部 agent CLI 能力探测」文档里，而不是 `AGENTS.md`。`terminal-agent-model-selection.ts` 里保留一行指针即可。

---

## 条目 6 —— 1M 上下文变体，与特殊字符经 PTY/argv 的安全性

这条**必须拆成抽象层面完全不同的两块**，不要当作一条搬运。

### 6a. 哪些模型有 1M 变体 —— 易变的上游事实，不该进任何长期文档

实测结论（2026-07-25，CLI 2.1.219）：`opus[1m]` / `sonnet[1m]` / `fable[1m]` 以及 `<完整模型名>[1m]` 均有效并返回 `contextWindow: 1000000`；Haiku 没有 1M 变体（CLI 内部有 `supports_1m_suffix` 门控）。

**归宿：不搬运。** 这类事实会随上游变化，写进文档就是下一个「Opus 4.8」。它应当只以策展表旁注释的形式存在（已在 `terminal-agent-model-selection.ts`），需要时用条目 3 的探针复验。

### 6b. 特殊字符经 PTY/argv 链路是否安全 —— 稳定的架构事实，值得文档化

`opus[1m]` 里的方括号不会被吞或被 glob 展开。**注意这是两条平台链路各自成立，而不是「全平台都不经 shell」**——把它概括成单一不变量会写出错误的架构文档：

- **darwin / linux：不经 shell。** `src/terminal/pty-session.ts` 的 `PtySession.spawn` 走 `pty.spawn(binary, argvArray, options)` 直接 exec，没有 shell 参与，特殊字符天然安全。
- **Windows：仅部分启动经 shell，经 shell 的那部分靠转义保证安全。** 判定在 `shouldUseWindowsCmdLaunch`（`src/core/windows-cmd-launch.ts:135-171`）：binary 本身是 `cmd`/`cmd.exe`/ComSpec，或后缀为 `.exe`/`.com`（显式写出、或经 PATHEXT 解析所得）时**返回 false，仍是直接 argv exec**；只有 `.cmd`/`.bat` shim 与「后缀完全无法解析」的兜底才返回 true。（claude 在 Windows 上是 npm `.cmd` shim，故落在经 shell 的那一支。）
  为真时 spawn 的二进制被换成 `resolveWindowsComSpec()`（即 `cmd.exe`），参数由 `buildWindowsCmdArgsCommandLine` 拼成 `/d /s /c "<command>"`；其中每个参数经 `escapeWindowsArgument` 做 cross-spawn 式转义（先整体加引号，再对 cmd 元字符逐个加 `^`），`[` `]` 在其元字符表 `/([()\][%!^"`<>&|;, *?])/g` 内且被正确处理——`opus[1m]` 转义后为 `^"opus^[1m^]^"`，引号本身也被 `^` 转义故 cmd 全程不进入引号态，`/S` 剥掉最外层引号后 `CommandLineToArgvW` 解析出的仍是 `opus[1m]`。
- 契约侧 `runtimeTaskTerminalAgentModelOverrideSettingsSchema` 对 claude 只要求非空串，不限制字符集。

**归宿：terminal / PTY 子系统的架构说明。** 这是「agent 启动参数如何抵达进程」这一层的稳定事实，回答的是一类反复出现的问题（任何含特殊字符的参数是否安全）。适合放在重构后 `docs/architecture/` 下的终端子系统一节，或 `src/terminal/` 的模块级 README。**不属于 `AGENTS.md`。**

---

## 条目 7 —— web-ui 测试跨文件 localStorage 污染

> 四条里最有普适价值的一条，而且**最佳归宿是机制化、让文档变得不必要**。

### 事实

`web-ui` 的 vitest 用例之间会**跨测试文件**共享 localStorage 内容：写 localStorage 的测试文件若不清理，会让**另一个文件里看似完全无关的用例**失败。

本次实证：
- 基线（改动前）全量 969/970，唯一失败是 `src/utils/react-use.test.tsx > does not eat a functional toggle after a transient localStorage write failure`；
- 该失败**曾被误判为「与本次改动无关的既有失败」**（我当时就是这么报告的）；
- RVF 修复在 `task-agent-model-picker.test.tsx` 的 `afterEach` 补了 `localStorage.clear()` 后，全量变成 972/972；
- 对照实验：同样只跑 `react-use.test.tsx` + `task-agent-model-picker.test.tsx` 两个文件，补 `clear()` 前是 1 failed / 34 passed，补后 37/37。

### 疑似机制（**需实证确认后再据此改动**）

`web-ui/vitest.setup.ts` 用守卫安装 Map 后端的 localStorage mock：

```ts
if (!hasWorkingLocalStorage()) { /* 安装一个 Map 后端的 Storage */ }
```

同一 worker 内跑第二个测试文件时，setup 再次执行，但此时 `globalThis.localStorage` 已是上一个文件装好的、功能完好的 mock，守卫返回 `true` → **不重装 → 沿用同一个 Map 实例**，于是前一个文件写入的键漏给了后一个文件。

这与观察到的现象自洽，但我**没有做单变量实验直接证实这条路径**（只证实了「补 `clear()` 后问题消失」）。动手前先确认，别把推断当结论。

### 建议归宿：机制化 > 文档化

优先做法是在 `web-ui/vitest.setup.ts` 加一条全局清理，一次性根除整类问题，**不需要任何人记住任何约定**：

```ts
// 顶层 import 不可省：web-ui/vitest.config.ts 没开 globals（vitest 默认 globals=false），
// 且 vitest.setup.ts 目前没有任何 import——直接写裸 afterEach 会在加载 setup 时抛未定义。
import { afterEach } from "vitest";

afterEach(() => {
  globalThis.localStorage?.clear();
});
```

（放 `beforeEach` 亦可，同样需要顶层 import；重点是不依赖各测试文件自觉。）

只有在决定不机制化时，才需要一条文档约定，那时它属于「web-ui 测试约定」层，而非项目级 `AGENTS.md`。

**顺带值得记住的教训（这条更抽象，可考虑并入通用准则）**：全量套件里一条看似无关的失败，在断言它「与本次改动无关」之前，先确认它**不是被本次改动所在文件的副作用触发的**。基线复跑能证明「改动前就失败」，但证明不了「与改动文件无因果关系」——本次两者恰好都成立于表面，实际却存在因果。
