#!/usr/bin/env node
// 仅模拟原生 CLI 的进程/Unix socket 契约；不读取凭据、不执行 hook、不调用模型。
const { appendFileSync } = require("node:fs");
const { createServer } = require("node:http");
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
   const { WebSocketServer } = require(process.env.KANBAN_TEST_NATIVE_CONTROL_WS_MODULE_PATH);
   const server = createServer();
   const sockets = new WebSocketServer({ server });
   const threads = new Map();
   sockets.on("connection", socket => socket.on("message", bytes => {
    const request = JSON.parse(bytes.toString());
    if (request.id === undefined) return;
    appendFileSync(join(process.env.KANBAN_TEST_NATIVE_CONTROL_RECORDS_DIRECTORY, "native-requests.jsonl"), JSON.stringify({ taskId: process.env.KANBAN_TASK_ID, method: request.method, params: request.params }) + "\n");
    const params = request.params || {};
    if (mode === "stalled-resume" && request.method === "thread/resume") return;
    let result = {};
    if (request.method === "config/read") result = { config: { model_provider: "openai" } };
    if (request.method === "thread/list") result = { data: mode === "no-resume-candidate" ? [] : [{ id: "latest-native-id" }], nextCursor: null };
    if (request.method === "thread/resume" || request.method === "thread/fork") {
     const id = request.method === "thread/fork" ? "fork-" + params.threadId : params.threadId;
     if (!threads.has(id)) threads.set(id, {
      thread: { id, cwd: process.cwd(), path: join(process.cwd(), id + ".jsonl") },
      approvalPolicy: params.approvalPolicy || "never",
      sandbox: { type: mode === "refused-permissions" ? "dangerFullAccess" : ({ "read-only": "readOnly", "workspace-write": "workspaceWrite", "danger-full-access": "dangerFullAccess" })[params.sandbox] || "readOnly" },
      approvalsReviewer: params.approvalsReviewer || "user",
     });
     result = threads.get(id);
    }
    if (request.method === "thread/settings/update") {
     const thread = threads.get(params.threadId);
     if (params.approvalPolicy) thread.approvalPolicy = params.approvalPolicy;
     if (params.sandboxPolicy && mode !== "refused-permissions") thread.sandbox = params.sandboxPolicy;
    }
    socket.send(JSON.stringify({ id: request.id, result }));
   }));
   server.listen(socketPath);
   const stop = () => { if (mode !== "children-ignore-stop-signals") { for (const socket of sockets.clients) socket.terminate(); server.close(); } };
   process.on("SIGTERM", stop);
   process.on("SIGINT", stop);
   if (mode === "server-active-failure") setTimeout(stop, 700);
  }
 } else if ((args.includes("resume") || args.includes("fork")) && args.some(arg => arg === "--dangerously-bypass-approvals-and-sandbox" || arg === "--sandbox" || arg === "--ask-for-approval")) {
  process.stderr.write("Error: Permission overrides are not supported when resuming a remote task.\n");
  process.exitCode = 1;
 } else if (mode === "tui-failure") process.exitCode = 7;
 else {
  process.stdout.write("SYNTHETIC_CODEX_TUI_READY\n");
  const keepAlive = setInterval(() => {}, 1000);
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => { if (mode !== "children-ignore-stop-signals") clearInterval(keepAlive); });
 }
}
