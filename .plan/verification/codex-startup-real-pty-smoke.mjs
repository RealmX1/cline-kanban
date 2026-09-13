// 执行：CODEX_VERIFICATION_MODEL=<本机可用模型> node --import tsx .plan/verification/codex-startup-real-pty-smoke.mjs
// 加 --long 验证原生长粘贴折叠；加 --default 验证普通 argv 首发。
// 加 --terminal-protocol-replies 验证浏览器协议回送不会取消首发。
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { TerminalSessionManager } from "../../src/terminal/session-manager.ts";

const model = process.env.CODEX_VERIFICATION_MODEL;
if (!model) throw new Error("请通过 CODEX_VERIFICATION_MODEL 指定当前账号可用的模型");
const originalCodexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
const isolatedRoot = await mkdtemp(join(tmpdir(), "ea84e-codex-first-message-verification-"));
const isolatedCodexHome = join(isolatedRoot, ".codex");
const executionDirectory = join(isolatedRoot, "verification-workspace");
const startInPlanMode = !process.argv.includes("--default");
const marker = "STARTUP_SUBMIT_EA84E_OK";
const prompt = `仅回复 ${marker}。不要调用工具、访问文件或执行其他操作。\n${process.argv.includes("--long") ? "中文多行输入完整性检查😀。\n".repeat(100) : ""}仅回复 ${marker}。`;
const manager = new TerminalSessionManager();
const taskId = "ea84e-isolated-codex-first-message-verification";

try {
  await mkdir(isolatedCodexHome);
  await mkdir(executionDirectory);
  await copyFile(join(originalCodexHome, "auth.json"), join(isolatedCodexHome, "auth.json"));
  await copyFile(join(originalCodexHome, "models_cache.json"), join(isolatedCodexHome, "models_cache.json")).catch(() => {});
  await writeFile(join(isolatedCodexHome, "config.toml"), `model = ${JSON.stringify(model)}\nmodel_reasoning_effort = "low"\ncheck_for_update_on_startup = false\n`);
  process.env.HOME = isolatedRoot;
  process.env.CODEX_HOME = isolatedCodexHome;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("KANBAN_") || key.startsWith("CLINE_KANBAN_")) delete process.env[key];
  }
  await manager.startTaskSession({
    taskId, agentId: "codex", binary: process.env.CODEX_VERIFICATION_BINARY || "codex",
    args: ["--sandbox", "read-only", "--ask-for-approval", "never"],
    taskAgentPermissionMode: "ask_for_every_tool_use", cwd: executionDirectory, prompt,
    startInPlanMode, autoContinueOnConnectionDropEnabled: false,
  });
  if (process.argv.includes("--terminal-protocol-replies")) {
    manager.writeInput(taskId, Buffer.from("\u001b[1;1R\u001b[?1;2c\u001b[I\u001b[O"));
  }
  const deadline = Date.now() + 100000;
  let receivedResponse = false;
  while (Date.now() < deadline) {
    const paths = await readdir(join(isolatedCodexHome, "sessions"), { recursive: true }).catch(() => []);
    for (const path of paths.filter(path => path.endsWith(".jsonl"))) {
      const records = (await readFile(join(isolatedCodexHome, "sessions", path), "utf8"))
        .split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      const userMessages = records.filter(record => record.type === "response_item" && record.payload?.role === "user" && JSON.stringify(record.payload.content).includes(marker));
      const responded = records.some(record => record.type === "response_item" && record.payload?.role === "assistant" && JSON.stringify(record.payload.content).includes(marker));
      if (!responded) continue;
      if (userMessages.length !== 1) throw new Error(`原生转录的用户消息数量为 ${userMessages.length}`);
      if (userMessages[0].payload.content.map(item => item.text || "").join("") !== prompt) throw new Error("原始正文未完整送达或包含残留 /plan 命令");
      const modes = records.filter(record => record.type === "turn_context").map(record => record.payload?.collaboration_mode?.mode);
      if (!modes.length || modes.some(mode => mode !== (startInPlanMode ? "plan" : "default"))) throw new Error("原生首轮模式与所选模式不符");
      console.log(JSON.stringify({ passed: true, nativeSessionId: records.find(record => record.type === "session_meta")?.payload?.id, userMessages: 1, modes, promptCharacters: Array.from(prompt).length }));
      receivedResponse = true;
      break;
    }
    if (receivedResponse) break;
    await delay(500);
  }
  if (!receivedResponse) throw new Error("100 秒内未观察到原生转录的目标回复");
} finally {
  await manager.forceStopTaskSession(taskId, 2000);
  manager.dispose();
  await rm(isolatedRoot, { recursive: true, force: true });
  console.log(JSON.stringify({ cleaned: true }));
}
