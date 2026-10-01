import { join } from "node:path";
import { buildKanbanCommandParts } from "../core/kanban-command";
import { lockedFileSystem } from "../fs/locked-file-system";

// 独立扩展只报告当前原生身份；现有 OSC 标题仍负责回合状态。
export async function writeOmpNativeConversationSessionIdentityExtension(directory: string): Promise<string> {
	const extensionPath = join(directory, "kanban-native-conversation-session-identity.mjs");
	const commandParts = buildKanbanCommandParts([
		"hooks",
		"ingest",
		"--event",
		"agent_conversation_session_identity_observed",
		"--source",
		"omp",
	]);
	const source = `import { spawn } from "node:child_process";
export default function registerNativeConversationSessionIdentity(extensionApi) {
 for (const eventName of ["session_start", "session_switch", "session_branch"]) {
  extensionApi.on(eventName, async (_event, context) => {
   const payload = JSON.stringify({
    hook_event_name: eventName,
    session_id: context.sessionManager.getSessionId(),
    transcript_path: context.sessionManager.getSessionFile(),
   });
   const [binary, ...args] = ${JSON.stringify(commandParts)};
   await new Promise((resolve) => {
    const child = spawn(binary, args, { stdio: ["pipe", "ignore", "pipe"], timeout: 10000 });
    child.stdin.on("error", () => {});
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.once("error", (error) => { process.stderr.write("Kanban identity hook: " + error.message + "\\n"); resolve(); });
    child.once("close", () => resolve());
    child.stdin.end(payload);
   });
  });
 }
}
`;
	await lockedFileSystem.writeTextFileAtomic(extensionPath, source);
	return extensionPath;
}
