# 经 Tailscale Serve 从其他设备访问 Kanban

这是一份**与机器无关的单机配方**：任何一台跑 kanban runtime 的机器都按同样的步骤，把自己暴露成一个 tailnet 内可访问的 HTTPS 地址。其他设备（Windows、另一台 Mac、手机）的浏览器打开这个地址即可使用。下文用占位符：

| 占位符 | 含义 | 例子 |
|---|---|---|
| `<machine>.<tailnet>.ts.net` | 这台机器在 tailnet 里的 MagicDNS 全名（`tailscale status --json` 的 `Self.DNSName`，去掉末尾的点） | `my-machine.example-tailnet.ts.net` |
| `<kanban-port>` | runtime 在本机监听的端口 | `3484` |
| `<public-port>` | tailnet 上对外的 HTTPS 端口，可以与 `<kanban-port>` 不同 | `3485` |

## 为什么必须是 HTTPS，以及为什么不再用改写 Origin 的反代

- **剪贴板要求 secure context。** 浏览器只在 `https://` 或 `localhost` 页面上提供 `navigator.clipboard`。用 `http://<tailnet IP>:<port>` 访问时，它是 `undefined`：agent TUI 经 OSC 52 发来的复制（例如 Claude Code 里拖选即复制）落不到本机剪贴板，各处「复制」按钮也只能走降级路径。`tailscale serve` 自动签发 `*.ts.net` 证书，不需要自己管证书。
- **不要用改写 Origin 的反代。** runtime 的 WebSocket（包括终端输入输出）唯一的跨站防线是 Origin 校验（`src/server/middleware.ts`）。如果在前面放一个把**任意** Origin 都改写成 `http://127.0.0.1:<kanban-port>` 的反代，这道防线就失效了：浏览器里任何网页都可能连上终端 WebSocket。正确做法是让 runtime 知道「这个 origin 也是我」，也就是 `--additional-trusted-browser-origin`。
- runtime 仍然只绑在 `127.0.0.1`。`isKanbanRemoteHost()` 不受影响，所以不会触发 passcode 门禁：访问控制由 tailnet 本身负责，只有同一 tailnet 的设备能连上。

## 配方

1. 用额外受信 origin 启动 runtime（可重复传多个）：

   ```bash
   kanban --host 127.0.0.1 --port <kanban-port> --no-open \
     --additional-trusted-browser-origin https://<machine>.<tailnet>.ts.net:<public-port>
   ```

   `<public-port>` 是 443 时，origin 写成 `https://<machine>.<tailnet>.ts.net`（不带端口），和浏览器发出的 Origin 头一致。

2. 让 tailscaled 在 tailnet 上提供 HTTPS 并转发到 runtime。这条配置由 tailscaled 持久保存，重启后依然有效，和同一台机器上其他端口的 serve 配置互不影响：

   ```bash
   tailscale serve --bg --https=<public-port> http://127.0.0.1:<kanban-port>
   tailscale serve status   # 确认映射
   ```

3. 在其他设备的浏览器打开 `https://<machine>.<tailnet>.ts.net:<public-port>/`。

自检（在 runtime 所在机器上）：

```bash
# 受信 origin 应返回 200；其他 origin 应返回 403。
curl -s -o /dev/null -w '%{http_code}\n' -H 'Origin: https://<machine>.<tailnet>.ts.net:<public-port>' \
  https://<machine>.<tailnet>.ts.net:<public-port>/api/passcode/status
curl -s -o /dev/null -w '%{http_code}\n' -H 'Origin: https://evil.example.com' \
  https://<machine>.<tailnet>.ts.net:<public-port>/api/passcode/status
```

撤销：`tailscale serve --https=<public-port> off`，再去掉启动参数。

### 打不开时先排查本机代理软件

设备上开着 Clash 之类的代理软件时，`*.ts.net` 常常连不上，浏览器报 `ERR_CONNECTION_CLOSED`，curl 报 TLS 握手失败。有两个原因：

- fake-ip 模式的 DNS 把 `*.ts.net` 解析到 `198.18.x.x`，而不是 tailnet 地址（`100.x.y.z`）。可用 `dscacheutil -q host -a name <machine>.<tailnet>.ts.net` 查看解析结果。
- 浏览器走系统代理时，请求先进了代理，代理连不上 tailnet。

解决办法：在代理软件里把 `*.ts.net` 和 `100.64.0.0/10` 设为直连，并让它们绕过 fake-ip。只想临时自检时，可以用 `curl --resolve <machine>.<tailnet>.ts.net:<public-port>:<tailnet IP>` 绕开 DNS。

### 注意顺序

先部署带 `--additional-trusted-browser-origin` 支持的 kanban，再改启动脚本。旧版本不认识这个选项，会直接启动失败。

### 多台机器

每台跑 kanban 的机器各自照做一遍，各用自己的 `<machine>` 名。形态是「每台机器一个浏览器标签页」：两个 runtime 互不相见，同名仓库在两台机器上的 workspace id 相同也没关系。把多台机器合并进一个标签页（联邦）是另一回事，评估见 `.plan/docs/multi-machine-kanban-runtime-federation-evaluation-deferred-until-route-decision.md`。

## 远程设备上的剪贴板

- HTTPS 下，agent TUI 自己的复制（OSC 52）直接写进当前设备的剪贴板。
- agent TUI 开着鼠标追踪时（Claude Code 的 fullscreen 模式、较新的 Codex），普通拖选和右键会被 agent 收走。要用浏览器自己的选区，按住 Shift 拖选（macOS 上是 Option）。
- 终端里的快捷键：
  - macOS：Cmd+C 复制选区。
  - Windows / Linux：Ctrl+Shift+C 复制选区；**Windows 上有选区时 Ctrl+C 也复制**，没有选区时照常发 `^C` 给 agent。
  - 从其他设备访问（非 macOS）时，Ctrl+V 粘贴的是**当前设备**的剪贴板文本。本机访问时 Ctrl+V 仍然发 `^V`，让 agent 读本机剪贴板里的图片。
- 粘贴图片：用输入框的图片粘贴，或把图片拖进终端区域。agent 自己读剪贴板图片时读的是 runtime 所在机器的剪贴板，远程设备上的图片它看不到。

## 远程查看文件：VS Code Remote-SSH

从其他设备访问时，顶栏的「Open」不再在 runtime 所在机器上启动编辑器（那会打开在远端屏幕上，你看不到），而是在当前设备上打开 `vscode://vscode-remote/ssh-remote+<user>@<machine>.<tailnet>.ts.net/<path>` 这样的 Remote-SSH 深链。用户名来自 runtime 广播的主机身份，主机名取当前页面的主机名。支持 VS Code、VS Code Insiders、Cursor、Windsurf，复用 Open 下拉里的同一个偏好；偏好是不支持 Remote-SSH 的目标（Finder、终端等）时，远程访问按 VS Code 处理。

当前设备一次性配置：

1. 安装编辑器和 Remote-SSH 扩展（VS Code 的扩展 id 是 `ms-vscode-remote.remote-ssh`）。
2. 生成 SSH 密钥（`ssh-keygen -t ed25519`），把公钥追加到 runtime 所在机器的 `~/.ssh/authorized_keys`。macOS 需要在「系统设置 → 通用 → 共享」里打开「远程登录」。也可以改用 Tailscale SSH。
3. 自检：`ssh <user>@<machine>.<tailnet>.ts.net` 能免密登录。

每个 Remote-SSH 连接会在 runtime 所在机器上起一个 VS Code Server，常驻约几百 MB，用完关掉窗口即可释放。

## 相关

- [`cli-environment.md`](./cli-environment.md)：CLI 与 runtime 连接相关的环境变量。
- [`architecture.md`](./architecture.md)：runtime 与浏览器的职责划分。
