import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const taskEditorBrowserTestPort = Number(process.env.KANBAN_TASK_EDITOR_BROWSER_TEST_PORT ?? "42973");
export default defineConfig({
	testDir:"./tests",testMatch:"task-editor-floating-window.spec.ts",timeout:30000,
	use:{baseURL:`http://127.0.0.1:${taskEditorBrowserTestPort}`,headless:true},
	webServer:{
		command:`npm run dev -- --host 127.0.0.1 --port ${taskEditorBrowserTestPort} --strictPort`,
		cwd:dirname(fileURLToPath(import.meta.url)),url:`http://127.0.0.1:${taskEditorBrowserTestPort}`,reuseExistingServer:false,
	},
});
