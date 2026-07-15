# Verification definition JSON 示例

`kanban verification register --task-id <id> --definition-file <path.json>` 接受**单个对象**或**对象数组**。

## Definition 字段

```jsonc
{
  // 可选。缺省则 register 分配 uuid；提供则用于 rvf-reopen 幂等重注册（按 verificationId upsert 替换）。
  "verificationId": "<uuid, 可选>",
  // 必填。"automated_script" | "guided_manual"
  "kind": "automated_script",
  // 必填。automated 写「可勾选的观察断言」；guided 同样写可勾选断言（步骤放 guidance）。
  "label": "…",
  // guided_manual 用；automated 传 null。
  "guidance": null,
  // automated_script 用（必填 script）；guided 传 null。
  "script": { "entrypoint": "run.sh", "interpreter": "bash", "timeoutMs": 60000 },
  // 必填。清理规格。
  "cleanup": { "mode": "automatic", "assetsDir": null, "manualSteps": [] }
}
```

> `cleanup.assetsDir` 传 `null` 即可——`register` 会自动填成该验证的规范资产目录，供 `automatic` 清理定位删除目标。

## 示例 1：automated_script（自动脚本 + 自动清理）

```json
{
  "kind": "automated_script",
  "label": "部署后 CLI verification-state 能列出本组挂载的验证",
  "guidance": null,
  "script": { "entrypoint": "run.sh", "interpreter": "bash", "timeoutMs": 30000 },
  "cleanup": { "mode": "automatic", "assetsDir": null, "manualSteps": [] }
}
```

## 示例 2：guided_manual（引导人工 + task_detail 锚点）

```json
{
  "kind": "guided_manual",
  "label": "验证面板在真实浏览器里以脉冲高亮定位到目标任务详情",
  "guidance": {
    "steps": [
      "在验证面板里点该任务卡上的「定位并核对」",
      "应用应切到该任务的 Focus/Detail 视图",
      "目标详情容器应有蓝色脉冲高亮 ring"
    ],
    "expectedObservation": "视图切到任务详情且目标容器被高亮几秒",
    "failureSignature": "未跳转 / 未高亮 / 高亮落在错误元素上",
    "anchor": { "view": "task_detail", "anchorKey": "task-detail:<taskId>" }
  },
  "script": null,
  "cleanup": { "mode": "manual", "assetsDir": null, "manualSteps": ["无需清理（纯观察，无资产/无插桩）"] }
}
```

## 示例 3：含 repo instrumentation → 强制 manual 清理

若验证需要往已提交 repo 代码插桩，`cleanup.mode` 必须 `manual`，并用 tag 注释包裹插桩块：

```json
{
  "kind": "guided_manual",
  "label": "验证连接掉线自动续跑注入了续跑指令",
  "guidance": {
    "steps": ["制造一次连接掉线", "观察 agent 回到 idle prompt 后被注入续跑"],
    "expectedObservation": "终端出现续跑注入且引用续跑 markdown",
    "anchor": { "view": "task_detail", "anchorKey": "task-detail:<taskId>" }
  },
  "script": null,
  "cleanup": {
    "mode": "manual",
    "assetsDir": null,
    "manualSteps": [
      "grep -rn \"KANBAN-VERIFICATION-SCOPED:<verificationId>\" src",
      "删除上面 grep 命中的 -BEGIN/-END 插桩块",
      "kanban verification cleanup --verification-id <verificationId>"
    ]
  }
}
```

插桩块形如：

```ts
// KANBAN-VERIFICATION-SCOPED:<verificationId>-BEGIN
console.log("[vrf:<verificationId>] 掉线续跑探针", detail);
// KANBAN-VERIFICATION-SCOPED:<verificationId>-END
```

## 注册后

```bash
# 注册（返回每条 verificationId + assetsDir）
kanban verification register --task-id <taskId> --definition-file ./defs.json

# 把脚本 / fixture 落进返回的 assetsDir，automated 先在旧实例 dry-run
bash ~/.cline/kanban/verifications/<verificationId>/run.sh   # 允许 fail，禁 crash/超时/残留

# 自查
kanban verification list --task-id <taskId>
kanban deployment verification-state --active-only   # 部署 record 后
```
