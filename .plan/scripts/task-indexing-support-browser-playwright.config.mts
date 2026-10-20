import { defineConfig } from "../../web-ui/node_modules/@playwright/test/index.mjs";

export default defineConfig({
	testDir: "../../web-ui/tests",
	testMatch: "task-indexing-support-relation-suggestions.spec.ts",
	timeout: 30000,
	workers: 1,
	outputDir: "/Users/bominzhang/.cline/kanban/cross-task-handoff-artifacts/task-a0401-shared-task-indexing-agent/browser-evidence",
	use: { baseURL: "http://127.0.0.1:54173", channel: "chrome", headless: true, viewport: { width: 1440, height: 1000 } },
});
