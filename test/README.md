# 测试危险能力契约

测试文件继续留在对应业务领域目录中；文件后缀声明测试实际拥有的危险能力。目录名不再暗示“unit/fast”或“integration 才会触碰文件系统”。

| 文件后缀 | Vitest project | 能力边界 |
| --- | --- | --- |
| `*.test.ts` | `precommit-safe` | 纯进程内行为，或对外部能力进行完整 mock；不得启动真实子进程或写入真实文件系统。 |
| `*.isolated-git-repository.test.ts` | `precommit-safe` | 真实 Git、bare repository、refs 和 linked worktree；必须使用统一 Git fixture。 |
| `*.isolated-filesystem-mutation.test.ts` | `precommit-safe` | disposable sandbox 内的真实写入、递归删除、symlink 与 path-escape 场景。 |
| `*.isolated-process-lifecycle.test.ts` | `isolated-process-lifecycle` | 真实 spawn、signal、kill、PTY 或 process tree；单 worker 执行。 |
| `*.integration.test.ts` | `runtime-integration` | 真实 server/CLI/WebSocket，或 Git、文件系统、进程等多个本地能力的组合；为避免跨文件 server 启停互相饥饿，单 worker 执行。 |

## 强制 fixture

危险测试基础设施集中在 `test/dangerous-capability-test-infrastructure/`。真实 Git 测试只能使用其中的 `isolated-git-test-workspace-fixture.ts`：它为每个测试创建独立 root、HOME、XDG config 和 temp，清除所有继承的 `GIT_*`，并在每条 Git 命令后验证 git-dir、common-dir 和 worktree 都留在 fixture root。禁止在测试中直接执行 literal `git` binary。

危险删除使用 `test/dangerous-capability-test-infrastructure/protected-filesystem-mutation-test-fixture.ts`。高风险测试应把 owned deletion target、protected sibling、symlink escape target 和 sentinel 全部放入同一个 disposable sandbox；teardown 只有在 root identity 与 canary 均通过时才允许删除。

真实进程生命周期使用 `test/dangerous-capability-test-infrastructure/owned-process-lifecycle-test-fixture.ts`。fixture 为目标进程生成 ownership token，同时保留无关 sentinel 进程；只向 fixture 持有的 PID/process tree 发信号，结束时验证 sentinel 存活且没有孤儿进程。fixture 默认继承已移除全部 `GIT_*` 的父环境；需要覆盖 HOME 等普通变量时使用 `createSanitizedChildProcessEnvironment`。只有 Git fixture 等已经完成完整隔离的调用方才应传入一份完整 `environmentVariables`。

## 静态策略与宿主仓保护

`npm run test:policy` 使用 TypeScript AST 检查所有测试源文件，拒绝：

- Git fixture 以外直接执行 literal `git` binary；
- 子进程直接、条件展开、变量别名或 `Object.entries`/`Object.assign` 方式复用完整 `process.env`；
- 使用 production `createGitProcessEnv` 执行真实 Git；
- process/integration lane 与能力 fixture 之外直接调用 `child_process`。

策略没有注释豁免。真正需要新能力时应扩展对应 fixture。

`npm test` 与 `npm run test:precommit` 通过 invoking-repository mutation canary 启动 Vitest。执行前后会比较 worktree/git-dir/common-dir、symbolic HEAD、HEAD OID、local config hash、index hash 与 `status --porcelain=v2 -z`。检测到漂移时测试必定失败，只保留路径、hash/status 和原子进程结果的临时诊断，绝不自动恢复宿主仓库。

## 命令

- `npm run test:precommit`：policy + 普通测试 + isolated Git + isolated filesystem
- `npm test`：policy + 全部三个 projects
- `npm run test:integration`：process lifecycle + runtime integration（保留原调用语义）

所有入口先运行 AST policy。pre-commit 仍保持 Biome → typecheck → tests 的顺序；hook 自己后续的 Git 操作继续使用原环境，测试子进程的环境清洗不会泄漏回 hook。

Vitest 默认使用 forks。只有 `isolated-process-lifecycle` 与 `runtime-integration` 单 worker；其余测试统一属于 `precommit-safe`，保留文件并行但全局最多 2 workers。
