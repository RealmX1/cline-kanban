# 浏览器下载任务文件与主会话 Plan

实施合同：支持桌面任务工作台浏览任务工作目录（含隐藏、未跟踪和未修改文件），下载当前磁盘上的单个原文件；从 task 当前绑定主会话的可信历史查找最近完整 Plan，优先关联原文件，正文可导出 Markdown，歧义时列出候选。

范围外：手机适配、目录打包、批量下载、历史 Git 版本、启动 Agent 或创建工作树。HTTP 下载复用 Host、Origin、远端登录门禁，任务身份必须包含 workspace、task、incarnation；普通文件拒绝路径穿越、目录外符号链接和特殊文件。

实现按三个可验证切片推进：目录与原文件安全下载、主会话 Plan 来源与导出、桌面模块和 Diff 下载入口。涉及 API schema、tRPC/runtime、历史投影、前端查询与工作台、自动化 fixture。测试先覆盖文件字节、安全边界和 Plan 版本，再验证隔离运行时中的浏览器实际下载。

主要风险是错误归属导致文件泄露，以及把部分历史误报为无计划。读取预算不足、来源暂不可读保留未知，提供重试；下载时再次核验任务与 Plan 来源，拒绝旧候选。

验证：guarded 定向后端测试、Web 组件测试、隔离 runtime/Playwright、根与 Web typecheck、Biome、隔离输出目录构建。收尾登记真实访问地址、登录态与浏览器下载兼容性的部署后观察项。

## 使用与来源边界

桌面详情右侧工作台的格位菜单可选择「任务文件」。目录按需读取，支持上级目录、面包屑和手动刷新；安全的目录内符号链接可以进入。普通文件下载与改动文件列表共用附件下载入口，不应用 Diff 的内容或大小限制。服务端发送原文件名；Chromium 的保存策略会移除隐藏文件名开头的点，文件正文保持原字节。

任务工具区的「下载主会话 Plan」独立于当前查看的会话。可信原生历史包含完整 `<proposed_plan>`、Claude `ExitPlanMode` 正文／回执或明确的计划文件引用时，按最近版本生成候选；多个文件只展示该版本的候选。正文与对应原文件不一致、缺失或不可读时，可导出已核实的 Markdown 正文。无计划与来源未知分别呈现，后者可重新读取。最多读取 32 页、8 MiB 历史正文；超预算保留未知，不猜选全局计划文件。

接口为 `runtime.listTaskDirectory`、`runtime.getTaskMainSessionPlan` 与 `/api/task-file-download`（GET/HEAD）。HTTP 位于 Host、Origin、远端登录门禁之后，按 workspace/task/incarnation 核验；Plan 下载重新核验当前主会话与候选，源文件限普通文件。下载前 HEAD 用于显示具体错误，正文由浏览器下载管理器流式接收。

## 部署后验证分析

| 行为 | 部署前证据 | 部署后待验 | 类型 |
| --- | --- | --- | --- |
| 原文件完整字节、中文名、空文件、二进制、大文件、目录导航 | guarded 单元测试与隔离 runtime / Playwright | 无额外纯逻辑项 | 不注册 |
| 登录、Host/Origin、路径越界、外链、权限、旧身份、跨项目同号、主会话切换 | 后端测试与隔离远端实例 | 无额外纯逻辑项 | 不注册 |
| 未读历史、候选选择、迟到响应、读取失败重试 | 历史／服务／组件测试 | 无额外纯逻辑项 | 不注册 |
| 部署后的真实访问地址、代理、真实原生会话来源与 Browser Cap 保存能力 | Chromium 隔离实例已验证下载 | 用户实际远端连接与 Browser Cap 的兼容性 | guided_manual |

定义：`docs/verification-definitions/task-files-and-main-session-plan-download.json`。仅注册，不执行、不勾选、不部署、不移列；无自动脚本，dry-run 不适用，无临时插桩。兜底清理：`kanban verification cleanup --verification-id 634ace95-a199-4678-ae8f-3580e0d40540`。

注册与只读自查均确认 workspace `cline-kanban`、task `081e9`，共 1 项 `guided_manual`；资产目录 `/Users/bominzhang/.cline/kanban/verifications/634ace95-a199-4678-ae8f-3580e0d40540`，清理模式 `automatic`。后续 deployment record 预计挂载自动项 0 项、引导观察项 1 项。

## 实施验证结果

- guarded：51 项后端测试通过，覆盖文件字节、安全目录内链接、特殊设备拒绝、权限、身份、Plan 版本、Claude 原生回执、历史不可读及分页预算。
- 隔离远端 runtime / Playwright：1 项通过。实际登录、Host/Origin 拦截、路径与旧身份拒绝、6 类原文件字节、目录进入／返回／刷新、改动文件列表与内嵌主会话 Plan 的浏览器保存均通过；不启动真实 Agent。
- Web UI：72 项相关组件回归通过，覆盖目录导航、迟到响应、Plan 单一来源直接下载、多候选选择、未知来源重试与现有任务详情。
- 根与 Web typecheck、改动源码和测试的 Biome、`git diff --check`、完整独立构建通过。构建前已隔离本任务的 `dist` 与 `web-ui/dist`，未更新主仓库共享产物。
- 当前共享原生依赖按 Node 24 ABI 编译，后端与运行时验证使用匹配的 Node 24.22.0；未重装、重编或修改共享依赖。根与 Web 类型检查亦在 Node 22.22.3 通过。

复现命令（需使用与原生依赖 ABI 匹配的 Node，并为 Playwright 指定现有浏览器缓存）：

```sh
KANBAN_RUN_TASK_FILE_DOWNLOAD_BROWSER_CHECK=1 npm run test:guarded -- --project precommit-safe --project runtime-integration test/runtime/task-file-downloads.test.ts test/runtime/task-file-download-service.test.ts test/runtime/agent-session-history/task-conversation-history-page.test.ts test/integration/task-file-downloads-real-browser.integration.test.ts
npm run web:test -- src/components/detail-panels/task-files-panel.test.tsx src/components/detail-panels/task-main-session-plan-download-button.test.tsx src/components/detail-panels/task-workbench.test.tsx src/components/card-detail-view.test.tsx
npm run typecheck
npm run web:typecheck
KANBAN_BUILD_DISTRIBUTION_OUTPUT_DIRECTORY="$PWD/dist" npm run build
```

源码保留在本任务工作树，未创建提交或部署。真实访问地址、代理和 Browser Cap 的兼容性由已登记的部署后观察项承接。
