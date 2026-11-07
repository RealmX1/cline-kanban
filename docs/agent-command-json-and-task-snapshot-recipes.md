# JSON读取与当前任务快照：可复用配方

先确认结果需求，再选命令。下列正文与 [离线分析工具](agent-command-usage-analysis-tool.md) 实际执行的合成配方由自动测试核对；无需每次重新写解析、异常处理和保存逻辑。它们不替代包含多来源核验、写入或业务正文生成的长脚本。

## 单个JSON的必需字段

输入是已绑定的 `./result.json`，读取必需的 `findings` 字段，输出一个JSON值。缺字段与合法null分开；null、false、0、空字符串、空对象、空数组都成功。空输入、多文档、坏JSON、错误根类型和文件缺失均非零且无stdout。排版可以变化，文件内容不变。

已安装jq且数值处于其可无损表示范围时：

```sh
jq -cs 'if length==1 and (.[0]|has("findings")) then .[0].findings else error("缺字段或非单个对象") end' -- ./result.json
```

只需JSON值时不要加 `-e`：它会把合法false/null当作失败；不要用 `//` 默认值抹去false和null。`-s` 先读完文件再验证单个文档，避免坏的后半段或多文档造成部分成功输出。字段名是明确编写的配方，不拼接输入正文为程序。

没有jq或需要Python整数精度时，直接用标准库：

```sh
python3 -c 'import json;print(json.dumps(json.load(open("./result.json",encoding="utf-8"))["findings"],ensure_ascii=False))'
```

输入路径有空格时保留引号；jq路径用 `--` 分隔。本配方以UTF-8和标准JSON值为前提，不是任意编码、极深对象或非标准数字的统一校验器。大整数、数字原始拼写必须保真时使用Python并核对实际输出需求，不从jq字符更短推断其适用性。

## 当前任务的完整私有快照

仅查看当前任务时，直接运行 `"$KANBAN_RUNTIME_BOUND_CLI_EXECUTABLE_PATH" task get-current-task`。需要保留完整结果时，在当前用户控制、没有并发写入的私有目录执行下面的固定配方。目标是该目录中的 `task-snapshot.json`；不会自动创建目录或改查其他任务。

```sh
(
set -eu
: "${KANBAN_RUNTIME_BOUND_CLI_EXECUTABLE_PATH:?}" "${KANBAN_TASK_ID:?}" "${KANBAN_PROJECT_PATH:?}" "${KANBAN_TASK_CONVERSATION_SESSION_ID:?}"
if [ -L ./task-snapshot.json ] || { [ -e ./task-snapshot.json ] && [ ! -f ./task-snapshot.json ]; }; then
  exit 1
fi
umask 077
snapshot_candidate=$(mktemp ./task-snapshot.XXXXXX)
trap 'rm -f "$snapshot_candidate"' 0
trap 'exit 1' HUP INT TERM
"$KANBAN_RUNTIME_BOUND_CLI_EXECUTABLE_PATH" task get-current-task > "$snapshot_candidate"
jq -se --arg task "$KANBAN_TASK_ID" --arg project "$KANBAN_PROJECT_PATH" '
  length == 1 and (.[0] | .ok == true and .workspacePath == $project and
    .task.id == $task and (.task.title | type) == "string")
' "$snapshot_candidate" >/dev/null
mv -f "$snapshot_candidate" ./task-snapshot.json
)
```

需要POSIX shell、jq、mktemp、mv、rm和可用的运行时绑定入口。三个身份变量必须来自已核对的会话环境，项目是注册主仓库路径；会话归属由原生 `get-current-task` 校验，不能拿返回的主会话摘要替代协作会话身份。切换cwd不改变任务绑定。查询或校验失败时不会切换到显式其他任务，也不会继续处理旧快照并冒充新结果。

成功保留原始完整JSON字节，暂存文件与最终文件均为600；已有文件即使原为644，成功替换后也变为600。查询、坏JSON、身份不符、创建暂存或替换失败时非零，旧文件及其权限不变。普通symlink、悬空symlink与目录目标均拒绝。读取所需字段可在本配方成功后另行执行，不以字段裁剪后的JSON冒充完整快照。

同目录替换保证读者不会看到半个文件；本配方不做fsync，不承诺断电后的磁盘持久性，也不协调并发写入者。可处理信号会清理暂存；SIGKILL或断电可能留下600暂存文件。恢复时先核对目标和文件归属，只清理确认属于本次的暂存，再重跑只读查询；不能把任意暂存提升成已完成快照。

## 同一任务中重复使用

将完整快照配方一次性保存到本任务持久交接目录下的 `save-bound-current-task-snapshot.sh`，文件权限设为600。之后在目标私有目录执行该**已核对的精确路径**；以下相对路径调用以脚本就在当前目录为前提：

```sh
sh ./save-bound-current-task-snapshot.sh
```

首次成本包含完整脚本正文及调用，通常大于直接内联；只有后续复用才减少重新撰写的字符。自动对照同时执行内联与落盘版本，分别记录首次输入文件成本和复用成本；没有把准备文件隐藏掉。脚本改变后重新核验，不沿用旧摘要。跨目录调用要计入实际路径长度，复制、转义和模型工具调用成本不可得时仍为unknown。

## 对照与适用性

从 [原npm入口](agent-command-usage-analysis-tool.md#单一入口) 使用合成清单即可重放。`goal-recipe-comparison-results.json` 保留两份历史契约，并新增必需JSON字段与会话绑定完整快照的独立契约；历史快照成功不自动满足新契约。各配方只有实际完成全部声明场景后才标等价，缺工具保留null，不自动安装。

JSON检查覆盖值的类型、空输入、多文档、坏JSON及输入只读。快照检查覆盖新建、原文件替换、错误任务/项目/会话、部分查询失败、符号链接、目录、写入阶段故障注入和查询进程终止；替换前后的文件身份用于核对原子替换。故障注入证明错误传播，不宣称覆盖所有文件系统或断电故障。

`jq -e` 的短配方、直接重定向覆盖旧快照、按字节切Unicode和用latest替代精确证据继续作为拒绝反例。生产token、耗时、首次成功率和真实准备成本尚未证明；合成长度变化只能说明这份结果契约下的配方负担。
