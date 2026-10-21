import { fileURLToPath } from "node:url";
import { defineConfig } from "../../web-ui/node_modules/@playwright/test/index.mjs";

export default defineConfig({
	testDir: "../../web-ui/tests", testMatch: "task-lookup-workbench.spec.ts", timeout: 45000, workers: 1,
	outputDir: process.env.KANBAN_TASK_LOOKUP_BROWSER_EVIDENCE_DIRECTORY ?? "/Users/bominzhang/.cline/kanban/cross-task-handoff-artifacts/task-3346b-task-lookup-workbench/browser-evidence",
	use: { baseURL: "http://127.0.0.1:54174", channel: "chrome", headless: true, viewport: { width: 1440, height: 1000 } },
	webServer: { command: "node node_modules/vite/bin/vite.js --config vite.config.ts --host 127.0.0.1 --port 54174 --strictPort", url: "http://127.0.0.1:54174", cwd: fileURLToPath(new URL("../../web-ui/", import.meta.url)), reuseExistingServer: false },
});
