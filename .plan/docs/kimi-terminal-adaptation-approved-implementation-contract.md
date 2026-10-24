# Kimi 现有终端适配实现合同

状态：PLAN-READY；来源：本任务会话中的最终 proposed_plan，用户随后明确要求「Implement the plan.」。

## 实现范围

- 修复 Kimi Bypass 参数与显式原生权限参数冲突，保留 Plan、模型和恢复的独立语义。
- 对 Kanban 任务工作树使用原生进程级信任；其他目录等待信任模态真正关闭，再唯一投递首条正文；启动与接管共用判据。
- 归一化 Kimi 原生工具调用身份，补齐前台提问、计划审批、工具授权、答复、拒答和中断后的主会话状态；后台提问与子代理不得抢占主会话。
- 复用现有 hook、facet、投递与原生接受机制；不新增 Kimi 面板作答入口。

## 非目标

- 不移植 c269f 已被主线覆盖的旧模型选择实现。
- 插件一致性不作为硬性目标，本次暂缓共享、复制与迁移机制。
- 不增加历史导入、fork 或 ACP；不提交、推送、部署。

## 验收与实施切片

1. 权限：先复现显式 `--auto` 被追加 `--yolo`；修复权限档和别名处理，验证 Plan 与恢复回归。
2. 首发：先复现信任模态吞掉正文；验证分块输出、超时仍等待、确认后唯一投递、接管与进程级信任。
3. 状态：用 Kimi 2.3.1 原生 hook fixture 验证主会话交互映射、工具身份、后台隔离与中断收口。

相关测试经 guarded runner 执行；补根/Web 类型检查与 Biome。真实 Kimi 探针只连接本地模拟模型，使用隔离 HOME 和持久证据目录。需要验证构建时隔离 dist/web-ui/dist，并显式设置构建输出目录。

## 已取得的规划证据

持久目录：`/Users/bominzhang/.cline/kanban/cross-task-handoff-artifacts/cline-kanban/d7b74/`。

- `current-kimi-adaptation-baseline/result.json`：原生接受、程序化回执、重绘和运行时接管通过。
- `native-current-question-interrupt-check/result.json`：实际 `tool_call_id`、前台提问与 `Interrupt` 载荷。
- `native-current-startup-prompt-check/`：延迟批准信任时首发丢失的原生输出与 summary。
- `native-current-startup-prompt-immediate-trust-control-corrected/result.json`：立即批准的对照通过。
- `native-current-startup-prompt-process-trust-control/process-trust-native-verification.json`：原生进程级信任对照通过。

参考任务已登记：c269f、5b68b、199e6、30555；共享文件重叠任务 edbc8 已登记。兄弟工作树仅作为只读上下文，不作为合并来源。

## 实施记录

实现与部署前验证已完成；原始批准范围保持 PLAN-READY。本地基线已单向吸收到 `3cee89be196520d4dd7859da55a35bb0b7fa71bc`，没有 handback、提交或推送。完整记录及源码快照位于持久目录的 `implementation-and-verification-report.md`、`implementation-source-manifest.json` 和 `implementation-source-snapshot/`。部署后观察项已登记但未标记通过。
