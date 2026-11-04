# 原生会话转录文档阅读

实现合同：按明确项目、宿主任务和所选会话读取持久转录，复用现有 Claude、Codex、OMP、Cursor、Kimi 适配器，覆盖主会话和侧会话。Agent 阅读入口使用 `TaskConversationTranscriptDocumentReaderPanel`；普通 shell 继续读取终端缓冲区。

范围外：实时追更、尚未落盘内容、隐藏推理还原、新附件解码或新转录适配器。沿用现有 Markdown、历史消息和附件提示能力。

## 快照与接口

`runtime.getTaskConversationHistoryPage` 增加可选 `transcriptReadConsistency`。省略或传 `strict_revision` 时保留严格文件版本核验；文档阅读显式传 `stable_snapshot`，不以运行实例的内存消息替代持久转录。

稳定快照截止于首次读取时最后一个 LF。未换行的尾记录等完整落盘并显式刷新后读取。游标绑定卡片 incarnation、所选会话、原生来源与路径，以及各文件的 device、inode、birthtime、固定前缀长度和 SHA-256；身份观测时间更新不会使快照失效。摘要按 64 KiB 分块计算，不把整份转录载入内存。

固定前缀之外允许追加；固定前缀被截断、改写，或文件被替换时拒绝分页。Codex `history_base` 的可核实祖先前缀在首次打开时一并固定，继续遵循明确父身份、工作目录、完整行截点和最多 32 段的限制。分支追踪和重复 envelope 消除沿用原实现。读取前后重新核验来源。

响应继续区分 `available`、`partially_available`、`unavailable`；不可用时通过 `unavailabilityReason` 区分 `binding_pending`、`source_unavailable`、`identity_mismatch`、`snapshot_invalid`，提示保留具体原因。刷新或分页失败保留已加载内容。

## 阅读交互

- 首次打开读取最新快照。临时返回终端时保留组件、快照、位置、搜索和展开状态。切项目或会话时隔离请求代际，拒绝迟到响应。
- “刷新到最新”获取新快照并定位末尾；“返回最新”只移动到已加载快照末尾。加载更早记录按新增高度补偿阅读锚点。
- 默认“全部记录”，另外提供“仅对话”“对话与工具”，通过既有跨浏览器 origin 偏好机制持久化。工具和可读推理默认折叠、逐条展开。
- 搜索仅作用于当前可见的已加载记录，界面同时显示已加载与匹配条数。手机滚轮按钮滚动当前阅读文档。
- 临时来源或网络错误最多自动重试两次，切换或卸载时取消旧重试。首次缺少绑定时，在原生身份或路径就绪后自动补读；已成功加载的快照不随元数据更新重取。

## 验收与验证入口

实现分为稳定快照、阅读交互、运行时集成三个切片。新增后端测试先复现旧实现拒绝追加、把半条尾记录当损坏；hook 测试先复现刷新丢内容、缺少重试和绑定恢复。对应回归由 guarded 测试及 Web UI 测试守护。

```sh
npm run test:guarded -- --project precommit-safe test/runtime/agent-session-history/task-conversation-history-page.test.ts test/runtime/config/user-interface-preferences-shared-across-browser-origins.test.ts test/runtime/codex-native-session-protocol/codex-native-conversation-history.test.ts
npm run web:test -- src/hooks/use-task-conversation-history.test.tsx src/components/detail-panels/task-conversation-transcript-document-reader-panel.test.tsx src/components/detail-panels/agent-terminal-panel.test.tsx src/runtime/user-interface-preferences-shared-across-browser-origins-store.test.ts src/runtime/user-interface-preference-migration-from-browser-local-storage.test.ts
KANBAN_RUN_NATIVE_TRANSCRIPT_DOCUMENT_BROWSER_CHECK=1 npm run test:guarded -- --project runtime-integration test/integration/task-conversation-transcript-document-reader-real-browser.integration.test.ts
npm run typecheck
npm run web:typecheck
```

浏览器集成用 Playwright 启动隔离 runtime、Vite、HOME、Codex 配置和数据目录，读取真实 JSONL。桌面 1440×1000 验主会话、手机 390×844 验侧会话，使用 xterm 备用屏 fixture，不连接真实 PTY。覆盖画面外历史、追加后翻页、手动刷新、终端断开、可见度、搜索、位置和手机滚轮。guarded HOME 隔离下可用 `PLAYWRIGHT_BROWSERS_PATH` 指定预先安装的浏览器缓存。

构建前解除 task 中 `dist`、`web-ui/dist` 指向主仓库的软链，显式设置 `KANBAN_BUILD_DISTRIBUTION_OUTPUT_DIRECTORY`；验证构建只写 task 独立产物。测试 Node 必须与隔离 runtime 所用的原生依赖 ABI 匹配，不重编共享安装。

## 部署后验证分析

| 行为 | 部署前证据 | 部署后待验 | 类型 |
| --- | --- | --- | --- |
| 追加稳定、尾行边界、替换和改写拒绝、分段与分支 | guarded 测试 | 无额外纯逻辑断言 | 不注册 |
| 可见度、展开、失败保留、绑定恢复、迟到响应 | hook 和组件测试 | 无额外纯逻辑断言 | 不注册 |
| 全屏、终端断开、主/侧会话、桌面和手机布局及滚轮 | 隔离 runtime 与 Playwright | 实际 agent 的持久身份和原生文件绑定，在部署后打包 UI 中仍能读取并保留位置 | guided_manual，供真实界面自然观察 |

定义位于 `docs/verification-definitions/task-conversation-transcript-document-reader.json`，按稳定 verificationId 幂等更新。只登记，不执行真实实例验证、不写 `verifiedAt`。兜底清理：`kanban verification cleanup --verification-id 1a175138-3d4f-4ee8-98e3-23c19e30d982`。没有临时插桩。

本次注册回执与 `verification list` 均确认：workspace `cline-kanban`、task `982d3`，共 1 项 `guided_manual`，清理模式 `automatic`，资产目录 `/Users/bominzhang/.cline/kanban/verifications/1a175138-3d4f-4ee8-98e3-23c19e30d982`。没有自动脚本，dry-run 不适用。后续 deployment record 预计挂载引导项 1 项、自动项 0 项；当前没有执行或勾选该验证。

## 本次实施验证结果

- guarded：70 项后端测试及 1 项隔离 runtime / Playwright 集成通过；集成同时覆盖桌面主会话、手机侧会话及手机滚轮。
- Web UI：6 个相关测试文件、146 项测试通过，含入口、历史 hook、阅读组件、偏好及任务详情回归。
- 根项目与 Web UI 的 typecheck、改动文件 Biome 检查、`git diff --check`、独立目录的完整构建通过。
- 本机共享依赖存在版本漂移；只在 task 的独立 `node_modules` 中采用与锁文件一致的 thread-graph commit `233d3e765405fd27df0499c6cb4916ee3566d86b` 产物。后端单元测试也在 Node 22 通过；真实 runtime / 构建使用与既有原生依赖 ABI 匹配的 Node 24，没有重编共享安装。
- 源码保留在当前 task 工作树，未创建提交、未部署。真实 agent 进程、正式打包界面和实际移动设备上的集成表现由已登记的部署后观察项承接。
