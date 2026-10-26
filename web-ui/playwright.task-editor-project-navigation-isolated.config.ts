import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const taskEditorProjectNavigationBrowserPort = Number(process.env.KANBAN_TASK_EDITOR_PROJECT_NAVIGATION_BROWSER_PORT ?? "42981");
export default defineConfig({
	testDir: "./tests",
	testMatch: "task-editor-project-navigation-session-preservation.spec.ts",
	timeout: 30000,
	workers: 1,
	use: { baseURL: `http://127.0.0.1:${taskEditorProjectNavigationBrowserPort}`, headless: true, viewport: { width: 1440, height: 1000 } },
	webServer: {
		command: `npm run dev -- --host 127.0.0.1 --port ${taskEditorProjectNavigationBrowserPort} --strictPort`,
		cwd: dirname(fileURLToPath(import.meta.url)),
		url: `http://127.0.0.1:${taskEditorProjectNavigationBrowserPort}`,
		reuseExistingServer: false,
	},
});
