# 项目标识与任务表单实现合同

- 能力：任务表单首先显示 Project；项目图标、颜色和上传图片在所有项目入口保持一致，并跨浏览器同步、跨运行时重启持久化。
- 范围：已批准的 36 个 Lucide 图标、12 色、28 项默认映射、项目操作菜单编辑入口、三个 projects procedure、workspace 状态存储、sharp 打包支持。
- 边界：不改变任务创建归属逻辑、输入焦点、批量能力、卡片行数或运行状态语义；不部署、提交或推送。
- 验收：默认与自定义、取消与恢复、上传类型和资源限制、保存失败、删除清理、跨浏览器广播、375px、键盘和主题对比度。
- 主要表面：`src/core/api-contract.ts`、`src/trpc/{app-router,projects-api}.ts`、`src/server/workspace-registry.ts`、新增存储与模型、`web-ui/src/App.tsx`、任务表单与各项目展示入口、根和桌面依赖与构建配置。
- 风险：图片解码与原生打包；状态写入和永久删除并发；项目色和选中/运行状态混淆；异步读取失败。
- 验证：根与 Web UI typecheck、guarded 定向测试、Web UI 单测、隔离运行时 Playwright、构建、Electron 图片处理冒烟；最后注册 PDV。

## 实施切片

1. 默认标识与持久化：先验证映射、覆盖、上传拒绝与原子失败，再接摘要和鉴权 procedure。
2. 表单与编辑交互：先验证表单顺序、只读/可选归属、取消和保存，再统一所有渲染入口。
3. 集成与打包：验证广播、重启、各主题/窄屏、桌面 sharp，注册部署后验证。

## 开工核对

- 来源：用户本会话完整 PLAN-READY 方案；philosophy-of-ai-systems/a34f0。
- local base：`2b09cd24a588c66fa374edcc6ca7b2bc11ab2ffc`；单向同步完成，bootstrap receipt 已验证，无 base 差异，无 task WIP。
- sibling 快照：345 项，KANBAN_CLI，无降级。活跃文件重叠：48069 的 `web-ui/src/App.tsx`；73a2e 的 `App.tsx` / `src/core/api-contract.ts`。用户已明确回复“允许”，授权独立 worktree 按功能区域继续。
- 软重叠：00a54（backlog）顶栏项目切换；0a244 / 11ce6（backlog）跨项目搜索范围。沿用既有入口，不修改这些任务的目标行为。
- 未修改、未合并任何 sibling worktree；未推送、未反向回灌 base。

LOCAL_BASE_DELTA_INSPECTED=VERIFIED
LOCAL_BASE_ABSORPTION=COMPLETED
SIBLING_TASK_SURVEY=VERIFIED
NO_SIBLING_WORKTREE_MUTATION=VERIFIED
NO_SIBLING_WORK_MERGED=VERIFIED
PLAN_REVISION=NOT_REQUIRED
POST_ABSORPTION_PLAN_FRESHNESS=VERIFIED
ONE_WAY=VERIFIED
BASE_UNCHANGED_BY_TASK=VERIFIED
NO_HANDBACK=VERIFIED
NO_PUSH=VERIFIED
BOOTSTRAP_SEQUENCE=VERIFIED_SYNC_BEFORE_TARGET_REPOSITORY_VALIDATION
BOOTSTRAP_RECEIPT=VERIFIED

## 完成与验证

- 能力与范围：已实施；没有提交、推送、回灌 base 或部署。
- 根 guarded 定向测试 86 项、注册表集成 1 项、真实打包态双浏览器集成 1 项、Web UI 回归 84 项全部通过。
- 根 / Web UI / Desktop 类型检查、Biome、git diff --check、独立打包构建通过；Electron 41.5.0 实测 sharp 生成并读回 128×128 PNG。
- 浏览器证据涵盖只读/可选归属、批量创建、图标中英文搜索、导航折叠、搜索结果、图片上传替换与失败回退、真实进程重启、永久删除资产、375px 手机弹窗与 11 个主题；项目颜色最低实测对比度约 3.35:1。
- 手机检查修复了侧栏收起导致编辑器卸载及菜单点击冒泡触发项目导航；没有修改通用 Dialog primitive。
- PDV 已注册并以原 ID reconcile，保持 1 项 automated_script + 1 项 guided_manual。旧实例只读 dry-run 正常退出并报告旧摘要缺少标识，没有超时或残留；未标记部署后通过。
- 完整报告与清理命令：`/Users/bominzhang/.cline/kanban/cross-task-handoff-artifacts/task-7e625-project-visual-identity/implementation-and-verification-report.md`。
- RVF 预审已从初始固定 base 单向吸收 local main `5cf5606c9a1f3b5c633a6721a30e3a269b68893e`，全部 WIP 无冲突恢复；未反向回灌或推送。


## RVF 修复

- 严格档正式覆盖原始 38/38 个候选路径，双外部审查成立；两条 medium 问题均采纳，无范围外问题。
- 默认映射改为只读取自有键；`constructor`、`CONSTRUCTOR`、`__proto__` 先红后绿，继续使用 workspace ID 稳定默认值。
- 项目操作按钮隔离键盘冒泡，保留菜单默认行为；单测覆盖 Enter / Space / ArrowDown 打开及正常项目行选择，打包浏览器加入 All projects 范围不变断言。
- 两个独立 validate/fix attempt 均以 fixed 收尾，无冲突合回；新增 `project-navigation-panel.test.tsx` 的测试改动已声明最小范围扩展。
- 本轮主 worktree 最终验证证据由 RVF 的 `handoff-validation-001` 起记录；权威结果位于本轮 handoff 与结构化验证记录。
- run：`/Users/bominzhang/.rvf/user-local-data/run-logs/runs/rvf-20261018T232132Z-agentic-initiation-start-fa093a38`。
