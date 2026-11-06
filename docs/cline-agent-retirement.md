# Cline agent 退役与恢复依据

本产品已删除 Cline SDK、执行通道、旧 CLI adapter、登录与账号、provider/model/MCP 设置、Cline telemetry 和 Featurebase 反馈。项目名称、`kanban` 命令与 `.cline/kanban` 存储位置保留。

## 删除前版本

删除前 Git commit 为 `a819bb0a427184d0e280e683c4fed3ef0c1f778e`。完整旧实现可从该 commit 查看，不保留备用目录或可执行兼容实现。

锁文件曾通过 `@clinebot/llms → ai-sdk-provider-codex-cli → @openai/codex@0.105.0` 携带旧 Codex。本次移除整个依赖链；宿主仍需使用的 `@anthropic-ai/claude-agent-sdk@0.2.132` 与 `undici@6.24.1` 改为直接依赖，其余共同包版本保持原样。

## 保留的数据与行为

- 旧卡片、摘要、`cline` 身份、`in_process_cline_sdk` 历史通道及旧模型字段仍可解析；旧 SDK 数据目录不删除、不打开。没有新增历史读取器、导出器或会话转换。
- 启动、恢复、fork、直接聊天和程序化投递均明确报告 Cline 已退役。既有待发记录保留并显示退役阻塞原因，不等待一个永远不会恢复的 Cline 进程。
- 全局旧 Cline 默认值按已安装 CLI 的既有优先级解析，追加 Kimi、omp；无可用 CLI 时以 Codex 为安装引导默认。现有有效 Codex 选择保留，保存后的实际选择显式持久化。
- omp/ACP 使用共享的 `agent-conversation-*` 面板、hooks 和工具摘要；Kanban 自身模型服务、telemetry、任务存储保持各自职责。
- 旧 findings 的 Cline 结构化投影源报告不可用；已有 findings 和出处字段保留。PTY thread graph 的独立转录来源不受影响。

## 重新接入边界

未来若需要 Cline，应作为新的 Agent 接入重新评估依赖、原生会话身份、权限、接受确认、恢复与测试。旧身份的可读性不代表具有执行资格，也不应通过恢复旧锁文件重新引入已淘汰的 Codex 副本。

本任务只改变源码与任务私有依赖、构建产物。其他工作树和既有发布目录中的旧副本由后续已授权部署更新处理。

## 本次安装的环境恢复

既有 thread-graph 依赖 pin `233d3e765405fd27df0499c6cb4916ee3566d86b` 在 GitHub 下载端返回 404。本次从本机原仓库 Git 对象库核实该精确 commit，建立任务私有只读镜像，并通过单次进程的 Git URL 重定向完成干净安装；没有修改其源仓库、版本 pin 或用户 Git 配置。

该替代安装证明当前精确依赖内容可验证；普通远端全新安装的既有 404 仍需单独处理。本任务的隔离、安装、测试与浏览器证据保存在任务持久交接目录 `cline-agent-retirement/`。

## 实施验收

同一 RVF 的两路评审发现并修复了 5 项问题：恢复 ACP 退出保护计数和共享启动安全测试，补齐缺少摘要时直接输入与既有队列的退役判定，删除残留的 `--cline-model` 参数。当前真实会话身份仍优先于旧卡片选择，调试重置仍保留旧 SDK 数据。

最终被测完整树为 `54ef3ee8cfbc72de2ce2f639aba5e6b475a88c5d`，冻结的 7 组验证全部通过：根 guarded 普通测试 518 个文件、6666 项；Web UI 321 个文件、3359 项；相关集成 6 个文件、39 项；原生 Codex、Claude / omp fork 与打包态验证 3 个文件、5 项；另含两套类型检查和隔离生产构建。主会话随后仅更新本节验收记录，产品源码与测试保持该被测树内容。

打包态验证包括 TLS CLI/API、两次冷启动和真实 Chrome。Chrome 的 ACP 消息使用固定协议响应验证共享面板与工具展开；原生验证不调用外部模型。未将其余 `runtime-integration` 文件或桌面壳测试宣称为通过。

精确评审目录为 `~/.rvf/user-local-data/task-snapshot-reviews/task-review-f930f8042a3f40928aeac634c8c85332/`；主会话收尾证据位于 `~/.cline/kanban/cross-task-handoff-artifacts/cline-kanban/c6f4f/cline-agent-retirement/final-implementation-and-verification-report.md`。已登记 1 项部署后自动验证 `f006c0be-5ce7-4034-a25e-b06d1bdf03f5`，等待后续实际部署。提交、同步与部署状态以任务后续执行记录为准。
