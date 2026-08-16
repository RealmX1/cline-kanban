import { tmpdir } from "node:os";
import { join } from "node:path";

import { DIAGNOSTIC_EVENT_JOURNAL_ROOT_DIR_ENV_VAR } from "../src/diagnostics/rotating-jsonl-diagnostic-event-journal";

// 测试进程绝不能往用户真实的 ~/.cline 运行目录写诊断事件。诊断 journal 正是排障时要读的数据，
// 混进测试产生的伪记录（cwd=/repo 之类的假仓库路径）会直接误导事后分析。
// 固定路径而非 mkdtemp：journal 自带轮转与保留上限，复用同一目录不会无限增长，也不会在
// /tmp 下堆出成百上千个空目录。
process.env[DIAGNOSTIC_EVENT_JOURNAL_ROOT_DIR_ENV_VAR] = join(tmpdir(), "kanban-test-diagnostic-event-journals");
