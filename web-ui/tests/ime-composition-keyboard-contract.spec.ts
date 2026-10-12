import { expect, test } from "@playwright/test";

/**
 * 这条 e2e 测的不是 Kanban 的某个界面，而是**整个 IME 修复所依赖的浏览器契约**——jsdom 里怎么造事件
 * 都是我们自己说了算，证明不了真实浏览器如何上报。故用一个自建输入框 + CDP 驱动真实组字状态，
 * 把两条假设钉死：
 *
 * ① 组字进行中按下的 Enter，其 keydown 上报 `isComposing === true`
 *    —— `isKeyboardEventEmittedDuringImeComposition` 的主判据；这条一旦不成立，Spotlight 会重新
 *    退化成「中文打到一半按 Enter 就跳走」。
 * ② 上屏时 `input` 先于 `compositionend`，且 `compositionend` 触发时输入框里已是最终文本
 *    —— `useTextInputValueCommittedAfterImeCompositionEnds` 在 compositionend 里读
 *    `event.currentTarget.value` 当作提交值，靠的就是这一条。
 *
 * 刻意不依赖 Kanban 运行时：跨端口 dev server 会被 WS 同源守卫挡掉（生产模式运行时无 4173 豁免），
 * 而这两条契约与应用无关。
 */

interface ImeContractProbe {
	__imeLog: string[];
}

async function installImeEventLog(page: import("@playwright/test").Page): Promise<void> {
	await page.setContent('<input id="ime-contract-probe" autofocus />');
	await page.evaluate(() => {
		const log: string[] = [];
		(window as unknown as ImeContractProbe).__imeLog = log;
		const target = document.getElementById("ime-contract-probe") as HTMLInputElement;
		target.focus();
		for (const type of ["compositionstart", "compositionupdate", "compositionend"]) {
			target.addEventListener(type, (event) =>
				log.push(`${type}:data=${(event as CompositionEvent).data}:value=${target.value}`),
			);
		}
		target.addEventListener("keydown", (event) => {
			const keyboardEvent = event as KeyboardEvent;
			log.push(`keydown:key=${keyboardEvent.key}:isComposing=${keyboardEvent.isComposing}`);
		});
		target.addEventListener("input", () => log.push(`input:value=${target.value}`));
	});
}

function readImeEventLog(page: import("@playwright/test").Page): Promise<string[]> {
	return page.evaluate(() => (window as unknown as ImeContractProbe).__imeLog);
}

test.describe("browser IME composition contract the task search fix relies on", () => {
	test("reports isComposing on the Enter pressed while a composition is in flight", async ({ page }) => {
		await installImeEventLog(page);

		const cdp = await page.context().newCDPSession(page);
		await cdp.send("Input.imeSetComposition", { text: "zhong", selectionStart: 5, selectionEnd: 5 });
		await cdp.send("Input.dispatchKeyEvent", {
			type: "keyDown",
			windowsVirtualKeyCode: 13,
			key: "Enter",
			code: "Enter",
		});

		expect(await readImeEventLog(page)).toContain("keydown:key=Enter:isComposing=true");
	});

	test("delivers the committed text before compositionend, with the input already holding it", async ({ page }) => {
		await installImeEventLog(page);

		const cdp = await page.context().newCDPSession(page);
		await cdp.send("Input.imeSetComposition", { text: "zhong", selectionStart: 5, selectionEnd: 5 });
		await cdp.send("Input.insertText", { text: "中文" });

		const log = await readImeEventLog(page);
		const lastInputIndex = log.lastIndexOf("input:value=中文");
		const compositionEndIndex = log.findIndex((entry) => entry.startsWith("compositionend:"));
		expect(lastInputIndex).toBeGreaterThanOrEqual(0);
		expect(compositionEndIndex).toBeGreaterThan(lastInputIndex);
		// compositionend 时输入框里已经是最终文本——提交漏斗读的就是这个值。
		expect(log[compositionEndIndex]).toBe("compositionend:data=中文:value=中文");
	});
});
