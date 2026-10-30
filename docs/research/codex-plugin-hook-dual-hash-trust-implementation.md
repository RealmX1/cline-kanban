# Codex 插件 hook 双哈希修复与依赖边界

用户于 2026-10-29 明确要求实施上一阶段的修复计划。初始基线为 `17c5cf5d3065c64cd55774ca813d12695aeb812d`。用户于 2026-10-30 接受两位已完成 reviewer，并授权提交及 `base-branch-sync`；按该授权先吸收本地 main 的 `46088e3f10f69cf0bea9b851646d226a38b16745`，再整合 profile 修复。部署另需授权。

## 实现合同

保存用户实际确认的定义哈希和内容哈希，并在继承时核验完整原生指纹。定义或真实脚本改变后仍须重新确认；禁用和撤销保持有效。旧记录缺少内容确认时保持未知，不从当前文件补造确认，也不通过删除 `trusted_content_hash` 或绕过原生信任修复问题。

本基线已有共享字段的完整状态存储，缺陷在活会话同步门禁：原逻辑把原生 `定义哈希/内容哈希` 与单个 `trusted_hash` 比较，错误拒绝完整匹配，也可能在原生只返回定义时忽略待继承的内容约束。现在按原始状态构造完整指纹后精确比较；仅内容确认变化有独立的中文提示。

原所有者、来源身份、定义摘要、配置版本、显式同步和现有原生版本重载门禁继续生效。此修复不扩大即时重载的已验证版本或插件生命周期范围。

评审补充修复：目标现有状态与待同步状态仅 `enabled` 不同时，允许在内容指纹已变化的情况下禁用，保持目标两个信任字段原样。后续配置版本绑定和完整状态冲突检查继续核验；若同时改变信任字段，仍必须匹配原生完整指纹。回归覆盖失败复现、混合信任修改被拒绝，以及目标 writer 重启后仍保持禁用。

吸收后回归同时发现：共享字段删除后，未变化的旧 writer 在补扫信任时会把自身的旧禁用状态重新写回 profile。补扫现在从目标 profile 已有状态构造候选；字段缺失时只复用账本中的信任，避免借旧副本复活启停字段。五类 hook 来源的删除回归覆盖该问题。纯禁用期间出现目标新决定时，新 profile 版本接管，旧操作显示冲突且没有写入。

## 已整合的 profile 实现

初始基线不含计划引用的 `codex-configuration-profiles.ts`，因此第一阶段交付独立补丁，没有修改任务 `12fbc`。该模块随后随本地 main 的 profile 功能进入当前工作树，本任务已将修订版实际应用到以下模块：

- `codex-configuration-profiles.ts`：双哈希一起比较和复用，仅内容重新确认也登记；撤销移除两项信任，目标自身禁用状态保留。
- `codex-configuration-sync-store.ts`：新增可选 `trustedContentHash: string | null`，兼容旧记录；缺失表示未知，不迁移为当前内容哈希。旧正向记录不会覆盖目标已有决定，旧撤销仍有效。
- `codex-configuration-sync-service.ts`：与本基线相同的完整原生指纹门禁。

持久交付目录：`/Users/bominzhang/.cline/kanban/cross-task-handoff-artifacts/cline-kanban/60208/hook-dual-hash-implementation/`。原始快照、修改后快照、补丁、独立验证包和复验入口保留作历史证据。当前源码为正式交付，不需要再向其他任务应用独立补丁。

14 项独立回归使用实际 profile 函数和存储 schema，覆盖跨 profile、未来 profile、仅内容确认、独立进程重启、旧记录、不混合新旧确认、来源与定义身份、幂等、禁用和撤销。原始代码有 9 项失败，补丁后 14 项全部通过。

补充自审和独立评审又确认了“新观测到的旧格式正向决定清除目标内容约束”的缺口。修订版位于上述目录的 `content-bound-preservation-repair/`：插件缺内容事实时不复用正向信任，已有内容约束也不会被缺内容的决定降级；普通文件 hook 的已知无内容确认仍可共享，完整撤销继续清除两个哈希。原有 14 项及新增 4 项共 18 项回归已移入仓库，直接调用实际 profile 函数和持久存储 schema；吸收后的未修复源码有 13 项失败，用于核验实际集成修复。原始补丁和评审冻结证据保留作历史。

## Codex 原生限制

本任务重新用隔离的 Codex CLI `0.165.0` 验证，未启动模型回合或执行 hooks：

| 操作 | 原生信任状态 |
| --- | --- |
| 保存真实定义与内容确认 | `trusted` |
| 仅修改插件 `.git/logs/HEAD` | `modified` |
| 还原该元数据文件 | `trusted` |
| 修改真实脚本 | `modified` |

因此，Kanban 双哈希修复不能单独保证仅 Git 元数据变化时仍保持信任。排除 `.git` 的内容指纹修复属于 Codex 源码，本仓库不持有该实现，本任务未修改原生二进制或用户插件缓存。原生证据和有界、隔离的复验脚本位于上述持久目录。换用修复后的原生版本时，可重新运行该脚本核验元数据变化保持信任，同时脚本变化仍为 `modified`。

[官方 hooks 文档](https://learn.chatgpt.com/docs/hooks) 规定非托管 hook 必须确认当前定义，新建或变化的 hook 重新审查。本任务保持该门禁，不使用 `--dangerously-bypass-hook-trust`。

## 验证入口

```sh
npm run test:guarded -- --project precommit-safe \
  test/runtime/terminal/codex-hook-trust-sharing-content-boundaries.test.ts \
  test/runtime/terminal/codex-configuration-profiles.test.ts \
  test/runtime/terminal/codex-configuration-writer-binding-and-sync.test.ts \
  test/runtime/terminal/codex-hook-decision-source-observation-and-recovery.test.ts \
  test/runtime/terminal/codex-configuration-approval-and-source-observations.test.ts

KANBAN_CODEX_NATIVE_CONFIGURATION_SYNC_SMOKE_BINARY=/absolute/path/to/codex \
  npm run test:guarded -- --project runtime-integration \
  test/integration/codex-plugin-hook-dual-hash-trust.integration.test.ts

npm run typecheck
npm run web:typecheck
```

原生集成用例完整隔离 HOME、CODEX_HOME 和 SQLite；通过真实 `hooks/list` 验证跨 profile、新会话、同步服务重启、仅内容重新确认、脚本变更、禁用和撤销，并核验其他 profile 的启停保持独立。该用例不将 `hooks/list` 冒充既有线程已加载新配置的证据。

## 独立评审状态

固定候选 `4431d510be89de92d7ce72573799f82de03815f1` 的 RVF 位于任务持久目录的 `rvf-hook-trust-review-run/`。三席中两席完成，一席经历认证失败、替代评审未收束后耗尽原角色时限；整体保持 `review_incomplete`，不能称为 RVF 通过。缺失席要求的真实 Codex `0.165.0` 用例已在其原候选工作树补跑通过，并以通用机器证据接续原 run；未重跑已完成席或重置预算。

原报告与失败原件保留。主 Agent 修复了已确认的内容约束降级和纯禁用缺陷，并补充禁用期间目标信任变化的版本绑定回归；这些后续修复按实际测试报告交付，不冒充原 RVF 已对最终树完成三席验收。用户于 2026-10-30 明确接受两位已完成 reviewer，作为本次提交和同步的评审处置；原 run 的 `review_incomplete` 历史保持不变。

两位已完成 reviewer 均在首次尝试完成，没有前置失败或 backup：reviewer-1 为 Cursor，原生记录模型为 `Grok 4.7 256K High`；reviewer-3 为外部 Codex CLI，原始记录未提供实际模型。缺失的 reviewer-2 席位依次尝试 Claude（`claude-opus-5-5`，OAuth 失效）、Cursor（`Grok 4.7 256K High`，返回 incomplete）、Claude（同一认证问题）、Kimi（命令指定 `kimi-code/k3.1-pro`，角色总期限耗尽）。Kimi 的原生命令启动时只剩约 16 秒；不将这个结果归因为代码评审失败。
