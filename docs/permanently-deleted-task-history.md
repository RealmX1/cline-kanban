# 永久删除 Task 的只读历史

## 实现合同

- 计划状态：PLAN-READY，用户已批准实现；实现已完成，尚未部署。
- 能力：按项目、关键词或 Task ID 查找已永久删除的 Task，查看和复制完整 Prompt。
- 入口：两种 Focus View 左侧栏底部；项目看板右上角；手机 Focus View 展开的顶部工具区。
- 弹窗直接复用 Expanded Task Cards；范围跟随当前视图，允许切换项目；默认删除时间倒序，每页 20 条。
- 默认显示删除前 Prompt，可切换创建时 Prompt。保留原文空白和换行；缺失历史不得冒充找回成功。
- 复用关系账本及字段正文，不新增持久留档；永久删除历史与 Done 卡片、提示库条目分别处理。
- 不恢复任务、不启动会话、不创建 worktree；历史卡片不执行编辑、移列、置顶、运行时元数据轮询。
- 风险：公共契约与其他任务软重叠；共享卡体必须明确关闭活卡副作用；身份必须包含 workspace 和 incarnation。
- 验收：跨项目归属、删除后可查、两版本、长正文逐字复制、缺失历史、错误态及查询无状态变更。
- 验证：guarded 根测试、根/Web 类型检查、Biome、构建、隔离 HOME/账本的真实 runtime 与浏览器测试。

## 切片

1. 历史读取闭环：账本投影 → 只读查询 → 版本与缺失状态测试。
2. 阅读闭环：历史查询弹窗 → Expanded Task Cards → 完整 Prompt 查看和复制，测试只读隔离。
3. 宿主闭环：全部约定入口、项目范围、手机、分页及隔离浏览器验收。

## 规划基线

本地 main 与 task 起点均为 `2b09cd24`。初次 sibling 调查覆盖 343 个任务，开工前刷新到 345 个：`e2dfc`、`9674c` 有公共区域软重叠，`73a2e` 的卡片编辑与复制、`48069` 的焦点导航在公共文件上有活跃改动。用户已明确允许独立 worktree 继续实现；未修改或合并 sibling worktree。

开工已完成受控 one-way bootstrap。收尾时本地 main 新增 `3f022529`（Cache warm 移入验证后的同组焦点接续），再次单向吸收并完整恢复本任务 WIP。双方仅在 `App.tsx` 交集：焦点导航 hook 与本次历史弹窗状态、入口独立；保留两侧接线，无需语义适配。没有 handback、push 或本任务提交。

## 使用与展示语义

1. 项目看板右上角点击废纸篓，或在 Task Focus View 左栏底部点击“已删除 Task”。手机在展开的顶部工具区使用废纸篓。
2. 项目视图默认查当前项目，All projects 默认查全部项目；弹窗内可切换范围。永久删除历史独立于普通搜索，Done / Trash 仍是看板中的卡片。
3. 搜索 Task ID（完整或至少三字符片段）、标题或 Prompt 关键词。每个 token 可匹配 ID、删除前标题或两版 Prompt，多个 token 按 AND 组合，例如 `3c487 需求`、`3c4 需求`；完整 ID token 命中的任务优先，其余按删除时间倒序。
4. Expanded Task Cards 展示项目、ID、删除前标题、删除时间及正文预览。点击卡片、键盘激活标题或点击阅读按钮，查看完整 Prompt。
5. 默认选择“删除前 Prompt”，用户可切换“创建时 Prompt”。相同、不同、无法比较分别说明；不会把创建时内容悄悄替代缺失的删除前内容。复制保持完整原文，包括前后空白与换行。
6. 缺失版本分为“未记录”与“正文缺失或损坏”，不可用版本禁用复制；账本不可用显示错误及重试，不伪装成无结果。

## 复用路径与只读边界

- 关系账本事件仍是唯一历史来源，沿用 caught-up projection reader 和按 SHA256 读取的正文缓存；不新增留档或持久搜索索引。
- identity projection 分别保留创建与删除时的字段哈希；投影版本升至 3，以便已有事件重投影。删除快照与当前字段状态使用独立对象。
- `workUnit.listPermanentlyDeletedTaskCards` 返回每页 20 条及游标；`workUnit.getPermanentlyDeletedTaskPromptVersions` 只接受含 workspace、Task ID 和 incarnation 的完整身份。
- 列表先按身份排序和定位游标。空查询只读取当前页的标题与删除前预览；关键词按每批最多 32 个身份在账本 worker 内匹配，只回传 token 命中信息，找到下一页边界即停止。仅最终一页正文进入主线程缓存，全文阅读仍按身份读取完整版本。
- 每个 token 在 ID 与正文关键词命中间取并集，再将多个 token 按 AND 组合；为判断后续结果，稀疏命中可能扫描其余范围，但未展示正文不在主线程解析或常驻缓存。Unicode 大小写、空白分词和跨字段 AND 均沿用原规则；不新增持久搜索索引。
- 历史卡片复用 `TaskCardBody` 的只读 presentation；不进入 board，不传任务变更命令，不订阅活卡的 worktree、资源或待发送输入状态。全文阅读复用 `TaskOriginalPromptDialog`。
- 只查已有永久删除事件。没有留存事件、字段哈希或正文的历史不能保证找回；不推断旧会话内容，也不尝试任务或 worktree 恢复。

## 自动化验收

- 根测试：跨项目同 ID、不同 incarnation、活卡排除、两版关键词、完整长文本、空 Prompt、缺失正文、未记录版本、分页、项目取消注册及删除快照不受晚到字段事件影响。
- Web 测试：复用 Expanded Task Cards、活卡动作缺席、默认删除前版本、切换并逐字复制、复制失败不报成功、缺失版本禁用复制与可重试错误态。
- 真实浏览器：隔离 HOME、账本、两个 Git 项目和空闲端口，经真实 runtime 创建、编辑、永久删除后查找；验证两个版本的实际剪贴板、各宿主入口、手机布局，以及查询前后 board、sessions、账本事件数不变。测试不接生产 3484。

```bash
npm run test:guarded -- --project precommit-safe test/runtime/trpc/permanently-deleted-task-history.test.ts
npm --prefix web-ui run test -- src/components/permanently-deleted-task-history-dialog.test.tsx
KANBAN_RUN_ISOLATED_DELETED_TASK_HISTORY_BROWSER_CHECK=1 npm run test:guarded -- --project runtime-integration test/integration/permanently-deleted-task-history-real-browser.integration.test.ts
npm run typecheck
npm run web:typecheck
npm run build
```

浏览器测试需要 web-ui 的 Playwright Chromium；可设置 `KANBAN_DELETED_TASK_HISTORY_BROWSER_EVIDENCE_DIRECTORY` 将截图和结果存入持久交接目录。原生 SQLite 测试需使用与本机 `better-sqlite3` 编译 ABI 一致的 Node。

部署后自动验证已登记：`e4372f6a-d2e9-42be-8fb4-a9dce2196a2d`。验证以 GET 查询真实 RVF 案例 `3c487`、`ae8e2`，校验两版 Prompt 的既有哈希，并检查部署 bundle 的入口标记。部署后尚待运行；本次没有标记通过。
