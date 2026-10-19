import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeOmpTaskCollaboratorForkInitialPlanModeExtension } from "../../../src/terminal/omp-task-collaborator-fork-initial-plan-mode-extension";

let directory: string | undefined;
afterEach(() => {
	if (directory) rmSync(directory, { recursive: true, force: true });
});
describe("OMP 协作 fork 的原生 Plan 模式记录", () => {
	it.each(["independent-child", "parent-native", "unsupported-writer"])(
		"只对可持久化的独立子会话初始化：%s",
		async (nativeId) => {
			directory = mkdtempSync(join(tmpdir(), "kanban-omp-fork-plan-extension-"));
			const filename = await writeOmpTaskCollaboratorForkInitialPlanModeExtension({
				directory,
				taskId: "child",
				sourceNativeSessionId: "parent-native",
			});
			const handlers = new Map<string, (event: unknown, context: unknown) => Promise<void>>();
			const appendModeChange = vi.fn();
			const flush = vi.fn(async () => {});
			const exit = vi.fn(() => {
				throw new Error("原生进程已停止");
			});
			runInNewContext(
				`${readFileSync(filename, "utf8").replace("export default ", "")}\nregisterTaskCollaboratorForkInitialPlanMode(extensionApi);`,
				{
					extensionApi: {
						on: (event: string, handler: (event: unknown, context: unknown) => Promise<void>) =>
							handlers.set(event, handler),
					},
					process: { stderr: { write: vi.fn() }, exit },
				},
			);
			const handler = handlers.get("session_start");
			if (!handler) throw new Error("未注册启动处理器");
			const context = {
				sessionManager: {
					getSessionId: () => nativeId,
					appendModeChange: nativeId === "unsupported-writer" ? undefined : appendModeChange,
					flush,
				},
			};
			if (nativeId === "independent-child") {
				await handler({}, context);
				await handler({}, context);
				expect(appendModeChange).toHaveBeenCalledExactlyOnceWith("plan");
				expect(flush).toHaveBeenCalledTimes(1);
				expect(exit).not.toHaveBeenCalled();
			} else {
				await expect(handler({}, context)).rejects.toThrow("原生进程已停止");
				expect(appendModeChange).not.toHaveBeenCalled();
				expect(flush).not.toHaveBeenCalled();
				expect(exit).toHaveBeenCalledWith(1);
			}
		},
	);
});
