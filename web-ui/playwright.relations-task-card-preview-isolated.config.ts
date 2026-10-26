import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const previewBrowserTestPort = Number(process.env.KANBAN_RELATIONS_TASK_PREVIEW_BROWSER_TEST_PORT ?? "42981");
export default defineConfig({
	testDir: "./tests",
	testMatch: ["relations-task-card-preview.spec.ts", "related-task-preview.spec.ts"],
	timeout: 30_000,
	use: {
		baseURL: `http://127.0.0.1:${previewBrowserTestPort}`,
		headless: true,
		screenshot: "only-on-failure",
		trace: "retain-on-failure",
	},
	webServer: {
		command: `npm run dev -- --host 127.0.0.1 --port ${previewBrowserTestPort} --strictPort`,
		cwd: dirname(fileURLToPath(import.meta.url)),
		url: `http://127.0.0.1:${previewBrowserTestPort}`,
		reuseExistingServer: false,
	},
});
