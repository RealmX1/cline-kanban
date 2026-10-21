#!/usr/bin/env node
// 仅模拟原生 CLI 的进程/Unix socket 契约；不读取凭据、不执行 hook、不调用模型。
const { appendFileSync } = require("node:fs");
const { createServer } = require("node:net");
const { join } = require("node:path");
const args = process.argv.slice(2);
if (args.includes("--version") || args.includes("-V")) {
 process.stdout.write("codex-cli 0.163.0\n");
} else if (args.includes("--help")) {
 process.stdout.write(args.includes("app-server") ? "--listen unix://PATH\n" : "--remote unix://PATH\n");
} else {
 const kind = args.includes("app-server") ? "server" : "tui";
 const recordsPath = join(process.env.KANBAN_TEST_NATIVE_CONTROL_RECORDS_DIRECTORY, "process-observations.jsonl");
 appendFileSync(recordsPath, JSON.stringify({ kind, pid: process.pid, args, taskId: process.env.KANBAN_TASK_ID, hookTaskId: process.env.KANBAN_HOOK_TASK_ID }) + "\n");
 const mode = process.env.KANBAN_TEST_NATIVE_CONTROL_FAILURE_MODE;
 if (kind === "server") {
  if (mode === "server-startup-failure") process.exitCode = 9;
  else {
   const socketPath = args[args.indexOf("--listen") + 1].slice("unix://".length);
   const server = createServer(socket => socket.destroy());
   server.listen(socketPath);
   const stop = () => { if (mode !== "children-ignore-stop-signals") server.close(); };
   process.on("SIGTERM", stop);
   process.on("SIGINT", stop);
   if (mode === "server-active-failure") setTimeout(stop, 700);
  }
 } else if (mode === "tui-failure") process.exitCode = 7;
 else {
  process.stdout.write("SYNTHETIC_CODEX_TUI_READY\n");
  const keepAlive = setInterval(() => {}, 1000);
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => { if (mode !== "children-ignore-stop-signals") clearInterval(keepAlive); });
 }
}
