import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

test("Kimi 清历史与重连恢复在浏览器不累积旧打印，可靠接受后确认标签消失", async ({ page }) => {
	await page.route("**/api/**", (route) => route.abort());
	await page.route("**/isolated-kimi-terminal-redraw", (route) =>
		route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body></body></html>" }),
	);
	await page.goto("/isolated-kimi-terminal-redraw");
	await page.addScriptTag({
		type: "module",
		content:
			"import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;",
	});
	await page.addScriptTag({ type: "module", url: "/tests/kimi-terminal-redraw-browser-harness.tsx" });
	await page.waitForFunction(() => Boolean(window.kimiTerminalRedrawHarness));
	const history = Array.from({ length: 70 }, (_, index) => `kimi-browser-history-${index}`).join("\r\n");
	for (let repaint = 0; repaint < 4; repaint += 1) {
		await page.evaluate(async (historyText) => {
			await window.kimiTerminalRedrawHarness.write("\u001b[?2026h\u001b[2J\u001b[H\u001b[");
			await window.kimiTerminalRedrawHarness.write(`3J${historyText}\r\ncomposer\u001b[?2026l`);
		}, history);
		expect(
			await page.evaluate(
				() => window.kimiTerminalRedrawHarness.readText().split("kimi-browser-history-0").length - 1,
			),
		).toBe(1);
	}
	const nativeEvidenceDirectory = process.env.KANBAN_KIMI_NATIVE_E2E_OUTPUT_DIRECTORY;
	if (nativeEvidenceDirectory) {
		const nativeOutput = await readFile(join(nativeEvidenceDirectory, "native-terminal-output.ansi"), "utf8");
		await page.evaluate((nativeBytes) => window.kimiTerminalRedrawHarness.restore(nativeBytes), nativeOutput);
		expect(
			await page.evaluate(
				() => window.kimiTerminalRedrawHarness.readText().split("kimi-real-response-1-line-000").length - 1,
			),
		).toBe(1);
		const snapshot = await readFile(join(nativeEvidenceDirectory, "terminal-restore-snapshot.ansi"), "utf8");
		for (let reconnect = 0; reconnect < 2; reconnect += 1) {
			await page.evaluate((snapshotText) => window.kimiTerminalRedrawHarness.restore(snapshotText), snapshot);
			expect(
				await page.evaluate(
					() => window.kimiTerminalRedrawHarness.readText().split("kimi-real-response-1-line-000").length - 1,
				),
			).toBe(1);
		}
		const summary = JSON.parse(
			await readFile(join(nativeEvidenceDirectory, "accepted-session-summary.json"), "utf8"),
		);
		await page.evaluate(
			(acceptedSummary) =>
				window.kimiTerminalRedrawHarness.renderAcceptance({
					...acceptedSummary,
					agentConversationPromptSubmissionAcceptance: {
						...acceptedSummary.agentConversationPromptSubmissionAcceptance,
						status: "unconfirmed",
					},
				}),
			summary,
		);
		await expect(page.getByText("尚未确认接受", { exact: true })).toBeVisible();
		await page.evaluate(
			(acceptedSummary) => window.kimiTerminalRedrawHarness.renderAcceptance(acceptedSummary),
			summary,
		);
		await expect(page.getByText("尚未确认接受", { exact: true })).toHaveCount(0);
	}
});
