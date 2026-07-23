import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, type Page, test } from "@playwright/test";

/**
 * Focus View「全 stage 卡头手风琴 + 折叠时焦点卡留存」的「真实浏览器」验证。
 *
 * 不连接 runtime（避免改动用户真实看板，也绕开 CORS 网关）。改用 page.setContent 在真实 Chromium
 * 里忠实复刻实现：
 *  - 从 globals.css **逐字**注入「钉住期隐藏真实焦点卡」规则与 `.kb-stage-header-rail` overlay 规则；
 *  - 复刻 ColumnContextPanel → scrollport(.kb-detail-task-list-scroll) → stage section（`data-stage-section-id`，
 *    卡头随内容自然滚动的 static 卡头）→ Droppable padding → .kb-board-card-shell 的真实 DOM 嵌套与布局；
 *  - 用与 useSelectedCardPinState / useStageHeaderPinLayout **逐行一致**的实时几何：焦点卡 hidden/pinTop/
 *    pinBottom；全 stage 卡头的前向（钉顶）/后向（钉底）分类（焦点条目按真实卡高计入堆叠偏移），并按结果
 *    渲染顶/底两条脱流 rail（焦点 stage 的条目在焦点卡钉同侧时挂 pinnedClone，克隆不带 data-task-id）。
 *
 * 由此验证「真实 getBoundingClientRect 实时几何 + overlay 定位 + visibility 隐藏 + 折叠留存」这一集成层——
 * mock 掉布局几何的 jsdom 单测无法覆盖。分类算法本身另由 src/hooks/use-stage-header-pin-layout.test.ts、
 * 焦点卡钉住判定由 src/hooks/use-selected-card-pin-state.test.ts 覆盖。
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
const railBaseRule = extractCssRule(globalsCss, ".kb-stage-header-rail {");
const railTopRule = extractCssRule(globalsCss, '.kb-stage-header-rail[data-edge="top"]');
const railBottomRule = extractCssRule(globalsCss, '.kb-stage-header-rail[data-edge="bottom"]');
const railEntryPointerRule = extractCssRule(globalsCss, ".kb-stage-header-rail > *");

const FOCUSED_TASK_ID = "selected-card";
const FOCUSED_COLUMN_ID = "in_progress";
// 顺序即文档序；焦点为 in_progress（index 1）。
const STAGES: { id: string; title: string; count: number }[] = [
	{ id: "backlog", title: "Backlog", count: 8 },
	{ id: "in_progress", title: "In Progress", count: 4 },
	{ id: "review", title: "Review", count: 8 },
	{ id: "done", title: "Done", count: 3 },
];

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

  /* >>> 以下从 globals.css 逐字注入 <<< */
  ${hideRealCardRule}
  ${railBaseRule}
  ${railTopRule}
  ${railBottomRule}
  ${railEntryPointerRule}

  /* 复刻面板/滚动容器/section 的真实布局（与 column-context-panel.tsx 内联样式一致）。 */
  #panel { position: relative; display: flex; flex-direction: column; width: 360px; height: 480px;
           min-height: 0; overflow: hidden; background: var(--color-surface-0); }
  .kb-detail-task-list-scroll { flex: 1 1 0; min-height: 0; overflow-y: auto;
           overscroll-behavior: contain; overflow-anchor: none;
           display: flex; flex-direction: column; gap: 8px; padding: 8px; }
  .stage-section { background: var(--color-surface-1); border-radius: 8px; border: 1px solid var(--color-border); flex-shrink: 0; }
  /* 卡头随内容自然滚动（static）——「当前所属 stage」现由 rail 手风琴呈现。 */
  .stage-header { display: flex; align-items: center; height: 40px; padding: 0 12px; font-weight: 600; font-size: 13px;
           background: var(--color-surface-1); }
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
    var STAGES = ${JSON.stringify(STAGES)};
    var COLUMN_IDS = STAGES.map(function (s) { return s.id; });
    var TITLE_BY_ID = {};
    STAGES.forEach(function (s) { TITLE_BY_ID[s.id] = s.title; });
    var FOCUSED_COLUMN_ID = ${JSON.stringify(FOCUSED_COLUMN_ID)};
    var FOCUSED_TASK_ID = ${JSON.stringify(FOCUSED_TASK_ID)};
    var HEADER = 40, GAP = 8, SECTION_BORDER = 2, FOCUSED_CARD_PADDING = 16;

    function makeCard(id, label, selected) {
      var shell = document.createElement("div");
      shell.className = "kb-board-card-shell";
      if (id) shell.setAttribute("data-task-id", id);
      shell.setAttribute("data-selected", selected ? "true" : "false");
      var visual = document.createElement("div");
      visual.className = "card-visual";
      visual.textContent = label;
      shell.appendChild(visual);
      return shell;
    }

    STAGES.forEach(function (stage) {
      var section = document.createElement("div");
      section.className = "stage-section";
      section.setAttribute("data-stage-section-id", stage.id);
      var header = document.createElement("div");
      header.className = "stage-header";
      header.setAttribute("data-stage", stage.id);
      header.textContent = stage.title;
      section.appendChild(header);
      var droppable = document.createElement("div");
      droppable.className = "stage-droppable";
      for (var i = 0; i < stage.count; i++) {
        var isSel = stage.id === FOCUSED_COLUMN_ID && i === 0;
        droppable.appendChild(
          makeCard(isSel ? FOCUSED_TASK_ID : stage.id + "-card-" + i, stage.title + " task " + (i + 1), isSel),
        );
      }
      section.appendChild(droppable);
      scroll.appendChild(section);
    });

    // --- 焦点卡钉住判定（逐行同 useSelectedCardPinState：sticky 语义 + 0×0→hidden）。 ---
    function computePinState() {
      var target = scroll.querySelector('[data-task-id="' + FOCUSED_TASK_ID + '"]');
      if (!target) return "hidden";
      var cardRect = target.getBoundingClientRect();
      if (cardRect.width === 0 && cardRect.height === 0) return "hidden";
      var rootRect = scroll.getBoundingClientRect();
      if (cardRect.top <= rootRect.top) return "pinTop";
      if (cardRect.bottom >= rootRect.bottom) return "pinBottom";
      return "hidden";
    }

    // --- 全 stage 卡头钉住布局（逐行同 useStageHeaderPinLayout）。 ---
    function computeLayout(pinState) {
      var rootRect = scroll.getBoundingClientRect();
      if (rootRect.bottom <= rootRect.top) return { top: [], bottom: [] };
      var rootTop = rootRect.top, rootBottom = rootRect.bottom;
      var focusedIndex = COLUMN_IDS.indexOf(FOCUSED_COLUMN_ID);
      var focusedCardHeight = 0;
      if (focusedIndex >= 0) {
        var fc = scroll.querySelector('[data-task-id="' + FOCUSED_TASK_ID + '"]');
        if (fc) focusedCardHeight = fc.getBoundingClientRect().height;
      }
      var tops = [], bottoms = [];
      COLUMN_IDS.forEach(function (id) {
        var sec = scroll.querySelector('[data-stage-section-id="' + id + '"]');
        if (!sec) { tops.push(NaN); bottoms.push(NaN); return; }
        var r = sec.getBoundingClientRect();
        tops.push(r.top); bottoms.push(r.bottom);
      });
      function entryHeight(i, edge) {
        var base = HEADER + SECTION_BORDER;
        return i === focusedIndex && pinState === edge ? base + FOCUSED_CARD_PADDING + focusedCardHeight : base;
      }
      var topOffset = rootTop, topPinned = [], lastTop = -1;
      for (var i = 0; i < COLUMN_IDS.length; i++) {
        if (isNaN(tops[i])) break;
        if (tops[i] <= topOffset) {
          topPinned.push(COLUMN_IDS[i]); lastTop = i;
          topOffset += entryHeight(i, "pinTop") + GAP;
        } else break;
      }
      var botOffset = rootBottom, botRev = [];
      for (var j = COLUMN_IDS.length - 1; j > lastTop; j--) {
        if (isNaN(tops[j]) || isNaN(bottoms[j])) break;
        var slot = botOffset - entryHeight(j, "pinBottom");
        var overflow = bottoms[j] > rootBottom;
        if (tops[j] >= slot && (overflow || botRev.length > 0)) {
          botRev.push(COLUMN_IDS[j]);
          botOffset -= entryHeight(j, "pinBottom") + GAP;
        } else break;
      }
      botRev.reverse();
      return { top: topPinned, bottom: botRev };
    }

    // --- rail 渲染：清空后按分类重建顶/底两条 overlay。 ---
    function removeRail(edge) {
      var existing = panel.querySelector('.kb-stage-header-rail[data-edge="' + edge + '"]');
      if (existing) existing.remove();
    }
    function buildRail(edge, ids, pinState) {
      if (!ids.length) return;
      var rail = document.createElement("div");
      rail.className = "kb-stage-header-rail";
      rail.setAttribute("data-edge", edge);
      rail.setAttribute("data-testid", "stage-header-rail");
      rail.style.right = (scroll.offsetWidth - scroll.clientWidth) + "px";
      ids.forEach(function (id) {
        var entry = document.createElement("div");
        entry.className = "stage-section";
        var header = document.createElement("div");
        header.className = "stage-header";
        header.setAttribute("data-rail-stage", id);
        header.textContent = TITLE_BY_ID[id];
        entry.appendChild(header);
        var withCard = id === FOCUSED_COLUMN_ID && pinState === (edge === "top" ? "pinTop" : "pinBottom");
        if (withCard) {
          var wrap = document.createElement("div");
          wrap.className = "stage-droppable";
          wrap.setAttribute("data-testid", "stage-header-rail-focused-card");
          var clone = makeCard(null, TITLE_BY_ID[FOCUSED_COLUMN_ID] + " clone", true);
          wrap.appendChild(clone);
          entry.appendChild(wrap);
        }
        rail.appendChild(entry);
      });
      panel.appendChild(rail);
    }

    var frameId = 0;
    function computeNow() {
      frameId = 0;
      var pinState = computePinState();
      if (pinState === "hidden") scroll.removeAttribute("data-selected-pinned");
      else scroll.setAttribute("data-selected-pinned", "true");
      var layout = computeLayout(pinState);
      removeRail("top"); removeRail("bottom");
      buildRail("top", layout.top, pinState);
      buildRail("bottom", layout.bottom, pinState);
      window.__pinState = pinState;
      window.__topPinned = layout.top.join(",");
      window.__bottomPinned = layout.bottom.join(",");
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

    // 折叠焦点 stage：镜像 ColumnSection 的 peek 支路——只留焦点卡可见，隐藏同 stage 其余卡（纯样式变更，
    // 焦点卡保活真实几何、永不 0×0）。MutationObserver 的 style 过滤据此重算。
    window.__collapseSelectedStage = function () {
      var sec = scroll.querySelector('[data-stage-section-id="' + FOCUSED_COLUMN_ID + '"]');
      sec.querySelectorAll(".stage-droppable .kb-board-card-shell").forEach(function (card) {
        if (card.getAttribute("data-task-id") !== FOCUSED_TASK_ID) card.style.display = "none";
      });
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

async function scrollFocusedCardIntoView(page: Page): Promise<void> {
	await page.evaluate((id) => {
		document.querySelector(`[data-task-id="${id}"]`)?.scrollIntoView({ block: "center", inline: "nearest" });
	}, FOCUSED_TASK_ID);
}

// 把焦点卡上沿推到视口上沿之上（仍在自己 stage 内）→ stage 内即产生 pinTop。
async function scrollFocusedTopAboveViewport(page: Page): Promise<void> {
	await page.evaluate((id) => {
		const scroll = document.getElementById("scroll");
		const card = document.querySelector(`[data-task-id="${id}"]`);
		if (!scroll || !card) {
			return;
		}
		const cardRect = card.getBoundingClientRect();
		const scrollRect = scroll.getBoundingClientRect();
		scroll.scrollTop += cardRect.top - scrollRect.top + 24;
	}, FOCUSED_TASK_ID);
}

function readState(page: Page): Promise<string | undefined> {
	return page.evaluate(() => (window as unknown as { __pinState?: string }).__pinState);
}

function realCardVisibility(page: Page): Promise<string | null> {
	return page.evaluate((id) => {
		const card = document.querySelector(`[data-task-id="${id}"]`);
		return card ? getComputedStyle(card as HTMLElement).visibility : null;
	}, FOCUSED_TASK_ID);
}

test.describe("Focus View stage-header accordion (synthetic, real browser)", () => {
	test.beforeEach(async ({ page }) => {
		await page.setContent(buildSyntheticPage(), { waitUntil: "load" });
		await page.waitForFunction(() => (window as unknown as { __pinReady?: boolean }).__pinReady === true);
	});

	test("focused card centered → no focused-card clone, real card visible, not pinned", async ({ page }) => {
		await scrollFocusedCardIntoView(page);
		await page.waitForFunction(() => (window as unknown as { __pinState?: string }).__pinState === "hidden");
		await expect(page.getByTestId("stage-header-rail-focused-card")).toHaveCount(0);
		expect(await realCardVisibility(page)).toBe("visible");
		await expect(page.locator("#scroll")).not.toHaveAttribute("data-selected-pinned", "true");
	});

	test("scrolling the focused card's top past the viewport top pins its stage to the TOP rail, with the card, hiding the real card", async ({
		page,
	}) => {
		await scrollFocusedCardIntoView(page);
		await scrollFocusedTopAboveViewport(page);
		await page.waitForFunction(() => (window as unknown as { __pinState?: string }).__pinState === "pinTop");

		// 焦点 stage 卡头进顶 rail（__topPinned 含之），且顶 rail 挂焦点卡克隆。
		expect(await page.evaluate(() => (window as unknown as { __topPinned?: string }).__topPinned)).toContain(
			FOCUSED_COLUMN_ID,
		);
		const focusedClone = page.locator(
			'.kb-stage-header-rail[data-edge="top"] [data-testid="stage-header-rail-focused-card"]',
		);
		await expect(focusedClone).toHaveCount(1);
		await expect(focusedClone).toContainText("In Progress");
		// 真实焦点卡被 visibility:hidden 以免与克隆重影；scrollport 标 data-selected-pinned。
		expect(await realCardVisibility(page)).toBe("hidden");
		await expect(page.locator("#scroll")).toHaveAttribute("data-selected-pinned", "true");
	});

	test("scrolling to the bottom stacks every passed stage header in the top rail, in document order", async ({
		page,
	}) => {
		await setScrollTop(page, "max");
		await page.waitForFunction(() => (window as unknown as { __pinState?: string }).__pinState === "pinTop");
		// 滚过的 backlog / in_progress / review 卡头按文档序堆叠进顶 rail（末列 done 可能随内容在中间带，也可能
		// 因焦点卡使顶 rail 变高而被其覆盖一并进 rail——两者都合法，故只校验「文档序前缀」而非 done 的去留）。
		const railOrder = await page.evaluate(() =>
			[...document.querySelectorAll('.kb-stage-header-rail[data-edge="top"] [data-rail-stage]')].map((node) =>
				node.getAttribute("data-rail-stage"),
			),
		);
		expect(railOrder.slice(0, 3)).toEqual(["backlog", "in_progress", "review"]);
		// 顶 rail 挂焦点卡克隆（焦点 stage 在顶 rail 且焦点卡 pinTop）。
		await expect(
			page.locator('.kb-stage-header-rail[data-edge="top"] [data-testid="stage-header-rail-focused-card"]'),
		).toHaveCount(1);
	});

	test("scrolling above the focused stage pins its card to the BOTTOM rail; earlier stages sit at the top", async ({
		page,
	}) => {
		await setScrollTop(page, 0);
		await page.waitForFunction(() => (window as unknown as { __pinState?: string }).__pinState === "pinBottom");
		const focusedClone = page.locator(
			'.kb-stage-header-rail[data-edge="bottom"] [data-testid="stage-header-rail-focused-card"]',
		);
		await expect(focusedClone).toHaveCount(1);
		// 底 rail 含焦点及其后列；顶 rail 此时不含焦点。
		expect(await page.evaluate(() => (window as unknown as { __bottomPinned?: string }).__bottomPinned)).toContain(
			FOCUSED_COLUMN_ID,
		);
	});

	test("the focused-card clone carries no data-task-id (global uniqueness preserved)", async ({ page }) => {
		await setScrollTop(page, "max");
		await expect(page.getByTestId("stage-header-rail-focused-card")).toHaveCount(1);
		await expect(page.locator(`[data-task-id="${FOCUSED_TASK_ID}"]`)).toHaveCount(1);
	});

	test("regression: a single abrupt scroll jump (scrollbar drag) flips the focused card bottom→top rail", async ({
		page,
	}) => {
		await setScrollTop(page, 0);
		await expect(
			page.locator('.kb-stage-header-rail[data-edge="bottom"] [data-testid="stage-header-rail-focused-card"]'),
		).toHaveCount(1);
		// 一次性跳到底：焦点卡从下方瞬移到上方（中途从不相交）。实时几何重算正确翻到 top rail。
		await setScrollTop(page, "max");
		await expect(
			page.locator('.kb-stage-header-rail[data-edge="top"] [data-testid="stage-header-rail-focused-card"]'),
		).toHaveCount(1);
		expect(await readState(page)).toBe("pinTop");
	});

	test("seam: returning the focused card to view drops its clone and restores the real card", async ({ page }) => {
		await setScrollTop(page, "max");
		await expect(page.getByTestId("stage-header-rail-focused-card")).toHaveCount(1);
		expect(await realCardVisibility(page)).toBe("hidden");
		await scrollFocusedCardIntoView(page);
		await expect(page.getByTestId("stage-header-rail-focused-card")).toHaveCount(0);
		expect(await realCardVisibility(page)).toBe("visible");
		await expect(page.locator("#scroll")).not.toHaveAttribute("data-selected-pinned", "true");
	});

	// 需求核心（旧「折叠 → 钉住条消失」断言的反转）：折叠焦点 stage 后焦点任务仍留存。
	test("collapsing the focused stage while its card is in view keeps the card visible (peek)", async ({ page }) => {
		await scrollFocusedCardIntoView(page);
		await page.waitForFunction(() => (window as unknown as { __pinState?: string }).__pinState === "hidden");
		await page.evaluate(() =>
			(window as unknown as { __collapseSelectedStage: () => void }).__collapseSelectedStage(),
		);
		// 焦点卡仍在原位露出（真实卡，唯一 data-task-id），可见。
		await expect(page.locator(`[data-task-id="${FOCUSED_TASK_ID}"]`)).toHaveCount(1);
		expect(await realCardVisibility(page)).toBe("visible");
	});

	test("collapsing the focused stage while its card is scrolled off keeps it visible via the rail clone", async ({
		page,
	}) => {
		await setScrollTop(page, "max");
		await page.waitForFunction(() => (window as unknown as { __pinState?: string }).__pinState === "pinTop");
		await expect(page.getByTestId("stage-header-rail-focused-card")).toHaveCount(1);
		await page.evaluate(() =>
			(window as unknown as { __collapseSelectedStage: () => void }).__collapseSelectedStage(),
		);
		// 折叠后焦点卡仍经 rail 克隆可见（不再像旧钉住条那样消失）。
		await expect(page.getByTestId("stage-header-rail-focused-card")).toHaveCount(1);
		expect(await readState(page)).toBe("pinTop");
	});
});
