# 草稿使用检测与可复用 Commands

每次真实用户提交（`UserPromptSubmit`、`BeforeAgent`、OMP `input` 或 ACP `session/prompt`）异步检查该任务及侧问会话名下、项目和全局的未使用草稿。普通工具活动不会触发检查。浏览器无需保持打开；页面通过 runtime state stream 的轻量失效事件刷新，重连重新读取。

匹配只比较用户文字，不调用模型。统一 Unicode NFC 与空白后先判全文相等；至少 16 个字符的草稿支持完整包含，至少 32 个字符支持局部编辑距离不超过草稿长度 10% 的近似子串。每对文字最多计算 200 万格，超预算仍保留精确匹配。大小写、数字、标点及代码操作符保留。匹配是文字相似的判断，不保证语义等价；可手动恢复未使用。

已使用条目独立显示在末尾。未使用条目按正文编辑时间倒序；标记状态、切换范围和转换为 Command 不推进正文编辑时间。修改正文会重置使用状态；人工恢复未使用会设定历史忽略边界，之后只匹配新提交。写回时在文件锁内检查正文 SHA-256 与忽略边界，过期计算不能覆盖人工修改。

会话历史从现有原生身份 sidecar、身份事件历史和任务／侧问关联中读取，不从 cwd 推断。JSONL 分块流读完整文件，不采样头尾；Claude 复用核心包的消息分类器。Codex 同时读取 `event_msg.user_message` 与 `response_item` 中 `type:message`、`role:user` 的文字块，逐块排除以 `# AGENTS.md instructions for <path>` 加 `<INSTRUCTIONS>`、`<environment_context>` 或 `<task-notification>` 开头的注入上下文／通知，混合消息保留其余用户原文；证据使用外层时间戳和可用的 `payload.id`。非用户来源或分身会话仍按 `session_meta` 排除。其余 JSONL 读取明确的用户文本块；OMP 另排除 `synthetic:true` 与明确非 `user` 的 attribution，缺省 attribution 的普通用户输入继续有效。不支持的格式（例如 Cursor 原生二进制 chat store）、缺失转录和无法确认身份的历史会记录为跳过，保持草稿原状。提交 hook 已携带正文时，当前提交不依赖 transcript 已经落盘。

首次运行新版本会执行一次全局回填，覆盖已注册项目的 Task、Project 和全局草稿。进度和跳过原因保存在运行时 HOME 下的 `prompt-draft-usage-historical-backfill-v1.json`；逐任务保存进度，中断后继续，完成后不再自动执行。跨项目同号任务按 `[workspaceId, taskId]` 区分。运行时关闭会取消后续工作。遇到读坏的库文件不写完成标记；修复读取问题后下次启动继续。

Prompt 可选择 Project 或全局范围转换为 Command。原条目移动到 Commands Tab，保留身份、正文、创建时间与来源；Command 可以编辑、填入、排队和删除，不自动归入已使用。Commands 的永久保留指使用后不会被消耗或自动隐藏，仍由用户决定删除。usage／trajectory tracking、Profiles 和 tags 不在本次范围内。
