import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const browserTestPort = Number(process.env.KANBAN_TASK_CARD_HOVER_BROWSER_TEST_PORT ?? "42983");
export default defineConfig({
	testDir: "./tests",
	testMatch: ["task-card-hover-floating-expansion.spec.ts", "cross-project-focused-task-visibility.spec.ts"],
	timeout: 30_000,
	use: { baseURL: `http://127.0.0.1:${browserTestPort}`, headless: true, screenshot: "only-on-failure", trace: "retain-on-failure" },
	webServer: {
		command: `npm run dev -- --host 127.0.0.1 --port ${browserTestPort} --strictPort`,
		cwd: dirname(fileURLToPath(import.meta.url)),
		url: `http://127.0.0.1:${browserTestPort}`,
		reuseExistingServer: false,
	},
});
