# Installation

本文件是 Kanban 安装的单一出处：终端用户安装、以及从源码 checkout 做开发安装。
日常开发工作流（dev server、dogfood、tmux 长驻启动）在 [`DEVELOPMENT.md`](./DEVELOPMENT.md)；面向 coding agent 的命令与架构导航在 [`CLAUDE.md`](./CLAUDE.md)。

## 终端用户安装

```bash
# 免安装直接跑
npx kanban

# 或全局安装
npm i -g kanban
kanban
```

在任意 git 仓库根目录执行。Kanban 会检测已安装的 CLI agent 并在浏览器中拉起一个本地服务器，无需账号或额外配置。

## 从源码做开发安装

### 前置要求

- **Node.js**：`package.json` 的 `engines` 声明 `>=22`；CI 矩阵同时在 Node 20 与 22 上验证（`DEVELOPMENT.md` 记的是 20+）。装 22 最省事，但涉及新 Node API 的改动请以 20 为下限考虑。
- **npm 10+**
- **git**

### 安装依赖

本仓库是**一个 git 仓库里的三个互相独立的 npm 项目**，各有自己的 `package.json` 与 lockfile，必须分别安装：

| 项目 | 位置 |
| --- | --- |
| 运行时（CLI + 本地服务器） | `/` |
| Web UI | `web-ui/` |
| 桌面壳（Electron） | `packages/desktop/` |

一条命令装齐三处：

```bash
npm run install:all
```

等价于：

```bash
npm install
npm --prefix web-ui install
npm --prefix packages/desktop install
```

CI 走的是 `npm ci` 对三处分别安装，见 `.github/workflows/test.yml`。**在 `packages/` 下新增 workspace 时必须同步给该 workflow 补 install/test 步骤**，否则新 workspace 会悄悄掉出 CI 覆盖。

### 把当前 checkout 装成全局 `kanban` 命令

```bash
npm run link     # 等价于 npm run build && npm link
```

验证：

```bash
which kanban
kanban --version
```

两个容易踩的点：

- `npm run link` 会**先构建**。改完源码后要重新 `npm run build`（或再跑一次 `npm run link`），全局命令才会用上新代码。
- 在多个 worktree 之间切换时，**从你要测试的那个 worktree 重跑 `npm run link`**，全局 `kanban` 才指向对应的 `dist/cli.js`。

移除全局链接：

```bash
npm run unlink
```

### 装完之后

- 跑起来做开发：`npm run dev:full`（详见 [`DEVELOPMENT.md`](./DEVELOPMENT.md)）
- 校验环境是否装对：`npm run check`（lint + typecheck + 测试）
