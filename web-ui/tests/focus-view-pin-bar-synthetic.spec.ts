import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, type Page, test } from "@playwright/test";

/**
 * Focus View 选中卡钉住条（重构后单一机制）的「真实浏览器」验证。
 *
 * 不连接 runtime（避免改动用户真实看板，也绕开 CORS 网关）。改用 page.setContent 在真实
 * Chromium 里忠实复刻实现：
 *  - 从 globals.css **逐字**注入「钉住期隐藏真实选中卡」规则与 .kb-detail-pin-bar overlay 规则；
 *  - 复刻 ColumnContextPanel → scrollport(.kb-detail-task-list-scroll) → stage section（含
 *    **原生 sticky 卡头**）→ Droppable padding → .kb-board-card-shell 的真实 DOM 嵌套与布局样式；
 *  - 用与 useSelectedCardPinState **逐行一致**的实时几何判定（sticky 语义：选中卡任一前沿触/越
 *    视口对应边沿即钉到该边；整卡在视口内 → hidden；零尺寸 → hidden），并镜像面板的三项副作用：
 *    ① scrollport 写 data-selected-pinned；② pinTop 时把浮动条实测高度写入 --kb-selected-pin-top
 *    使原生 sticky 卡头停在浮动条下方；③ 含选中卡 section 的原生卡头在 pinTop 时改非 sticky 去重。
 *
 * 由此验证「真实 getBoundingClientRect 实时几何 + 真实 position:sticky 卡头几何 + overlay 定位 +
 * visibility 隐藏」这一集成层——mock 掉布局几何的 jsdom 单测无法覆盖。hook 自身的判定逻辑另由
 * src/hooks/use-selected-card-pin-state.test.ts 覆盖。
 */

const currentDir = dirname(fileURLToPath(import.meta.url));
const globalsCssPath = resolve(currentDir, "../src/styles/globals.css");

function extractCssRule(css: string, selectorAnchor: string): string {
	const start = css.indexOf(selectorAnchor);
	if (start === -1) {
		throw new Error(`Could not find CSS anchor "${selectorAnchor}" in globals.css`);
	}
	const open = css.indexOf("{", start);
	const close = css.indexOf("}", open);
	if (open === -1 || close === -1) {
		throw new Error(`Malformed CSS block for anchor "${selectorAnchor}"`);
	}
	return css.slice(start, close + 1);
}

// 逐字取出 globals.css 里真正生效的规则，保证合成页与生产同源。
const globalsCss = readFileSync(globalsCssPath, "utf-8");
const hideRealCardRule = extractCssRule(
	globalsCss,
	'.kb-detail-task-list-scroll[data-selected-pinned="true"] .kb-board-card-shell[data-selected="true"]',
);
const pinBarBaseRule = extractCssRule(globalsCss, ".kb-detail-pin-bar {");
const pinTopRule = extractCssRule(globalsCss, '.kb-detail-pin-bar[data-pin="top"]');
const pinBottomRule = extractCssRule(globalsCss, '.kb-detail-pin-bar[data-pin="bottom"]');

const SELECTED_TASK_ID = "selected-card";
const SELECTED_STAGE_TITLE = "In Progress";
const IN_VIEW_STAGE_TITLE = "Review";

function buildSyntheticPage(): string {
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  :root { --color-surface-0: #1F2428; --color-surface-1: #24292E; --color-surface-2: #2D3339;
          --color-border: #30363D; --color-border-bright: #444C56; --color-accent: #0084FF;
          --radius-md: 6px; --color-text-primary: #E6EDF3; --color-text-secondary: #8B949E; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--color-surface-0); color: var(--color-text-primary);
         font-family: system-ui, sans-serif; }

  /* 基础卡壳规则（复刻 globals.css 的 .kb-board-card-shell）。 */
  .kb-board-card-shell { position: relative; z-index: 1; }
  .kb-board-card-shell[data-selected="true"] { outline: 1px solid var(--color-accent); border-radius: var(--radius-md); }

  /* >>> 以下四块从 globals.css 逐字注入 <<< */
  ${hideRealCardRule}
  ${pinBarBaseRule}
  ${pinTopRule}
  ${pinBottomRule}

  /* 复刻面板/滚动容器/section 的真实布局（与 column-context-panel.tsx 内联样式一致）。 */
  #panel { position: relative; display: flex; flex-direction: column; width: 360px; height: 480px;
           min-height: 0; overflow: hidden; background: var(--color-surface-0); }
  .kb-detail-task-list-scroll { flex: 1 1 0; min-height: 0; overflow-y: auto;
           overscroll-behavior: contain; overflow-anchor: none;
           display: flex; flex-direction: column; gap: 8px; padding: 8px; }
  .stage-section { background: var(--color-surface-1); border-radius: 8px; border: 1px solid var(--color-border); flex-shrink: 0; }
  /* 原生 sticky 区段卡头（镜像 column-context-panel.tsx 的卡头内联 style）：top 引用 --kb-selected-pin-top。 */
  .stage-header { display: flex; align-items: center; height: 40px; padding: 0 12px; font-weight: 600; font-size: 13px;
           position: sticky; top: var(--kb-selected-pin-top, 0px); z-index: 4; background: var(--color-surface-1); }
  .stage-droppable { display: flex; flex-direction: column; padding: 8px; }
  .card-visual { border: 1px solid var(--color-border-bright); background: var(--color-surface-2); border-radius: 6px;
                 padding: 10px; height: 64px; overflow: hidden; }
  .kb-board-card-shell { margin-bottom: 6px; }
</style>
</head>
<body>
  <div id="panel">
    <div id="scroll" class="kb-detail-task-list-scroll"></div>
  </div>
<script>
  (function () {
    var scroll = document.getElementById("scroll");
    var panel = document.getElementById("panel");
    var selectedHeader = null; // 含选中卡 section 的原生卡头，用于 pinTop 去重。

    function makeCard(id, label, selected) {
      var shell = document.createElement("div");
      shell.className = "kb-board-card-shell";
      shell.setAttribute("data-task-id", id);
      shell.setAttribute("data-selected", selected ? "true" : "false");
      var visual = document.createElement("div");
      visual.className = "card-visual";
      visual.textContent = label;
      shell.appendChild(visual);
      return shell;
    }

    function makeStage(title, count, opts) {
      var section = document.createElement("div");
      section.className = "stage-section";
      var header = document.createElement("div");
      header.className = "stage-header";
      header.setAttribute("data-stage", title);
      header.textContent = title;
      section.appendChild(header);
      var droppable = document.createElement("div");
      droppable.className = "stage-droppable";
      for (var i = 0; i < count; i++) {
        var isSel = opts && opts.selectedIndex === i;
        droppable.appendChild(
          makeCard(isSel ? ${JSON.stringify(SELECTED_TASK_ID)} : title + "-card-" + i, title + " task " + (i + 1), isSel)
        );
      }
      section.appendChild(droppable);
      if (opts && opts.selectedIndex != null) selectedHeader = header;
      return section;
    }

    scroll.appendChild(makeStage("Backlog", 8));
    scroll.appendChild(makeStage(${JSON.stringify(SELECTED_STAGE_TITLE)}, 4, { selectedIndex: 0 }));
    scroll.appendChild(makeStage(${JSON.stringify(IN_VIEW_STAGE_TITLE)}, 8));

    // --- 浮动钉住条（含 stage 卡头 + 选中卡克隆）。 ---
    var pinBar = null;
    function removePinBar() { if (pinBar) { pinBar.remove(); pinBar = null; } }
    function renderPinBar(state) {
      if (state === "hidden") { removePinBar(); return; }
      if (!pinBar) {
        pinBar = document.createElement("div");
        pinBar.className = "kb-detail-pin-bar";
        pinBar.setAttribute("data-testid", "selected-task-pin-bar");
        var section = document.createElement("div");
        section.className = "stage-section";
        var header = document.createElement("div");
        header.className = "stage-header";
        header.setAttribute("data-testid", "pin-bar-stage-title");
        // 浮动条里的卡头不参与 scrollport sticky（它在脱流的 overlay 内），固定为 static 即可。
        header.style.position = "static";
        header.textContent = ${JSON.stringify(SELECTED_STAGE_TITLE)};
        var droppable = document.createElement("div");
        droppable.className = "stage-droppable";
        var clone = makeCard("pinned-clone", ${JSON.stringify(SELECTED_STAGE_TITLE)} + " task 1", true);
        clone.removeAttribute("data-task-id"); // 钉住克隆不得携带 data-task-id（保证全局唯一）。
        droppable.appendChild(clone);
        section.appendChild(header);
        section.appendChild(droppable);
        pinBar.appendChild(section);
        pinBar.style.right = (scroll.offsetWidth - scroll.clientWidth) + "px";
        panel.appendChild(pinBar);
      }
      pinBar.setAttribute("data-pin", state === "pinTop" ? "top" : "bottom");
    }

    // 镜像面板三项副作用：data-selected-pinned / --kb-selected-pin-top / 选中 section 卡头去重。
    function applyModel(state) {
      renderPinBar(state);
      if (state === "hidden") scroll.removeAttribute("data-selected-pinned");
      else scroll.setAttribute("data-selected-pinned", "true");
      if (state === "pinTop" && pinBar) {
        // 镜像 column-context-panel：扣掉 scrollport 顶 padding，使原生 sticky 卡头底贴浮动条无缝。
        var paddingTop = parseFloat(getComputedStyle(scroll).paddingTop) || 0;
        scroll.style.setProperty("--kb-selected-pin-top", Math.max(0, pinBar.offsetHeight - paddingTop) + "px");
      } else {
        scroll.style.setProperty("--kb-selected-pin-top", "0px");
      }
      if (selectedHeader) selectedHeader.style.position = state === "pinTop" ? "static" : "";
    }

    // 与 useSelectedCardPinState 逐行一致：sticky 语义的实时几何判定，rAF 合并。
    var frameId = 0;
    function computeNow() {
      frameId = 0;
      var target = scroll.querySelector('[data-task-id="' + ${JSON.stringify(SELECTED_TASK_ID)} + '"]');
      var state;
      if (!target) {
        state = "hidden";
      } else {
        var cardRect = target.getBoundingClientRect();
        if (cardRect.width === 0 && cardRect.height === 0) {
          state = "hidden";
        } else {
          var rootRect = scroll.getBoundingClientRect();
          if (cardRect.top <= rootRect.top) state = "pinTop";
          else if (cardRect.bottom >= rootRect.bottom) state = "pinBottom";
          else state = "hidden";
        }
      }
      applyModel(state);
      window.__pinState = state;
    }
    function schedule() {
      if (frameId !== 0) return;
      frameId = requestAnimationFrame(computeNow);
    }
    computeNow();
    scroll.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    new ResizeObserver(schedule).observe(scroll);
    new MutationObserver(schedule).observe(scroll, {
      childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["style"],
    });
    // 折叠选中卡所在 stage（镜像 ColumnSection 的 display:none 折叠）：纯样式属性变更使真实卡变 0×0。
    window.__collapseSelectedStage = function () {
      scroll.children[1].querySelector(".stage-droppable").style.display = "none";
    };
    window.__pinReady = true;
  })();
</script>
</body>
</html>`;
}

async function setScrollTop(page: Page, top: number | "max"): Promise<void> {
	await page.evaluate((value) => {
		const scroll = document.getElementById("scroll");
		if (!scroll) {
			return;
		}
		scroll.scrollTop = value === "max" ? scroll.scrollHeight : value;
	}, top);
}

// 把真实选中卡居中带回视口（确定性，不依赖硬编码的 scrollTop 估算）。
async function scrollSelectedCardIntoView(page: Page): Promise<void> {
	await page.evaluate((id) => {
		document.querySelector(`[data-task-id="${id}"]`)?.scrollIntoView({ block: "center", inline: "nearest" });
	}, SELECTED_TASK_ID);
}

// 把选中卡上沿推到视口上沿之上（仍在自己 stage 内：后续 In Progress 卡仍在视）→ stage 内即产生 pinTop。
async function scrollSelectedTopAboveViewport(page: Page): Promise<void> {
	await page.evaluate((id) => {
		const scroll = document.getElementById("scroll");
		const card = document.querySelector(`[data-task-id="${id}"]`);
		if (!scroll || !card) {
			return;
		}
		const cardRect = card.getBoundingClientRect();
		const scrollRect = scroll.getBoundingClientRect();
		scroll.scrollTop += cardRect.top - scrollRect.top + 24;
	}, SELECTED_TASK_ID);
}

function readState(page: Page): Promise<string | undefined> {
	return page.evaluate(() => (window as unknown as { __pinState?: string }).__pinState);
}

function realCardVisibility(page: Page): Promise<string | null> {
	return page.evaluate((id) => {
		const card = document.querySelector(`[data-task-id="${id}"]`);
		return card ? getComputedStyle(card as HTMLElement).visibility : null;
	}, SELECTED_TASK_ID);
}

test.describe("Focus View pin bar (synthetic, real browser)", () => {
	test.beforeEach(async ({ page }) => {
		await page.setContent(buildSyntheticPage(), { waitUntil: "load" });
		await page.waitForFunction(() => (window as unknown as { __pinReady?: boolean }).__pinReady === true);
	});

	test("selected card centered in view → no pin bar, real card visible, not pinned", async ({ page }) => {
		await scrollSelectedCardIntoView(page);
		await page.waitForFunction(() => (window as unknown as { __pinState?: string }).__pinState === "hidden");
		await expect(page.getByTestId("selected-task-pin-bar")).toHaveCount(0);
		expect(await realCardVisibility(page)).toBe("visible");
		await expect(page.locator("#scroll")).not.toHaveAttribute("data-selected-pinned", "true");
	});

	test("scrolling the card's top past the viewport top (still in its own stage) pins to TOP, hides the real card, dedups the owning header", async ({
		page,
	}) => {
		await scrollSelectedCardIntoView(page);
		await scrollSelectedTopAboveViewport(page);
		await page.waitForFunction(() => (window as unknown as { __pinState?: string }).__pinState === "pinTop");

		const pinBar = page.getByTestId("selected-task-pin-bar");
		await expect(pinBar).toBeVisible();
		await expect(pinBar).toHaveAttribute("data-pin", "top");
		// stage 卡头随行（无缝接管，卡头始终在钉住条里）。
		await expect(page.getByTestId("pin-bar-stage-title")).toHaveText(SELECTED_STAGE_TITLE);
		await expect(pinBar).toContainText(`${SELECTED_STAGE_TITLE} task 1`);
		// 真实选中卡被隐藏（visibility:hidden）以免与克隆重影；scrollport 标记 data-selected-pinned。
		expect(await realCardVisibility(page)).toBe("hidden");
		await expect(page.locator("#scroll")).toHaveAttribute("data-selected-pinned", "true");
		// 去重：含选中卡 section 的原生卡头在 pinTop 时改为非 sticky（static），不与浮动条卡头重复。
		const owningHeaderPosition = await page.evaluate(
			(title) =>
				getComputedStyle(document.querySelector(`#scroll .stage-header[data-stage="${title}"]`) as HTMLElement)
					.position,
			SELECTED_STAGE_TITLE,
		);
		expect(owningHeaderPosition).toBe("static");
	});

	test("scrolling to the bottom stage keeps pinTop and stacks the in-view stage header BELOW the pin bar (offset applied)", async ({
		page,
	}) => {
		await setScrollTop(page, "max");
		await page.waitForFunction(() => (window as unknown as { __pinState?: string }).__pinState === "pinTop");
		const pinBar = page.getByTestId("selected-task-pin-bar");
		await expect(pinBar).toHaveAttribute("data-pin", "top");

		const geometry = await page.evaluate((title) => {
			const bar = document.querySelector(".kb-detail-pin-bar") as HTMLElement | null;
			const header = document.querySelector(`#scroll .stage-header[data-stage="${title}"]`) as HTMLElement | null;
			if (!bar || !header) {
				return null;
			}
			const barRect = bar.getBoundingClientRect();
			const headerRect = header.getBoundingClientRect();
			return {
				barBottom: barRect.bottom,
				headerTop: headerRect.top,
				headerPosition: getComputedStyle(header).position,
			};
		}, IN_VIEW_STAGE_TITLE);

		expect(geometry).not.toBeNull();
		// 在视 stage（Review）的原生 sticky 卡头底贴浮动条「严丝合缝」——既不被压到下方留缝（旧 bug：露出
		// scrollport 顶 padding 宽的可透视缝），也不卡在 top:0（offset 未生效）高于浮动条底沿。容差 1px。
		expect(geometry?.headerPosition).toBe("sticky");
		expect(Math.abs((geometry?.headerTop ?? -999) - (geometry?.barBottom ?? 999))).toBeLessThanOrEqual(1);
	});

	test("scrolling above the selected stage pins the card to the BOTTOM edge, in-view header at the top", async ({
		page,
	}) => {
		await setScrollTop(page, 0);
		await page.waitForFunction(() => (window as unknown as { __pinState?: string }).__pinState === "pinBottom");
		const pinBar = page.getByTestId("selected-task-pin-bar");
		await expect(pinBar).toBeVisible();
		await expect(pinBar).toHaveAttribute("data-pin", "bottom");
		// pinBottom：offset=0，在视 stage（Backlog）卡头自然停在顶部（top:0 区域），不被浮动条压到下方。
		const geometry = await page.evaluate(() => {
			const header = document.querySelector('#scroll .stage-header[data-stage="Backlog"]') as HTMLElement | null;
			const scroll = document.getElementById("scroll") as HTMLElement | null;
			if (!header || !scroll) {
				return null;
			}
			return { headerTop: header.getBoundingClientRect().top, scrollTop: scroll.getBoundingClientRect().top };
		});
		expect(geometry).not.toBeNull();
		// 卡头贴近视口顶沿（容差含 scrollport 的 8px padding）。
		expect(Math.abs((geometry?.headerTop ?? -999) - (geometry?.scrollTop ?? 999))).toBeLessThanOrEqual(12);
	});

	test("the pinned clone carries no data-task-id (global uniqueness preserved)", async ({ page }) => {
		await setScrollTop(page, "max");
		await expect(page.getByTestId("selected-task-pin-bar")).toBeVisible();
		await expect(page.locator(`[data-task-id="${SELECTED_TASK_ID}"]`)).toHaveCount(1);
	});

	test("regression: a single abrupt scroll jump (scrollbar drag) flips bottom→top", async ({ page }) => {
		await setScrollTop(page, 0);
		const pinBar = page.getByTestId("selected-task-pin-bar");
		await expect(pinBar).toHaveAttribute("data-pin", "bottom");
		// 一次性跳到底：卡片从下方瞬移到上方（中途从不相交）。纯 IntersectionObserver 会停留在
		// 过时的 "bottom"；实时几何重算正确翻到 "top"。
		await setScrollTop(page, "max");
		await expect(pinBar).toHaveAttribute("data-pin", "top");
	});

	test("seam: returning the card to view hides the pin bar and restores the real card", async ({ page }) => {
		await setScrollTop(page, "max");
		await expect(page.getByTestId("selected-task-pin-bar")).toBeVisible();
		expect(await realCardVisibility(page)).toBe("hidden");
		await scrollSelectedCardIntoView(page);
		await expect(page.getByTestId("selected-task-pin-bar")).toHaveCount(0);
		expect(await realCardVisibility(page)).toBe("visible");
		await expect(page.locator("#scroll")).not.toHaveAttribute("data-selected-pinned", "true");
	});

	test("collapsing the selected card's stage (display:none) hides the pin bar (no stale clone)", async ({ page }) => {
		await setScrollTop(page, "max");
		await expect(page.getByTestId("selected-task-pin-bar")).toBeVisible();
		await page.evaluate(() =>
			(window as unknown as { __collapseSelectedStage: () => void }).__collapseSelectedStage(),
		);
		await expect(page.getByTestId("selected-task-pin-bar")).toHaveCount(0);
		expect(await readState(page)).toBe("hidden");
	});
});
