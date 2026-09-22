import { homedir } from "node:os";
import { join } from "node:path";

// 独立于 workspace 状态加载，供 worker、凭据和诊断等运行时基础服务复用。
export function getRuntimeHomePath(): string {
	return join(homedir(), ".cline", "kanban");
}
