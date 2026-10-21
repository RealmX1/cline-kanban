import { join } from "node:path";
import { lockedFileSystem } from "../fs/locked-file-system";

// OMP 的默认 Plan 起步跳过已有历史，ACP set_mode 也不写 mode_change。
// 已核对的 OMP runner 把原生 SessionManager 实例作为 context.sessionManager 传入；
// 在 TUI 恢复模式之前，使用其公开的 appendModeChange/flush 给本子会话落盘。
// 若后续 OMP 改为真正的只读代理，则明确退出，避免静默按可写模式投递首条消息。
export async function writeOmpTaskCollaboratorForkInitialPlanModeExtension(input: {
	directory: string;
	taskId: string;
	sourceNativeSessionId: string;
}): Promise<string> {
	const extensionPath = join(input.directory, `${encodeURIComponent(input.taskId)}.fork-initial-plan-mode.mjs`);
	const source = String.raw`export default function registerTaskCollaboratorForkInitialPlanMode(extensionApi) {
 let initialized = false;
 extensionApi.on("session_start", async (_event, context) => {
  if (initialized) return;
  initialized = true;
  try {
   const manager = context.sessionManager;
   if (manager.getSessionId() === ${JSON.stringify(input.sourceNativeSessionId)} ||
       typeof manager.appendModeChange !== "function" || typeof manager.flush !== "function") {
    throw new Error("OMP 未提供独立且可持久化 Plan 状态的子会话");
   }
   manager.appendModeChange("plan");
   await manager.flush();
  } catch (error) {
   process.stderr.write("Kanban 协作 fork 的 Plan 初始化失败：" + String(error) + "\n");
   process.exit(1);
  }
 });
}
`;
	await lockedFileSystem.writeTextFileAtomic(extensionPath, source);
	return extensionPath;
}
