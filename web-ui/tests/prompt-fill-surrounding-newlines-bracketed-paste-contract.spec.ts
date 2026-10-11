import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { Terminal } from "@xterm/xterm";

// 组件测试验证 Fill 的正文；这里用真实浏览器和项目实际依赖的 xterm 验证传输契约：
// 前后换行必须全部留在 bracketed paste 之内，结束标记后不能带提交键。
const currentDirectory = dirname(fileURLToPath(import.meta.url));

interface BrowserTerminalPasteProbe {
	Terminal: new () => Terminal;
}

test("填入提示词的首尾换行全部位于粘贴帧内，连续粘贴不追加提交键", async ({ page }) => {
	await page.setContent('<div id="terminal-paste-contract-probe"></div>');
	await page.addScriptTag({ path: resolve(currentDirectory, "../node_modules/@xterm/xterm/lib/xterm.js") });
	const pastedFrames = await page.evaluate(async () => {
		const terminal = new (window as unknown as BrowserTerminalPasteProbe).Terminal();
		const container = document.getElementById("terminal-paste-contract-probe");
		if (!container) {
			throw new Error("Missing terminal paste probe container");
		}
		terminal.open(container);
		try {
			await new Promise<void>((resolveWrite) => terminal.write("\x1b[?2004h", resolveWrite));
			const frames: string[] = [];
			terminal.onData((text) => frames.push(text));
			terminal.paste("\n第一行\n第二行\n");
			terminal.paste("\n\n保留原文换行\n\n");
			return frames;
		} finally {
			terminal.dispose();
		}
	});
	expect(pastedFrames).toEqual(["\x1b[200~\r第一行\r第二行\r\x1b[201~", "\x1b[200~\r\r保留原文换行\r\r\x1b[201~"]);
});
