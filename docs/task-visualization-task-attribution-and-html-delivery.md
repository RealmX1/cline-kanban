# HTML 可视化任务署名与公共交付合同

## 已批准的实现范围

本合同对应 Kanban `cline-kanban/491af`。用户要求可视化自动署上任务 ID、任务名，并确认覆盖 hosted 查看器与本地 HTML；ELI5 渠道修复纳入配套任务，同时尽可能少地增加 ELI5 自身约束。用户随后明确要求实施已交付计划。本合同状态为 PLAN-READY。

- Kanban 从 workspaceId + taskId 查询任务名，提供共用幂等 HTML 署名器、`task visualization apply-task-attribution-to-html`，publish 自动使用同一署名器。
- 独立标签页、面板与全屏在 iframe 外显示可信任务署名；本地 HTML 保存最后一次生成或发布时的名称。
- 契约增加可选 taskTitleAtPublication 快照；list、preparePreview 返回 taskAttribution，旧托管产物通过当前任务记录兼容，不改写历史修订摘要。
- my-ai-setup 配套任务复用并独立审查 7cae2 的四个未落地 skill 文件，接入生成、追加、更新页面的自动署名与发布。
- ELI5 仅增加“图解生成与交付复用 visualization-platform”的简短委派。权限受限、工具不可用时，公共平台提供可读文字并说明 HTML 待交付，不以复杂终端 Mermaid 代替成品。
- 不提交、不推送、不部署；不批量改写历史本地文件，不修改插件缓存，不扩大为新的渲染器或托管系统。

## 两仓接口

`kanban task visualization apply-task-attribution-to-html --task-id <id> --project-path <main repository> --source-html-file <absolute HTML>` 只负责本地署名，不发布空白页面。范围参数也可取 KANBAN_TASK_ID / KANBAN_PROJECT_PATH。成功回执含 ok、sourceHtmlFilePath、taskAttribution、didUpdateHtml；任务名由已注册 workspace 的任务记录解析，不接受 Agent 手写名称。

`taskAttribution` 包含 workspaceId、taskId、taskTitle；无法确认任务名称时使用真实未知态，不把可视化标题当成任务名。发布维持 task-visualization-artifacts/v1 的已发布、等待接受、明确拒绝语义；暂时故障沿用持久包恢复，不覆盖拒绝历史。

同一内容、同一署名重复处理不得增加署名区或改变内容摘要；生成端须保留末行 HTML 绝对路径协议。单独终端无 Kanban 身份时保持原有 file:// 行为，不捏造任务 ID。

HTML 内的署名使用固定浮层，不占用原页面 grid/flex 排版位置，指针穿透以保留原页面交互。
单文件 50MiB 限额包含署名的 UTF-8 字节；本地写入前检查完整输出，超限则明确拒绝并逐字保留原文件。
因此接近限额的原文件可能需要先缩减内容。重复署名和改名使用同一限额，发布打包与运行时补署名也遵循该边界。

## 调查依据

- cline-kanban/7cae2：hosted 运行时已在本地 main；my-ai-setup 四个文件尚未落地，不能当成已安装能力。
- my-ai-setup/f3dcf：已调查 Codex TUI Mermaid 限制，未修改 skill。
- review-validate-fix/d7c77：2026-10-24 的 ELI5 调用实际生成并验证交互 HTML。
- review-validate-fix/f0b4d：同日 ELI5 已成功加载，Agent 因 Plan Mode 转向复杂内联 Mermaid；用户指出后，Agent 认定违反 HTML 要求，未创建新的 skill 修复任务。

## 验收

分别验证普通 HTML 与平台页面、本地离线和 hosted 三个宿主；覆盖跨 workspace 同号、改名、旧数据、特殊字符、长名称、重复发布、离线恢复与资源加载。根测试通过 guarded 入口，Web UI 单独执行测试与类型检查，真实浏览器使用隔离 HOME。构建先隔离 dist 与 web-ui/dist。实现收尾分析并登记部署后验证，源码成果留在各自任务工作树。
