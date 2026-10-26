# 任务辅助 AI 的 API 主备路由

项目归属、查卡召回、查卡解释、任务起名、关系建议及后台关系分诊统一使用 API 单轮分析，任务本体的执行 Agent 不变。项目归属与查卡召回有独立用途标识，后续 Decision Model 由任务 `24b78` 选型与启用。

## 实施合同

- 范围：共享请求层、持久路由与恢复状态、上述辅助用途、项目归属轻量材料、设置页和诊断契约。
- 验收：每阶段每家最多一次请求；取消零备用调用；结构与身份校验在切换前完成；恢复条件跨重启保存；不支持图片时不得删图请求。
- 边界：不替换任务 Agent，不自动采纳项目变更，不改变身份、分支或权限门禁；不启用 Decision Model，不修改项目归属开关的默认值。
- 集成：保留 `fccbf` 的项目归属开关及文档。关闭时由创建、保存和启动入口跳过归属请求；显式归属 API 不替用户打开开关。

## 配置和协议

`kanban-model-provider-settings.json` 的 `taskAssistanceRoutingSettings` 保存 `TaskAssistanceModelProviderRoutingSettings`：`preferredModelProviderId` 默认 `minimax`，`fallbackModelProviderId` 默认 `deepseek`，后者可为 `null`。端点、模型 ID 与安全凭据只由既有 provider 档案持有。Settings 修改在保存后用于新请求；新 API 是 `support.getTaskAssistanceModelProviderRoutingSettings` 与 `support.setTaskAssistanceModelProviderRoutingSettings`。

MiniMax 需配置端点与模型 ID，例如使用 `KANBAN_MODEL_PROVIDER_MINIMAX_BASE_URL`、`KANBAN_MODEL_PROVIDER_MINIMAX_MODEL_ID` 与凭据来源；不写死选用的 MiniMax 型号。MiniMax 缺失不阻止 DeepSeek 独立工作。旧 `task-analysis/executor-settings.json` 和查卡历史继续可读，当前执行不再读取 CLI 设置或启动 CLI。任务起名的旧单用途绑定保留在历史设置中，当前执行统一遵从主备路由。

DeepSeek 使用 JSON 模式与非思考模式。MiniMax 使用 schema 指令和最终正文校验：M2 系列不发送关闭思考参数；M3 可关闭思考；M3.1 使用 `reasoning_effort=low`，不发送不受支持的关闭参数。推理正文与工具调用不能冒充最终 JSON。协议依据：[DeepSeek](https://api-docs.deepseek.com/api/create-chat-completion/)、[MiniMax](https://platform.minimax.io/docs/api-reference/text-openai-api)。

图片通过原有归属编号及 `image_url` 内容块完整传递。已知 MiniMax M3 系列可处理图片；其他模型可在 provider 档案声明 `supportsImageInput`。不兼容的首选跳过并尝试兼容备用；全部不兼容时明确失败，保留历史附件。

## 有界恢复与审计

起名和项目归属每家默认 15 秒，查卡各阶段和关系分析每家默认 60 秒。网络、超时、服务商错误、JSON/schema、业务身份校验失败可切换备用，每家每阶段最多一次；主备相同只调用一次。取消直接结束，不触发备用或新冷却。

首选失败后冷却 60 秒，恢复条件保存在 `task-assistance-model-routing/provider-recovery-state.json`。新请求每次从磁盘读取；冷却期间尝试备用，届满后的下一次请求重验首选。路由、端点、模型或凭据变化会改变配置指纹，立即绕过旧冷却；只持久保存指纹，不保存凭据。成功清除冷却但保留最近失败，历史尝试另存轮转诊断 journal。恢复文件损坏或暂不可写时记录诊断，继续有界请求，下次读写自动重建。

`task-assistance-routing` journal 记录尝试和跳过，`model-provider-usage` 记录实际模型请求。包括用途、阶段、操作 ID、provider、请求和实际模型、耗时、输入/输出 token、缓存读写、稳定前缀哈希、失败和降级原因。缓存字段遵从 [MiniMax 返回字段](https://platform.minimax.io/docs/api-reference/text-prompt-caching)，缺失显示“未知”，不会补零。查卡同时把逐次尝试持久保存到轮次，旧历史无需迁移。

## 项目归属材料

完整注册项目列表始终保留。每项目最多三条相关的非 Trash 标题，没有匹配时按最近更新时间补足；每条最多 120 字符，标题示例序列化总预算 12,000 字符。预算不足时减少示例，不裁项目列表。新任务正文完整进入本次查询。独立收集器只读取注册目录及看板标题，不调用通知归档、会话或重型共享 Context 收集器。

项目建议仍须用户选择；无证据保持当前项目，模型返回未注册项目视为无效并尝试备用。两家不可用时保持原有失败提示与保留已选项目的交互。

## 验证入口

`task-assistance-model-provider-routing.test.ts` 覆盖主备、取消、冷却、配置变化、图片、协议参数和未知用量。`task-project-assignment-lightweight-context.test.ts` 覆盖完整列表、标题排序与预算及背景材料减少至少 90%。`task-project-assignment-single-turn-analysis.integration.test.ts` 验证真实本机 HTTP、完整新正文、零重材料收集与零 CLI 启动。

查卡与分诊的既有集成用例改为隔离 HTTP fixture，保留多轮、候选身份、重启、幂等和关系账本验收。`task-assistance-model-provider-routing-settings.spec.ts` 验证桌面和手机设置保存/取消，`task-lookup-workbench.spec.ts` 验证查卡、图片与追问。浏览器可设置 `KANBAN_PLAYWRIGHT_WEB_UI_PORT` 使用独占 Vite 端口。
