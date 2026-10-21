# 任务历史提交累计增删行

任务目录行与任务顶栏在 dirty 计数旁常驻显示「已提交 +A −D」。主看板、Focus View 及跨项目任务行共用同一统计和明细组件。dirty 继续表示当前相对 HEAD 的未提交改动；历史累计只相加保留提交的增删行，不做最终净 diff 抵消。

## 归属与历史改写

提交身份沿用 `task-commit-integration-provenance`，统计是独立投影，不删除原 provenance 的历史观测。保留集合取当前任务 HEAD 可达的自有非 merge 提交，加上经现有 SHA／一对一 patch-id 匹配确认已经合回本地 base 的任务提交。amend、rebase、reset 丢弃的未落地版本不再累计。base 吸收引入的他人提交不属于任务；merge 提交整体排除。空提交保留为 +0 −0，二进制文件不折算文本行数，重命名沿用 Git 识别。

等价落地匹配优先选择当前 HEAD 仍可达的版本，避免 amend 前的同 patch-id 旧版本抢占匹配并重复累计；原有集成计数和 landing/deploy 判据保持不变。

缺少可靠归属或 Git 对象不可读时显示「已提交 —」。新任务确实没有提交时才显示 +0 −0。inplace 任务沿用现有归属未知语义。

## 缓存与传输

逐提交统计和保留历史保存在工作区既有的 `task-commit-integration-provenance.json`。旧文件的新增字段均可省略，首次探测补齐。每个 SHA 只需计算一次，最多 64 个一批读取 numstat；普通 dirty 编辑直接沿用提交元数据缓存。工作区重启或 task worktree 删除后仍读取已保存结果。

metadata 推流只携带 `taskRetainedCommittedLineChangeSummary`（状态、提交数、增删行、historyVersion）。悬浮、聚焦或点击时，经 `workspace.getTaskRetainedCommittedLineChangeHistory` 读取持久明细，不运行 Git。浏览器按 workspace、task 和历史版本复用有上限的明细缓存，浮层只在展开时挂载。明细与摘要版本不同时明确提示正在刷新。键盘进入浮层后，Escape 关闭并恢复触发按钮焦点；悬浮和外部点击保持外部焦点。

统计暂时失败时，当前摘要显示未知，持久明细保留最后一次完整结果，并提示其为最后保存的记录。worktree 已删除的任务同样按既有全量刷新间隔重试；成功后继续复用缓存，不因重试增加持续的 Git 读取。

## 自动化验证

隔离 Git 测试验证累计口径、改写、base 吸收与落地、worktree 删除以及特殊文件。确定性调用次数测试验证批量上限和 SHA 缓存命中。

真实浏览器复用已有隔离 runtime／Vite／Chromium 夹具，以 `KANBAN_RUN_ISOLATED_TASK_COMMITTED_LINE_CHANGE_BROWSER_CHECK=1` 启用 `cross-project-task-switcher-server-card-actions-real-browser.integration.test.ts` 中的专用分支。设置 `PLAYWRIGHT_BROWSERS_PATH` 和持久的 `KANBAN_ISOLATED_REAL_BROWSER_CHECK_EVIDENCE_OUTPUT_DIRECTORY` 后，经 `npm run test:guarded -- --project runtime-integration <测试文件>` 执行。该分支检查主板悬浮、dirty 独立变化、Focus 与顶栏、IPC 重启、跨项目点击以及手机触屏；所有实体和账本均在 fixture HOME 内。

构建后再设置 `KANBAN_RUN_ISOLATED_TASK_COMMITTED_LINE_CHANGE_BROWSER_CHECK_WITH_PACKAGED_RUNTIME=1`，同一检查会直接访问本任务 `dist/cli.js` 所服务的完整打包 runtime 与静态 Web UI。构建前应确认 `dist` 和 `web-ui/dist` 不再是指向在线实例产物的软链。
