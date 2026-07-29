# Agent 会话「结构化 GUI 渲染」调研（多 agent 共写）

## 这个目录是什么

收口一类问题的调研：**如何把一个 coding agent 的会话渲染成结构化 GUI，而不是让用户去读一块为「80×24 物理终端 + 物理键盘」设计的全屏 TUI。**

这类问题目前有两条已知取径，本目录同时收纳，避免将来重复设计：

| 取径 | 一句话 | 本仓状态 |
|---|---|---|
| **ACP**（Agent Client Protocol） | agent 以 JSON-RPC over stdio 直接吐结构化会话事件，Kanban 全权渲染 | 骨架已落地（`src/acp-client-session/`），唯一接入的 agent 是 omp |
| **head-only mode** | GUI 渲染对话主体 + 同屏保留裁剪后的原生 TUI「头」（输入行 / 补全浮层 / 审批 prompt） | 本仓**未实现**；设计出自姊妹项目 Orca |

两者不互斥：ACP 要求 agent 侧支持该协议，head-only 对任何 PTY agent 都适用但需要一条 per-agent 的结构化 body pipeline。

## 为什么单独立此目录

移动端适配（2026-07-29）暴露出三个症状——看不到 TUI 历史 context、没有 double-ESC / 方向键 / 中断的输入通道、看不到任务卡初始 prompt——**根因同一个**：触摸屏在操作一块为宽终端 + 物理键盘设计的 TUI。那一轮交付选择了「适配现有 PTY 终端」的战术路线（transcript 阅读视图 + 虚拟按键条 + prompt 入口），而把「结构化 GUI 渲染」的调研成果留存在此，供后续启动时直接复用，不必重跑调查。

## 目录内容

- [`orca-head-only-mode-cross-reference.md`](./orca-head-only-mode-cross-reference.md) — Orca 的 head-only 设计、它在 Kanban 落地缺什么前提、本仓已经吸收了哪一条
- [`claude-code-acp-adapter-feasibility.md`](./claude-code-acp-adapter-feasibility.md) — 把 Claude Code 经 `@zed-industries/claude-code-acp` 接成第二个 ACP agent 的可行性、编译强制点、现成的协议冒烟验证手段
- [`acp-layer-known-gaps-blocking-gui-parity.md`](./acp-layer-known-gaps-blocking-gui-parity.md) — 现有 ACP 层阻塞「GUI 体验与终端路径对等」的既存缺口清单（含一个现存渲染 bug）

## 往这里追加观察的约定

本目录预期由多个 agent 先后写入，请遵守：

1. **一个观察一个文件。** 不要往既有文件尾部追加不相干的段落——那会让文件变成流水账，且多 agent 并发写时必然冲突。
2. **文件名自解释。** 读文件名就该知道「讲的是什么 + 处于什么状态」。参照既有三个文件的命名密度；避免 `notes.md`、`findings-2.md` 这类要靠上下文才懂的名字。
3. **写完在本 README 的「目录内容」加一行指针**（一行，带一句话钩子）。README 只做索引，不承载内容。
4. **区分「实测」与「推断」。** 凡是跑过命令 / 读过源码得出的结论，写清依据（命令、文件路径:行号）；凡是推理而未验证的，显式标注为未验证。本目录的价值全在于后来者可以信任它而不必重查。
5. **修正而非叠加。** 发现既有文件的结论已过时或有误，直接改那个文件并注明修正原因，不要新开一个文件说「上面那篇错了」。
