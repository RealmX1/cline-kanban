# 测试执行与 Git 安全契约

测试文件继续留在对应业务领域目录中。文件后缀只区分执行形态，不再为 Git、文件系统和进程能力分别建立命名体系。

| 文件后缀 | Vitest project | 执行约定 |
| --- | --- | --- |
| `*.test.ts` | `precommit-safe` | 普通测试；允许在每个测试独占的临时目录中读写，也允许通过统一 fixture 使用真实 Git。最多两个 workers。 |
| `*.integration.test.ts` | `runtime-integration` | 真实 server、CLI、WebSocket、PTY 或需要完整进程生命周期的测试。单 worker 串行。 |

## Git 测试必须使用统一 fixture

Git repository mutation safety 基础设施集中在 `test/git-repository-mutation-safety/`。真实 Git 测试只能通过 `isolated-git-test-workspace-fixture.ts` 操作仓库；测试文件不得直接执行 literal `git` binary。

fixture 为每个测试创建独立 root、HOME、USERPROFILE、XDG config 和 temp，清除继承的全部 `GIT_*`，禁用 system config、交互和宿主 hooks，并限制 cwd、git-dir、common-dir、worktree、remote、alternates 与 cleanup 都留在 fixture root。integration 子进程需要访问测试仓库时，使用 fixture 的 `createIsolatedChildProcessEnvironment`，不得原样继承 `process.env`。

## 静态策略与宿主仓 canary

`npm run test:policy` 使用轻量 TypeScript AST 检查测试源文件：

- Git fixture 和 repository canary 之外不得直接执行 literal `git`；
- 子进程不得通过 `env: process.env` 或 `{ ...process.env }` 直接继承完整父环境；
- 真实测试 Git 不得使用 production `createGitProcessEnv`。

策略没有注释豁免；需要新的 Git 测试能力时扩展统一 fixture 并补充 fixture 自测。

`npm test`、`npm run test:precommit`、`npm run test:integration` 与 `npm run test:watch` 都通过 invoking-repository mutation canary 启动 Vitest。canary 在测试前后比较 worktree/git-dir/common-dir、symbolic HEAD、HEAD OID、local config、index、porcelain v2 status 与 dirty/untracked 内容 hash。检测到漂移时 fail closed，保存脱敏报告，绝不自动恢复宿主仓库。

## 命令

- `npm run test:policy`：只运行 Git 测试安全策略。
- `npm run test:guarded -- <vitest args>`：在 policy 与宿主仓 canary 下运行指定 Vitest 参数。
- `npm run test:precommit`：运行 `precommit-safe`。
- `npm run test:integration`：运行 `runtime-integration`。
- `npm test`：依次运行两个 projects。
- `npm run test:watch`：在相同保护下启动 watch；退出时执行最终 canary 复查。

pre-commit 保持 Biome → typecheck → tests 的顺序；测试子进程的 Git 环境清洗不会改变 hook 随后的 Git 环境。
