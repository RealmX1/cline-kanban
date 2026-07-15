# Automated-script 验证脚本骨架

自动脚本型验证的入口脚本（放在 `register` 返回的 `assetsDir`，运行时 `cwd=assetsDir`）。runner 注入：
`KANBAN_RUNTIME_HOST`、`KANBAN_RUNTIME_PORT`、`KANBAN_VERIFICATION_ID`。退出码 `0=通过`，非 0=失败。

## bash 骨架

```bash
#!/usr/bin/env bash
# 自动脚本型部署后验证。cwd = 本验证的 assetsDir。
set -euo pipefail

HOST="${KANBAN_RUNTIME_HOST:-127.0.0.1}"
PORT="${KANBAN_RUNTIME_PORT:-3484}"
VID="${KANBAN_VERIFICATION_ID:-unknown}"
TAG="[vrf:${VID}]"

# 自建实体一律带 TAG，并在 finally 无条件清理。
cleanup() {
  # 例：删除本脚本创建的、带 TAG 的临时资源
  :
}
trap cleanup EXIT

# 1) 前置检查：运行实例可达。不可达 → 退出非 0（绝不静默 exit 0 假装通过）。
if ! kanban --help >/dev/null 2>&1; then
  echo "前置不可用：kanban CLI 不在 PATH" >&2
  exit 1
fi

# 2) 观察运行实例：优先经 `kanban … --json` CLI 或只读状态文件，避免直接改运行数据。
#    这里放你的断言逻辑，观察到「部署后才有的期望行为」→ exit 0；否则 exit 1。
OBSERVED="$(kanban deployment verification-state --active-only 2>/dev/null || true)"
if echo "$OBSERVED" | grep -q "期望的可观察标志"; then
  echo "通过：观察到期望行为"
  exit 0
fi

echo "失败：未观察到期望行为" >&2
exit 1
```

## node 骨架

```js
// 自动脚本型部署后验证（interpreter: "node"）。cwd = 本验证的 assetsDir。
const host = process.env.KANBAN_RUNTIME_HOST || "127.0.0.1";
const port = process.env.KANBAN_RUNTIME_PORT || "3484";
const vid = process.env.KANBAN_VERIFICATION_ID || "unknown";

async function main() {
  // 观察运行实例（只读优先）。观察到期望行为 → exit 0；否则 exit 1。
  const res = await fetch(`http://${host}:${port}/healthz`).catch(() => null);
  if (res && res.ok) {
    console.log(`通过 [vrf:${vid}]`);
    process.exit(0);
  }
  console.error(`失败 [vrf:${vid}]：运行实例不可达或不满足断言`);
  process.exit(1);
}

main().catch((error) => {
  console.error(`错误 [vrf:${vid}]：`, error);
  process.exit(1);
});
```

## 约束清单（写脚本时逐条自检）

- [ ] 入口在 `assetsDir` 内，**不**指向 task worktree。
- [ ] 退出码语义正确：`0=通过`，非 0=失败；前置不可用退非 0 而非静默通过。
- [ ] 观察走只读优先（CLI `--json` / 状态文件），不改 runtime config / 用户数据。
- [ ] 自建实体带 `[vrf:<id>]` tag，`trap/finally` 无条件清理。
- [ ] 幂等可重跑（多次运行结论一致，无累积副作用）。
