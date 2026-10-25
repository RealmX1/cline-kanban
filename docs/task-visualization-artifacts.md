# 任务 HTML 可视化发布与远端预览

## 已批准的实现合同

- 能力：任务生成的 HTML 及声明资源由 Kanban 持久托管，通过当前浏览器的访问入口查看。
- 用户选择：通用 HTML、看板内自动预览、Kanban 与 `visualization-platform` 协同、只在最近操作且仍在前台查看该任务的页面自动展示。
- 边界：保留本地文件；不新增独立托管进程，不实现 Electron、跨设备离线同步或应用后端。本轮交付为实现与验证，提交、合并和部署依后续授权执行。
- 验收：资源可加载、脚本与看板隔离、归属包含 workspaceId、重启与源目录清理后仍可查看、重试不重复发布、多设备只选定一个自动预览页面。
- 切片：先验证持久发布与内容路由，再验证浏览器路由与桌面/手机预览，最后验证 skill 自动发布与原有文件协议兼容。

## 发布契约

发布先固化持久包，运行时接受后才更新任务清单。CLI 固化发布包并保留明确拒绝的证据，清单、版本与预览请求由运行时维护。
HTML 入口相对于声明的源根目录定位；额外资源通过显式的「包内相对路径 = 本机文件或目录」映射打包。
映射根可显式指向软链目录，但内部软链不能逃出该映射的真实根。不会提供任意本机路径的 HTTP 读取接口。

产物归属为 workspaceId + taskId，源 HTML 的稳定标识决定产物身份，内容摘要决定不可变版本。
首次有效发布请求自动预览；后续更新保留阅读中的版本，由用户刷新。显式 request-preview 可再次请求展示。
同一任务的固化包在跨进程文件锁内分配并持久保存递增序号，运行时据此拒绝迟到旧包，
同毫秒与进程重启均不会改变顺序。旧 schema 缺少序号时回退到固化时间；同毫秒不同内容无法证明较新，保留当前版本。
`--request-preview` 对未变化内容也生效；同一发布请求重试只登记一次预览。

## 浏览器与内容隔离

查看器沿用当前看板 origin，内容位于带单产物只读凭据的路由。HTML 由 CSP 与 iframe 双重 sandbox 隔离，允许脚本而不授予同源身份。
只读内容路由单独处理 opaque origin 的资源读取；tRPC 和终端 WebSocket 的 Host、Origin 与认证门禁继续生效。
共享链接指向查看器，查看器通过当前认证换取有限时效的内容凭据，不把宿主路径或内部认证令牌写进链接。

## 恢复与验证

待接受包跨重启保存。暂时故障有界退避，记录具体失败和下一次恢复条件；永久损坏保留失败证据，不覆盖已发布版本。
网络中断、内部错误或结果未知时，CLI 返回 `ok=true / awaiting_runtime_acceptance`，保留持久包供恢复。
任务不存在、Done 只读或归属错误被明确拒绝时，CLI 非零退出并返回 `ok=false / runtime_acceptance_rejected`；原包与首次拒绝记录保留，重启扫描不再尝试接受。修正原因后重新 publish 会创建新请求。
运行时重启重建浏览器上下文；展示请求按 ID 与浏览器回执去重。离线期间的产物通过清单恢复，不批量重放自动打开。
自动投递先由页面接受，再由服务端授予绑定请求、页面和投递 ID 的唯一接受权，获得授予后才挂载 iframe。
5 秒只限制尚未接受的 offer；已接受的慢加载不能直接改派。成功入口响应注入绑定本次内容凭据和修订的加载证明，
查看器同时核对当前 frame、opaque origin、完整产物归属和随机证明；iframe load、HTTP 错误文档或旧 frame 消息不算展示成功。
内容 30 秒未确认即卸载 frame，卸载后才释放接受权；服务端 45 秒仍未完成则请求取消，10 秒未确认取消即持久记录失败并停止自动改派。
失败、拒绝只向未尝试页面改派，最多 3 次；接受后断线或重启保留失败原因并停止自动复制打开，用户可从产物清单手动重试。
旧版浏览器未声明接受协议时不接收自动预览；更新页面后即可使用。关闭或主动切走预览记录独立的 dismissed 回执，
不把取消写成展示成功，也不在后续心跳时重新抢回面板。
测试使用隔离 HOME、临时发布源和临时运行时，不向真实任务或关系账本造测试数据。

## 使用方式

```sh
kanban task visualization publish --task-id <任务ID> --project-path <主仓库> \
  --source-html-file <HTML绝对路径> --title "架构说明" \
  --resource-mapping "assets=<资源目录绝对路径>"
kanban task visualization list --task-id <任务ID> --project-path <主仓库>
kanban task visualization request-preview --task-id <任务ID> --project-path <主仓库> \
  --visualization-artifact-id <list返回的ID>
```

入口默认按文件名放入包内；需要保留 `sessions/<文件名>.html` 等层级时，声明 `--source-root-directory`。
`--no-preview` 只发布，`--request-preview` 则在更新版本时也请求预览。普通更新只提示加载新版本。
只读清单返回 `visualizationPublicationProtocolVersion=task-visualization-artifacts/v1`；skill 的 `--help` 声明同一协议，便于部署后检查两仓安装状态。

## 自动化验证

运行时经 `npm run test:guarded -- --project precommit-safe test/runtime/task-visualization-artifacts` 验证。
真实打包态浏览器用例位于 `test/integration/task-visualization-artifacts-real-browser.integration.test.ts`，通过
`KANBAN_TASK_VISUALIZATION_PACKAGED_CLI_PATH` 指定隔离构建的 CLI；`PLAYWRIGHT_BROWSERS_PATH` 指定现有浏览器缓存。
额外设置 `KANBAN_TASK_VISUALIZATION_PLATFORM_SCRIPT_PATH` 可联合验证另一个仓库中的 skill；截图目录用
`KANBAN_TASK_VISUALIZATION_BROWSER_EVIDENCE_DIRECTORY` 指向持久位置。
