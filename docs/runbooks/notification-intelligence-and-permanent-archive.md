# 智能通知与永久档案

任务：`8dc89`。通知档案、AI 评估、BYOK 和三种语音来源一起交付；不改变 agent harness 的认证。

## 数据位置和保留规则

运行目录为 `~/.cline/kanban/`：

- `notification-lifecycle-archive/notification-lifecycle.sqlite`：SQLite WAL 数据库。原始信号、每次判断、面板操作、投递和播报结果均追加记录；不按条数或年龄删除。
- `notification-lifecycle-archive/synthesized-notification-audio/<sha256>.audio`：第三方返回的音频永久保留，按内容去重。
- `kanban-model-provider-settings.json`：不含密钥的 provider 配置、用途绑定和通知设置。设置里输入的密钥只写系统凭据库；环境变量模式只从选定的环境变量读取。
- 原 `workspaces/<workspaceId>/notifications.json`：首次读取时事务化导入，源文件保留。导入身份包含 workspace，重复启动不重复导入；损坏文件报错，不覆盖为空数组。过去已被旧实现淘汰的内容无法恢复。

这些文件独立于 task worktree 和 workspace 清理。面板一次显示 50 个任务组，历史一次显示 50 个信号；加载更多、按项目/任务/处理状态/时间范围查找不会删除档案。未读数统计全库中的未读任务组，不是当前页数量。

`notification_candidates` 是可重读的当前状态，`notification_lifecycle_events` 是追加的过程记录。进入/清空面板分别写 `notificationPanelVisibility=visible/cleared`；已读写 `notificationVisitedAt`，原始 payload 不变。任务 Done 筛选记录在 `panel_task_completion_policy_changed`，不删通知。

示例（省略其它字段）：

```json
{
  "candidateId": "固定贯穿一次 hook 重试链的 UUID",
  "workspaceId": "project-a",
  "taskId": "task-a",
  "sourceKind": "hook_cli_raw",
  "notificationPanelVisibility": "pending_decision",
  "notificationProcessingStatus": "deferred",
  "summaryLanguage": "zh-CN",
  "summaryText": "正在等待子任务",
  "deferredNotificationFallbackDeadlineAt": 1800000600000,
  "rawPayload": {"event":"to_review","stdinPayload":"原始 hook 输入，认证字段已脱敏"}
}
```

对应事件依次可能为 `candidate_captured` → `hook_transport_attempt_started` → `hook_ingest_received` → `programmatic_notification_rules_passed` → `ai_assessment_requested` → `ai_assessment_response` → `ai_assessment_decided` → `notification_deferred`。判断事件保存模型、提示词版本、实际提交的上下文、截断量、响应/用量、结构化理由。没有展示的通知同样可以查到。原始捕获在业务筛选之前；格式校验失败的 CLI 输入仍已留档。显式认证字段及 Bearer 文本脱敏，不存整个进程环境。

备份时应停止运行时并复制整个档案目录（包括可能仍在的 WAL/SHM）和不含密钥的设置文件；或使用 SQLite 在线 backup API。不要仅复制运行中的 `.sqlite` 主文件。系统凭据库需按操作系统另行管理。当前没有自动删除/压缩历史功能；磁盘不足时显式报留档异常并尽可能发出基础提醒，不以无法审计的 AI 判断静默压制通知。

## 评估与恢复

默认关闭 AI 评估。启用并配置文本 provider 后，仅对 `review` 完成候选进行一次评估，权限、问题等用户交互不进入 AI 静默筛选。明确的后台 park 与 by-the-way 会话先用运行时事实判断并记录理由。

单次输入最多 24,000 字符，超时 15 秒，最多两个并发请求，排队超过 30 秒进入延期。评估同时返回是否完成和一句摘要，不另发摘要请求。默认中文，可选英文；不按“重要程度”过滤。

- 已完成或明确交还用户：进入面板，发一次可领取的投递事件。
- 等待 command/subagent、证据不足、模型失败：延期；默认 10 分钟，可配置 1–60 分钟。
- 延期期间会话 incarnation、轮次或实质进展变化：旧候选失效，保留完整记录。
- 到期仍未确认：仅一次“尚未确认完成，可能需要查看”提醒。
- 重启时正在请求的候选不自动重发付费请求，转为延期；已有期限保留。

投递由数据库原子领取，多标签页不会为同一候选分别合成语音。浏览器前台、其它可见标签页、关闭通知和过时等决定也落事件。领取后崩溃不自动重播，避免重复外部效果。断线重连只恢复最近 60 秒未领取的事件。播放串行，排队和合成返回后均检查 60 秒有效期；失败回退提示音。

## BYOK 与语音

设置入口：Runtime Settings → Notifications → 智能通知。Provider、密钥替换/删除、用途绑定、AI 与语音设置、本机音色统一作为草稿，由底部唯一的 Save 保存，Cancel 放弃。切换 Provider 保留各自草稿；未编辑且未被用途绑定引用的新增草稿不会保存；当前编辑项显示已保存名称、ID、凭据来源与配置状态，密钥不回显。试听只播放已保存设置；有未保存修改时先 Save，再打开设置试听。保存流程按现有接口顺序执行，失败保留草稿并允许重试，已完成的写入不会自动回滚。

每个 provider 明确选择 `environment` 或 `system_credential_store`。环境变量为 `KANBAN_MODEL_PROVIDER_<大写且连字符转下划线的ID>_API_KEY`；沿用已有文本 provider 默认解析。密钥留空表示保留，删除按钮显式删除；系统库不可用/锁定时提示错误，不静默切换来源、不落明文文件。Linux 强制 Secret Service，不使用库的内存回退。

设置页分为两组：「语言模型」仅包含 OpenAI 兼容文本 Provider、任务起名及通知判断/摘要；「语音合成 TTS」仅包含 DeepInfra/阿里百炼 Provider、音色与播报设置。两组分别选择、添加和编辑凭据，新增配置默认采用所属组的协议；浏览器系统语音无需创建 Provider。摘要与播报语言是两组上方的共享设置。

任务起名、通知评估和语音合成是三个用途绑定。前两者使用 OpenAI-compatible 文本协议；第三者使用各 provider 原生 TTS 协议，不把音频服务硬塞进聊天接口。

| 来源 | 首批模型与能力 | 限制 |
| --- | --- | --- |
| 浏览器系统语音 | 当前设备音色、语言、语速、音调、音量 | 浏览器支持和用户激活限制；没有音频导出，历史记录这一事实 |
| DeepInfra | `hexgrad/Kokoro-82M`；核对过的中英文音色、语速 | 音色必须匹配语言，无风格指令；MP3/base64 原生接口 |
| 阿里 | `qwen-audio-3.0-tts-plus/flash`；音色、语速、音调、风格 | Audio HTTP 接口仅北京；与 Qwen3 接口分离 |
| 阿里 | `qwen3-tts-flash`、`qwen3-tts-instruct-flash` | 后者支持风格指令；地域与 workspace 配置显式保存 |

仅允许代码目录中已核对的模型/音色，不把上游浮动别名改写成某个当前版本号。模型不支持的控件会禁用。阿里返回的临时音频 URL 立即下载为永久本地文件，下载不带 API Key、禁止跨主机重定向，并限制结果域名、响应大小和音频格式。落盘先记录 hash/暂存文件名，再 fsync+rename；重启可恢复文件与候选的关联。

第三方服务按用户 BYOK 使用，试听/手动重新合成可能计费。请求发出后失败可能已经计费，禁止自动付费重试、禁止自动换 provider。成功音频再次播放复用档案。浏览器系统语音不需要 BYOK。

本地 Web App 可以使用系统语音，无需等 Electron。但关闭/冻结浏览器页面后的可靠播报不由浏览器保证；第三方 TTS 解决合成质量，不改变浏览器播放生命周期。Electron 构建包含 SQLite/keyring 原生依赖与 asar 解包规则。

## 验证入口

运行时测试使用 `npm run test:guarded`，Web 使用 `npm run web:test`。专项测试涵盖十万条记录、清空/全量已读、跨连接领取、并发去重、迟到 AI 结果、期限恢复、凭据来源隔离、第三方协议、失败不自动计费、音频崩溃恢复和过时播放。

真实系统音色、系统凭据库授权弹窗和用户账户上的第三方模型可用性仍需部署后的设备/账户验证；测试不使用真实付费密钥。不能把请求构造测试或模拟音频当作听感、provider 账户权限验证。

来源：[DeepInfra Kokoro API](https://deepinfra.com/hexgrad/Kokoro-82M/api)、[阿里 Audio HTTP API](https://help.aliyun.com/zh/model-studio/cosyvoice-tts-http-api)、[Qwen TTS API](https://help.aliyun.com/zh/model-studio/qwen-tts-api)、[Audio 音色列表](https://help.aliyun.com/zh/model-studio/qwen-audio-tts-voice-list)。
