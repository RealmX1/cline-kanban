import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const nonModalFloatingFormBrowserTestPort = Number(process.env.KANBAN_NON_MODAL_FLOATING_FORM_BROWSER_PORT ?? "42985");
const nonModalFloatingFormBrowserArtifactDirectory = join(
	process.env.KANBAN_TASK_CROSS_TASK_HANDOFF_ARTIFACT_DIRECTORY ??
		join(homedir(), ".cline", "kanban", "browser-test-artifacts"),
	"non-modal-floating-form-windows",
	createHash("sha256")
		.update(fileURLToPath(import.meta.url))
		.digest("hex")
		.slice(0, 16),
);
export default defineConfig({
	testDir: "./tests",
	testMatch: "non-modal-floating-form-windows.spec.ts",
	timeout: 30000,
	workers: 1,
	outputDir: nonModalFloatingFormBrowserArtifactDirectory,
	use: {
		baseURL: `http://127.0.0.1:${nonModalFloatingFormBrowserTestPort}`,
		headless: true,
		screenshot: "only-on-failure",
	},
	webServer: {
		command: `npm run dev -- --host 127.0.0.1 --port ${nonModalFloatingFormBrowserTestPort} --strictPort`,
		cwd: dirname(fileURLToPath(import.meta.url)),
		url: `http://127.0.0.1:${nonModalFloatingFormBrowserTestPort}`,
		reuseExistingServer: false,
	},
});
