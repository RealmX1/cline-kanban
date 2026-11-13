import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import baseConfig from "./playwright.config";

const webUiPort = Number(process.env.KANBAN_PLAYWRIGHT_WEB_UI_PORT ?? "45783");
const webUiBaseUrl = `http://127.0.0.1:${webUiPort}`;

// defineConfig(base, override) 会把两侧 webServer 追加成数组，而不是替换。
// 动态端口下两边 URL 相同且都不复用已有服务器，第二个启动就会报 already used。
export default defineConfig({
	...baseConfig,
	testMatch: "single-project-mobile-home.spec.ts",
	workers: 1,
	outputDir: "test-results/single-project-mobile-home",
	use: { ...baseConfig.use, baseURL: webUiBaseUrl, actionTimeout: 5000 },
	webServer: {
		// 任务依赖可能指向共享 node_modules，Vite 优化缓存必须留在当前 checkout。
		command: `node --input-type=module -e 'import { createServer } from "vite"; const server = await createServer({ cacheDir: "../.cache/single-project-mobile-home-playwright-vite", server: { host: "127.0.0.1", port: ${webUiPort}, strictPort: true } }); await server.listen();'`,
		cwd: dirname(fileURLToPath(import.meta.url)),
		url: webUiBaseUrl,
		reuseExistingServer: false,
	},
});
