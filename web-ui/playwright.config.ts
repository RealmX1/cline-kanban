import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const currentDir = dirname(fileURLToPath(import.meta.url));

const webUiPort = Number(process.env.KANBAN_PLAYWRIGHT_WEB_UI_PORT ?? "4173");
const webUiBaseUrl = `http://127.0.0.1:${webUiPort}`;

export default defineConfig({
	testDir: "./tests",
	timeout: 30_000,
	use: {
		baseURL: webUiBaseUrl,
		headless: true,
	},
	webServer: {
		command: `npm run dev -- --host 127.0.0.1 --port ${webUiPort}`,
		cwd: currentDir,
		url: webUiBaseUrl,
		reuseExistingServer: !process.env.CI && !process.env.KANBAN_PLAYWRIGHT_WEB_UI_PORT,
	},
});
