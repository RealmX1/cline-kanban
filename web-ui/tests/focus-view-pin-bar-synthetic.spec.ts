import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, type Page, test } from "@playwright/test";

/**
 * Focus View 跨 stage 浮动钉住条的「真实浏览器」验证。
 *
 * 不连接 runtime（避免改动用户真实看板，也绕开 CORS 网关）。改用 page.setContent 在真实
 * Chromium 里忠实复刻实现：
 *  - 注入 globals.css 中**逐字**的列内 sticky 规则与 .kb-detail-pin-bar overlay 规则；
 *  - 复刻 ColumnContextPanel → scrollport(.kb-detail-task-list-scroll) → stage section →
 *    Droppable padding → .kb-board-card-shell 的真实 DOM 嵌套与布局样式；
 *  - 用与 useSelectedCardPinState **逐行一致**的实时几何判定（以滚动容器为视口基准，
 *    `getBoundingClientRect` 读卡片与视口两个 rect，比较 bottom/top 判顶底，零尺寸→hidden），
 *    由 scroll / resize / ResizeObserver / MutationObserver 触发、rAF 合并后重算，
 *    驱动一个真实的 .kb-detail-pin-bar overlay（含 stage 卡头 + 选中卡克隆）。
 *
 * 由此验证「真实 getBoundingClientRect 实时几何 + 真实 position:sticky 几何 + overlay 定位」这一层——
 * 这是 mock 掉布局几何的 jsdom 单测无法覆盖的集成行为。hook 文件自身的判定逻辑另由
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

// 逐字取出 globals.css 里真正生效的两条规则，保证合成页与生产同源。
const globalsCss = readFileSync(globalsCssPath, "utf-8");
const stickyRule = extractCssRule(globalsCss, '.kb-detail-task-list-scroll .kb-board-card-shell[data-selected="true"]');
const pinBarBaseRule = extractCssRule(globalsCss, ".kb-detail-pin-bar {");
const pinTopRule = extractCssRule(globalsCss, '.kb-detail-pin-bar[data-pin="top"]');
const pinBottomRule = extractCssRule(globalsCss, '.kb-detail-pin-bar[data-pin="bottom"]');

const SELECTED_TASK_ID = "selected-card";
const SELECTED_STAGE_TITLE = "In Progress";

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

  /* >>> 以下三块从 globals.css 逐字注入 <<< */
  ${stickyRule}
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
  .stage-header { display: flex; align-items: center; height: 40px; padding: 0 12px; font-weight: 600; font-size: 13px; }
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

    function makeCard(stageTitle, id, label, selected) {
      var shell = document.createElement("div");
      shell.className = "kb-board-card-shell";
      if (!selected) {
        // 选中卡才带 data-task-id（与生产一致：列表内每卡都有，但这里只需选中卡可被定位）。
      }
      shell.setAttribute("data-task-id", id);
      shell.setAttribute("data-column-id", stageTitle);
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
      header.textContent = title;
      section.appendChild(header);
      var droppable = document.createElement("div");
      droppable.className = "stage-droppable";
      for (var i = 0; i < count; i++) {
        var isSel = opts && opts.selectedIndex === i;
        droppable.appendChild(
          makeCard(title, isSel ? ${JSON.stringify(SELECTED_TASK_ID)} : title + "-card-" + i,
                   title + " task " + (i + 1), isSel)
        );
      }
      section.appendChild(droppable);
      return section;
    }

    scroll.appendChild(makeStage("Backlog", 8));
    scroll.appendChild(makeStage(${JSON.stringify(SELECTED_STAGE_TITLE)}, 1, { selectedIndex: 0 }));
    scroll.appendChild(makeStage("Review", 8));

    // --- useSelectedCardPinState 的逐行镜像（真实 getBoundingClientRect 实时几何）。 ---
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
        header.textContent = ${JSON.stringify(SELECTED_STAGE_TITLE)};
        var droppable = document.createElement("div");
        droppable.className = "stage-droppable";
        droppable.appendChild(makeCard(${JSON.stringify(SELECTED_STAGE_TITLE)}, "pinned-clone-no-data-task-id-attr", ${JSON.stringify(SELECTED_STAGE_TITLE)} + " task 1", true));
        // 钉住克隆不得携带 data-task-id（保证全局唯一）。
        droppable.querySelector(".kb-board-card-shell").removeAttribute("data-task-id");
        section.appendChild(header);
        section.appendChild(droppable);
        pinBar.appendChild(section);
        pinBar.style.right = (scroll.offsetWidth - scroll.clientWidth) + "px";
        panel.appendChild(pinBar);
      }
      pinBar.setAttribute("data-pin", state === "pinTop" ? "top" : "bottom");
    }

    // 与 useSelectedCardPinState 逐行一致：实时几何（getBoundingClientRect）为唯一真相，
    // 由 scroll / resize / mutation 触发，rAF 合并；对滚动条拖拽这类一次性大跳转同样正确。
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
          if (cardRect.bottom <= rootRect.top) state = "pinTop";
          else if (cardRect.top >= rootRect.bottom) state = "pinBottom";
          else state = "hidden";
        }
      }
      renderPinBar(state);
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
    // 折叠选中卡所在 stage（镜像 ColumnSection 的 display:none 折叠）：纯样式属性变更。
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

test.describe("Focus View pin bar (synthetic, real browser)", () => {
	test.beforeEach(async ({ page }) => {
		await page.setContent(buildSyntheticPage(), { waitUntil: "load" });
		await page.waitForFunction(() => (window as unknown as { __pinReady?: boolean }).__pinReady === true);
	});

	test("selected card visible in its own stage → no pin bar (CSS sticky owns it)", async ({ page }) => {
		// 把选中卡居中带回视口：选中卡相交 → hidden（交给列内 CSS sticky）。
		await scrollSelectedCardIntoView(page);
		await expect(page.getByTestId("selected-task-pin-bar")).toHaveCount(0);
	});

	test("scrolling past the stage downward pins the card to the TOP edge", async ({ page }) => {
		await setScrollTop(page, "max");
		const pinBar = page.getByTestId("selected-task-pin-bar");
		await expect(pinBar).toBeVisible();
		await expect(pinBar).toHaveAttribute("data-pin", "top");
		// stage 卡头随行：标题与选中卡一起出现在钉住条里。
		await expect(page.getByTestId("pin-bar-stage-title")).toHaveText(SELECTED_STAGE_TITLE);
		await expect(pinBar).toContainText(`${SELECTED_STAGE_TITLE} task 1`);
	});

	test("scrolling above the stage pins the card to the BOTTOM edge", async ({ page }) => {
		await setScrollTop(page, 0);
		const pinBar = page.getByTestId("selected-task-pin-bar");
		await expect(pinBar).toBeVisible();
		await expect(pinBar).toHaveAttribute("data-pin", "bottom");
		await expect(page.getByTestId("pin-bar-stage-title")).toHaveText(SELECTED_STAGE_TITLE);
	});

	test("the pinned clone carries no data-task-id (global uniqueness preserved)", async ({ page }) => {
		await setScrollTop(page, "max");
		await expect(page.getByTestId("selected-task-pin-bar")).toBeVisible();
		// 文档内 data-task-id="selected-card" 仍唯一（真实卡 1 个，克隆 0 个）。
		await expect(page.locator(`[data-task-id="${SELECTED_TASK_ID}"]`)).toHaveCount(1);
	});

	test("the pin bar overlay sits at the top edge of the scroll viewport, not pushing layout", async ({ page }) => {
		await setScrollTop(page, "max");
		const pinBar = page.getByTestId("selected-task-pin-bar");
		await expect(pinBar).toBeVisible();
		// 必须先等 pin 状态 rAF 重算稳定到 "top"：初始 scrollTop=0 时先渲染过 data-pin="bottom"，
		// 跳到底后才翻到 "top"；不等翻转完成就测几何会偶发量到过时的底沿位置（barTop≈352）。
		await expect(pinBar).toHaveAttribute("data-pin", "top");
		const geometry = await page.evaluate(() => {
			const bar = document.querySelector(".kb-detail-pin-bar") as HTMLElement | null;
			const scroll = document.getElementById("scroll") as HTMLElement | null;
			if (!bar || !scroll) {
				return null;
			}
			const barRect = bar.getBoundingClientRect();
			const scrollRect = scroll.getBoundingClientRect();
			return { barTop: barRect.top, scrollTop: scrollRect.top, barLeft: barRect.left, scrollLeft: scrollRect.left };
		});
		expect(geometry).not.toBeNull();
		// overlay 顶沿与滚动视口顶沿对齐（pinTop → top:0），左沿对齐（left:0）。
		expect(Math.abs((geometry?.barTop ?? -999) - (geometry?.scrollTop ?? 999))).toBeLessThanOrEqual(1);
		expect(Math.abs((geometry?.barLeft ?? -999) - (geometry?.scrollLeft ?? 999))).toBeLessThanOrEqual(1);
	});

	test("regression: a single abrupt scroll jump (scrollbar drag) flips bottom→top", async ({ page }) => {
		// 初始 scrollTop=0：选中卡在视口下方 → pinBottom。
		const pinBar = page.getByTestId("selected-task-pin-bar");
		await expect(pinBar).toHaveAttribute("data-pin", "bottom");
		// 一次性跳到底：卡片从下方瞬移到上方（中途从不相交）。纯 IntersectionObserver 会停留在
		// 过时的 "bottom"；实时几何重算正确翻到 "top"。
		await setScrollTop(page, "max");
		await expect(pinBar).toHaveAttribute("data-pin", "top");
	});

	test("seam: returning the card to view hides the pin bar again", async ({ page }) => {
		await setScrollTop(page, "max");
		await expect(page.getByTestId("selected-task-pin-bar")).toBeVisible();
		await scrollSelectedCardIntoView(page);
		await expect(page.getByTestId("selected-task-pin-bar")).toHaveCount(0);
	});

	test("collapsing the selected card's stage (display:none) hides the pin bar (no stale clone)", async ({ page }) => {
		// 钉住条显示中，用户折叠选中卡所在 stage：纯 style 属性变更使真实卡变 0×0。
		// MutationObserver 的 attributeFilter:["style"] 须捕获它并重算 → hidden，否则残留已隐藏卡的克隆。
		await setScrollTop(page, "max");
		await expect(page.getByTestId("selected-task-pin-bar")).toBeVisible();
		await page.evaluate(() =>
			(window as unknown as { __collapseSelectedStage: () => void }).__collapseSelectedStage(),
		);
		await expect(page.getByTestId("selected-task-pin-bar")).toHaveCount(0);
	});
});
