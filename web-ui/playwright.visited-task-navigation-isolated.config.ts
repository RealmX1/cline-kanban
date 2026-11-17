import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const webUiPort = Number(process.env.KANBAN_VISITED_TASK_NAVIGATION_BROWSER_TEST_PORT ?? "43927");
const artifactDirectory = join(
	process.env.KANBAN_TASK_CROSS_TASK_HANDOFF_ARTIFACT_DIRECTORY ??
		join(homedir(), ".cline", "kanban", "browser-test-artifacts"),
	"visited-task-navigation",
	createHash("sha256")
		.update(fileURLToPath(import.meta.url))
		.digest("hex")
		.slice(0, 16),
);

export default defineConfig({
	testDir: "./tests",
	testMatch: "visited-task-navigation.spec.ts",
	workers: 1,
	timeout: 30000,
	outputDir: artifactDirectory,
	use: { baseURL: `http://127.0.0.1:${webUiPort}`, headless: true, screenshot: "only-on-failure" },
	webServer: {
		command: `node --input-type=module -e 'import { createServer } from "vite"; const server = await createServer({ cacheDir: process.env.KANBAN_VISITED_TASK_NAVIGATION_VITE_CACHE_DIRECTORY, server: { host: "127.0.0.1", port: ${webUiPort}, strictPort: true, fs: { deny: [".env", ".env.*", "*.{crt,pem}"] } } }); await server.listen();'`,
		env: { KANBAN_VISITED_TASK_NAVIGATION_VITE_CACHE_DIRECTORY: `${artifactDirectory}-vite-cache` },
		cwd: dirname(fileURLToPath(import.meta.url)),
		url: `http://127.0.0.1:${webUiPort}`,
		reuseExistingServer: false,
	},
});
