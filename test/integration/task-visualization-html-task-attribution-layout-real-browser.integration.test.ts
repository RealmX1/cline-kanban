import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { renderHtmlWithTaskAttribution } from "../../src/task-visualization-artifacts/task-visualization-html-task-attribution";
import type { BrowserType } from "../../web-ui/node_modules/playwright-core";

const runBrowserCheck = process.env.KANBAN_RUN_HTML_TASK_ATTRIBUTION_LAYOUT_BROWSER_CHECK === "1";

it.skipIf(!runBrowserCheck).each(["grid", "flex"])(
	"HTML 自动署名保持 body %s 布局、可访问名称、脚本与原页面按钮",
	async (layout) => {
		const require = createRequire(import.meta.url);
		const { chromium } = require("../../web-ui/node_modules/playwright-core") as { chromium: BrowserType };
		const browser = await chromium.launch({ headless: true });
		try {
			const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
			const html = `<!doctype html><style>body{margin:0;display:${layout};${layout === "grid" ? "grid-template-columns:200px 1fr;" : ""}height:100vh;overflow:hidden}nav{width:200px;flex-shrink:0}main{flex:1}button{position:fixed;right:20px;bottom:20px}</style><body><nav>导航</nav><main>KEEP<button onclick="this.textContent='已点击'">原页面按钮</button></main><script>globalThis.ready=true</script></body>`;
			await page.setContent(html);
			const originalNavigationGeometry = await page.locator("nav").boundingBox();
			const originalMainGeometry = await page.locator("main").boundingBox();
			await page.setContent(
				renderHtmlWithTaskAttribution(html, {
					workspaceId: "isolated-workspace",
					taskId: "491af",
					taskTitle: "隔离布局验证",
				}),
			);
			expect(await page.locator("nav").boundingBox()).toEqual(originalNavigationGeometry);
			expect(await page.locator("main").boundingBox()).toEqual(originalMainGeometry);
			expect(await page.getByRole("complementary", { name: "可视化任务署名" }).isVisible()).toBe(true);
			expect(await page.evaluate("globalThis.ready")).toBe(true);
			await page.getByRole("button", { name: "原页面按钮" }).click();
			expect(await page.getByRole("button").textContent()).toBe("已点击");
		} finally {
			await browser.close();
		}
	},
);
