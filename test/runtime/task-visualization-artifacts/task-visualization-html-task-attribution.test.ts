import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	applyTaskAttributionToHtmlFile,
	renderHtmlWithTaskAttribution,
} from "../../../src/task-visualization-artifacts/task-visualization-html-task-attribution";

const attribution = { workspaceId: "workspace-a", taskId: "491af", taskTitle: '任务名 <script> & 引号"' };
const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

it.each([
	'<!doctype html><html><head><title>图表标题</title><script>const example="<body>";</script></head><body><main>图表</main></body></html>',
	"<h1>图表片段</h1><img src='../assets/chart.png'>",
	"<!doctype html><html><head><style>body{margin:0}</style></head></html>",
])("HTML 署名保留原始内容和路径，重复执行完全幂等：%s", (html) => {
	const attributed = renderHtmlWithTaskAttribution(html, attribution);
	expect(attributed).toContain('data-kanban-task-attribution="v1"');
	expect(attributed).toContain("491af");
	expect(attributed).toContain("任务名 &lt;script&gt; &amp; 引号&quot;");
	expect(attributed).not.toContain(attribution.taskTitle);
	expect(renderHtmlWithTaskAttribution(attributed, attribution)).toBe(attributed);
	if (html.includes("<body>"))
		expect(attributed.indexOf('data-kanban-task-attribution="v1"')).toBeGreaterThan(attributed.indexOf("</head>"));
	if (html.includes("chart.png")) expect(attributed).toContain("src='../assets/chart.png'");
	if (html.startsWith("<!doctype")) expect(attributed).toMatch(/^<!doctype html>/u);
});

it("改名只替换现有署名；脚本里的标签样文本不被误改", () => {
	const html =
		"<body><script>const example='<aside data-kanban-task-attribution=\"v1\">例子</aside>';</script><h1>图</h1></body>";
	const first = renderHtmlWithTaskAttribution(html, attribution);
	const renamed = renderHtmlWithTaskAttribution(first, { ...attribution, taskTitle: "新的任务名" });
	expect(renamed).toContain("新的任务名");
	expect(renamed).not.toContain("任务名 &lt;script&gt;");
	expect(renamed).toContain("const example=");
	expect(renamed).toContain(">例子</aside>");
	expect(renderHtmlWithTaskAttribution(renamed, { ...attribution, taskTitle: "新的任务名" })).toBe(renamed);
});

it("嵌套与并列的旧署名只删除各区间的并集，后续正文和脚本逐字保留", () => {
	const remainingContent = '<main>KEEP</main><script>globalThis.ready=true</script><img src="assets/chart.png">';
	const previousAttribution = '<aside data-kanban-task-attribution="v1">';
	const html = `<body>${previousAttribution}外层${previousAttribution}内层</aside></aside>${previousAttribution}并列</aside>${remainingContent}</body>`;
	const attributed = renderHtmlWithTaskAttribution(html, attribution);
	expect(attributed).toContain(`${remainingContent}</body>`);
	expect(attributed.match(/data-kanban-task-attribution="v1"/gu)).toHaveLength(1);
	expect(attributed).not.toContain("外层");
	expect(attributed).not.toContain("内层");
	expect(attributed).not.toContain("并列");
	expect(renderHtmlWithTaskAttribution(attributed, attribution)).toBe(attributed);
	const renamedAttribution = { ...attribution, taskTitle: "已改名" };
	const renamed = renderHtmlWithTaskAttribution(attributed, renamedAttribution);
	expect(renamed).toContain(`${remainingContent}</body>`);
	expect(renamed.match(/data-kanban-task-attribution="v1"/gu)).toHaveLength(1);
	expect(renderHtmlWithTaskAttribution(renamed, renamedAttribution)).toBe(renamed);
});

it("本地文件原子署名后可离线读取，再次调用不产生更新", async () => {
	const directory = await mkdtemp(join(tmpdir(), "task-visualization-local-attribution-"));
	directories.push(directory);
	const file = join(directory, "chart.html");
	await writeFile(file, "<!doctype html><body><h1>离线图表</h1></body>", { mode: 0o600 });
	expect(await applyTaskAttributionToHtmlFile(file, attribution)).toMatchObject({ didUpdateHtml: true });
	const saved = await readFile(file, "utf8");
	expect(saved).toContain("491af");
	expect(saved).toContain("离线图表");
	expect((await stat(file)).mode & 0o777).toBe(0o600);
	expect(await applyTaskAttributionToHtmlFile(file, attribution)).toMatchObject({ didUpdateHtml: false });
	expect(await readFile(file, "utf8")).toBe(saved);
});
