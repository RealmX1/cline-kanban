import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, type Page, test } from "@playwright/test";

import {
	extractFunctionSource,
	extractUseHotkeysDeclarationStrings,
	stripTypeAnnotations,
} from "./production-source-extraction";

/**
 * 「切卡热键 alt+↑/↓ 必须穿过 xterm 抵达 document」的真实浏览器验证。
 *
 * 为什么非得进真浏览器：这条链路的每一环都在 jsdom 之外——真实 Chromium 把 Alt+方向键送进 xterm 的
 * helper textarea、xterm 的 `_keyDown` 决定是否 `preventDefault` 并向 PTY 发 escape sequence、事件
 * 再冒泡到 document 级热键。jsdom 里既没有真 xterm 也没有真正的键盘派发路径，只测得到「热键回调被
 * 调用了」，测不到「热键还有没有机会被调用」。
 *
 * 不连接 runtime（既不改动用户真实看板，也绕开 CORS 网关）：用 page.setContent 造合成页，把生产源码里
 * 的判定函数与热键声明字符串**逐字**取出注入。**终端侧**（persistent-terminal-manager 的
 * isAdjacentTaskCardNavigationShortcut 与
 * shouldReleaseAdjacentTaskCardNavigationShortcutToDocumentHotkeyOwner）的放行口径若退化——放行范围
 * 扩大到裸方向键，或忘了排除 ctrl/shift，或在**没有接管者**的终端上下文里也照样放行——都会把按键送进
 * 「xterm 不处理、document 也不接」的两不管地带，下面的用例会立刻红。
 *
 * 两种上下文都必须覆盖，因为 PersistentTerminal 有三处挂载点、只有一处带切卡热键：详情视图
 * （CardDetailView，注册了 alt+↑/↓）、首页底部 shell 终端（App.tsx）、首页侧栏 agent 终端
 * （use-home-sidebar-agent-panel.tsx）。后两处没有任何接管者，放行在那里等于把按键吞掉。
 *
 * 信号边界（别过度期待）：详情视图侧守卫 shouldIgnoreAdjacentCardHotkey 的 ctrl/meta 排除**不在**本
 * 文件的信号范围内。终端侧一旦正确吞下按键，事件根本到不了 document，守卫改不改都测不出来；那一侧
 * 由 src/components/card-detail-view.test.tsx 的 jsdom 用例覆盖。因此这里的每条「不切卡」用例都必须
 * 额外断言终端的出站字节，否则就退化成两条失效路径都满足的空转。
 */

const currentDir = dirname(fileURLToPath(import.meta.url));

const terminalManagerSource = readFileSync(
	resolve(currentDir, "../src/terminal/persistent-terminal-manager.ts"),
	"utf-8",
);
const cardDetailViewSource = readFileSync(resolve(currentDir, "../src/components/card-detail-view.tsx"), "utf-8");

const productionKeyboardPredicates = [
	stripTypeAnnotations(extractFunctionSource(terminalManagerSource, "isAdjacentTaskCardNavigationShortcut")),
	stripTypeAnnotations(
		extractFunctionSource(
			terminalManagerSource,
			"shouldReleaseAdjacentTaskCardNavigationShortcutToDocumentHotkeyOwner",
		),
	),
	stripTypeAnnotations(extractFunctionSource(cardDetailViewSource, "isEventInsideDialog")),
	stripTypeAnnotations(extractFunctionSource(cardDetailViewSource, "shouldIgnoreAdjacentCardHotkey")),
].join("\n\n");

// 生产究竟把切卡绑在了哪两个热键上——逐字取自 card-detail-view 的两处 useHotkeys 调用。
const adjacentCardHotkeyDeclarations = extractUseHotkeysDeclarationStrings(cardDetailViewSource);

const xtermScript = readFileSync(resolve(currentDir, "../node_modules/@xterm/xterm/lib/xterm.js"), "utf-8");
const xtermStyles = readFileSync(resolve(currentDir, "../node_modules/@xterm/xterm/css/xterm.css"), "utf-8");

const ESCAPE = String.fromCharCode(27);
const CURSOR_UP_SEQUENCE = `${ESCAPE}[A`;
const CURSOR_DOWN_SEQUENCE = `${ESCAPE}[B`;
// xterm 对带修饰键的方向键发 CSI 1;<modifier> A/B；modifier = 1 + shift(1) + alt(2) + ctrl(4)。
// modifier 3 = alt(2) + 1，即没有接管者时 alt+↑/↓ 本该照常落给 agent 的那两条序列。
const ALT_CURSOR_UP_SEQUENCE = `${ESCAPE}[1;3A`;
const ALT_CURSOR_DOWN_SEQUENCE = `${ESCAPE}[1;3B`;
const SHIFT_ALT_CURSOR_UP_SEQUENCE = `${ESCAPE}[1;4A`;
const SHIFT_ALT_CURSOR_DOWN_SEQUENCE = `${ESCAPE}[1;4B`;
// modifier 7 = ctrl(4) + alt(2) + 1，正是 Windows 上 AltGr+↑ 落到终端时该发出的序列。
const CTRL_ALT_CURSOR_UP_SEQUENCE = `${ESCAPE}[1;7A`;

interface AdjacentTaskCardHotkeyProbe {
	defaultPreventedKeys: string[];
	terminalOutboundData: string[];
	selectedAdjacentCardSteps: number[];
}

// 合成页脚本。终端侧的放行分支与详情视图侧的热键守卫都用生产源码原文；document 监听器复刻
// react-hotkeys-hook 的到达条件（挂在 document 上、在输入框里也生效）与它的修饰键精确匹配语义。
//
// isMountedInsideAdjacentTaskCardNavigationHotkeyOwnerView 同时驱动两侧，正如生产里那样：为 true 时
// 终端才放行、document 上才有那两条切卡热键；为 false 时（首页 shell 终端 / 首页侧栏 agent 终端）
// 终端不放行、document 上也确实没有任何接管者。两者必须同进同退，否则用例测的就不是真实组合。
function buildSyntheticTerminalPageScript(isMountedInsideAdjacentTaskCardNavigationHotkeyOwnerView: boolean): string {
	return `
const isMountedInsideAdjacentTaskCardNavigationHotkeyOwnerView = ${isMountedInsideAdjacentTaskCardNavigationHotkeyOwnerView};

${productionKeyboardPredicates}

const adjacentCardHotkeyDeclarations = ${JSON.stringify(adjacentCardHotkeyDeclarations)};

// react-hotkeys-hook 5.2.4 对**未声明**的修饰键做精确拒绝：dist/index.js 的匹配函数里
// \`declaredShift !== event.shiftKey\` 一旦成立就直接 return false（alt / ctrl / meta 同理），
// 所以 useHotkeys("alt+up") 在 Shift 按下时并不匹配。合成页必须复刻这条精确匹配，否则「热键其实
// 根本没触发」会被误记成「成功切卡」，Shift+Alt+↑ 这种两不管地带就被测试掩盖了。
// 库按 event.code（而非 event.key）匹配键位，这里也照做。
const HOTKEY_MODIFIER_TOKENS = ["shift", "alt", "meta", "mod", "ctrl", "control"];
const HOTKEY_KEY_TOKEN_ALIASES = {
	up: "arrowup",
	down: "arrowdown",
	left: "arrowleft",
	right: "arrowright",
	esc: "escape",
	return: "enter",
};

function normalizeHotkeyToken(token) {
	const trimmed = token.trim().toLowerCase();
	return (HOTKEY_KEY_TOKEN_ALIASES[trimmed] || trimmed).replace(/key|digit|numpad/, "");
}

function matchesHotkeyDeclarationWithExactModifiers(event, declaration) {
	const declaredTokens = declaration.split("+").map(normalizeHotkeyToken);
	const declaredKeyTokens = declaredTokens.filter((token) => !HOTKEY_MODIFIER_TOKENS.includes(token));
	if (!declaredKeyTokens.includes(normalizeHotkeyToken(event.code))) {
		return false;
	}
	return (
		declaredTokens.includes("alt") === event.altKey &&
		declaredTokens.includes("shift") === event.shiftKey &&
		declaredTokens.includes("meta") === event.metaKey &&
		(declaredTokens.includes("ctrl") || declaredTokens.includes("control")) === event.ctrlKey
	);
}

const probe = { defaultPreventedKeys: [], terminalOutboundData: [], selectedAdjacentCardSteps: [] };
window.adjacentTaskCardHotkeyProbe = probe;

const terminal = new window.Terminal({ rows: 20, cols: 80 });
terminal.onData((data) => {
	probe.terminalOutboundData.push(data);
});
terminal.attachCustomKeyEventHandler(
	(event) =>
		!shouldReleaseAdjacentTaskCardNavigationShortcutToDocumentHotkeyOwner(
			event,
			isMountedInsideAdjacentTaskCardNavigationHotkeyOwnerView,
		),
);
terminal.open(document.getElementById("terminal-host"));
terminal.focus();

document.addEventListener("keydown", (event) => {
	if (event.defaultPrevented) {
		probe.defaultPreventedKeys.push(event.key);
		return;
	}
	if (!isMountedInsideAdjacentTaskCardNavigationHotkeyOwnerView) {
		// 首页终端上下文：CardDetailView 没挂载，document 上根本不存在切卡热键，按键无人接管。
		return;
	}
	if (shouldIgnoreAdjacentCardHotkey(event)) {
		return;
	}
	const matchedDeclaration = adjacentCardHotkeyDeclarations.find((declaration) =>
		matchesHotkeyDeclarationWithExactModifiers(event, declaration),
	);
	if (!matchedDeclaration) {
		return;
	}
	event.preventDefault();
	// 生产里 alt+↑ 走上一张（-1）、alt+↓ 走下一张（+1）。
	probe.selectedAdjacentCardSteps.push(matchedDeclaration.includes("up") ? -1 : 1);
});
`;
}

/** 详情视图上下文：终端挂在 CardDetailView 内部，切卡热键就在 document 上等着。 */
async function openSyntheticTerminalPageInsideAdjacentCardHotkeyOwner(page: Page): Promise<void> {
	await openSyntheticTerminalPage(page, true);
}

/** 首页终端上下文：没有 CardDetailView，document 上没有任何切卡热键接管者。 */
async function openSyntheticTerminalPageWithoutAdjacentCardHotkeyOwner(page: Page): Promise<void> {
	await openSyntheticTerminalPage(page, false);
}

async function openSyntheticTerminalPage(
	page: Page,
	isMountedInsideAdjacentTaskCardNavigationHotkeyOwnerView: boolean,
): Promise<void> {
	await page.setContent(
		`<style>${xtermStyles}</style><div id="terminal-host" style="width:640px;height:320px"></div>`,
	);
	await page.addScriptTag({ content: xtermScript });
	await page.addScriptTag({
		content: buildSyntheticTerminalPageScript(isMountedInsideAdjacentTaskCardNavigationHotkeyOwnerView),
	});
}

async function readProbe(page: Page): Promise<AdjacentTaskCardHotkeyProbe> {
	return await page.evaluate(
		() =>
			(window as unknown as { adjacentTaskCardHotkeyProbe: AdjacentTaskCardHotkeyProbe })
				.adjacentTaskCardHotkeyProbe,
	);
}

test("生产把切卡绑在 alt+↑/↓ —— 合成页的热键判定跟着生产声明走", () => {
	expect(adjacentCardHotkeyDeclarations).toEqual(["alt+up", "alt+down"]);
});

test("焦点在终端里时 alt+↑/↓ 穿过 xterm 抵达切卡热键，且不向 agent 发任何字节", async ({ page }) => {
	await openSyntheticTerminalPageInsideAdjacentCardHotkeyOwner(page);

	await page.keyboard.press("Alt+ArrowUp");
	await page.keyboard.press("Alt+ArrowDown");

	const probe = await readProbe(page);
	expect(probe.selectedAdjacentCardSteps).toEqual([-1, 1]);
	// xterm 若处理了这两个键，就会把它们转成 escape sequence 发给 PTY——这里必须一个字节都没有。
	expect(probe.terminalOutboundData).toEqual([]);
	// 到达 document 时还没被 preventDefault，热键才有机会生效。
	expect(probe.defaultPreventedKeys).toEqual([]);
});

test("裸方向键仍归终端所有 —— 放行范围没有过度扩大", async ({ page }) => {
	await openSyntheticTerminalPageInsideAdjacentCardHotkeyOwner(page);

	await page.keyboard.press("ArrowUp");
	await page.keyboard.press("ArrowDown");

	const probe = await readProbe(page);
	expect(probe.selectedAdjacentCardSteps).toEqual([]);
	// 光标上/下的 escape sequence 照常发给 agent。
	expect(probe.terminalOutboundData).toEqual([CURSOR_UP_SEQUENCE, CURSOR_DOWN_SEQUENCE]);
});

test("ctrl+alt+↑ 仍归终端所有 —— Windows 的 AltGr 会同时置位 ctrl 与 alt，终端侧不得把它放行", async ({ page }) => {
	// 只断言「没切卡」是空转的：selectedAdjacentCardSteps 在两条完全不同的失效路径下都会是空——
	// 终端侧忘了排除 ctrl（把按键放行成「xterm 不处理、document 又被守卫拒绝」的两不管地带），
	// 与守卫侧把它拦下（终端本就没放行、按键根本到不了 document），二者结果无法区分。
	// 所以必须再断言终端确实照常发出了 CSI 序列，这条用例才对**终端侧**的 ctrl 排除有信号。
	// 守卫侧的 ctrl 排除不归本文件管，由 src/components/card-detail-view.test.tsx 的
	// 「ctrl+alt+↑ 不切卡」jsdom 用例覆盖——那条直接向 document 派发按键，不经 xterm。
	await openSyntheticTerminalPageInsideAdjacentCardHotkeyOwner(page);

	await page.keyboard.press("Control+Alt+ArrowUp");

	const probe = await readProbe(page);
	expect(probe.selectedAdjacentCardSteps).toEqual([]);
	// 必须原样落到 agent 手里：终端对 ctrl+alt+方向键有自己的 CSI 序列。
	expect(probe.terminalOutboundData).toEqual([CTRL_ALT_CURSOR_UP_SEQUENCE]);
});

test("shift+alt+↑/↓ 不落进两不管地带 —— 热键既然不匹配，按键就必须留给 agent", async ({ page }) => {
	// 这是终端放行判定与热键声明之间最容易裂开的缝：热键声明的是 alt+up，react-hotkeys-hook 在
	// shiftKey 置位时精确拒绝；终端侧若不同步排除 shift，就会把这两个键放行成「xterm 不处理、
	// document 也不接」——不切卡、不发字节，按下去什么都不发生。
	await openSyntheticTerminalPageInsideAdjacentCardHotkeyOwner(page);

	await page.keyboard.press("Shift+Alt+ArrowUp");
	await page.keyboard.press("Shift+Alt+ArrowDown");

	const probe = await readProbe(page);
	expect(probe.selectedAdjacentCardSteps).toEqual([]);
	// 必须原样落到 agent 手里：终端对 shift+alt+方向键有自己的 CSI 序列。
	expect(probe.terminalOutboundData).toEqual([SHIFT_ALT_CURSOR_UP_SEQUENCE, SHIFT_ALT_CURSOR_DOWN_SEQUENCE]);
});

test("没有切卡热键接管者的终端里 alt+↑/↓ 必须照常发给 agent —— 放行不得无条件生效", async ({ page }) => {
	// 首页底部 shell 终端（App.tsx）与首页侧栏 agent 终端（use-home-sidebar-agent-panel.tsx）都在没有
	// CardDetailView 的情况下独立挂载，document 上根本没有 alt+↑/↓ 热键。放行若无条件生效，这两个键
	// 就掉进两不管地带：xterm 因为放行既不发字节也不 preventDefault，document 又没人接——用户在首页
	// 终端里按 alt+方向键什么都不会发生。
	await openSyntheticTerminalPageWithoutAdjacentCardHotkeyOwner(page);

	await page.keyboard.press("Alt+ArrowUp");
	await page.keyboard.press("Alt+ArrowDown");

	const probe = await readProbe(page);
	// 这条断言才是本用例的信号所在：无条件放行时这里会是空数组（按键被静默吞掉）。
	expect(probe.terminalOutboundData).toEqual([ALT_CURSOR_UP_SEQUENCE, ALT_CURSOR_DOWN_SEQUENCE]);
	expect(probe.selectedAdjacentCardSteps).toEqual([]);
});

test("没有接管者时裸方向键照旧归终端 —— 新加的接管者门没有顺手改掉别的按键", async ({ page }) => {
	await openSyntheticTerminalPageWithoutAdjacentCardHotkeyOwner(page);

	await page.keyboard.press("ArrowUp");
	await page.keyboard.press("ArrowDown");

	const probe = await readProbe(page);
	expect(probe.terminalOutboundData).toEqual([CURSOR_UP_SEQUENCE, CURSOR_DOWN_SEQUENCE]);
	expect(probe.selectedAdjacentCardSteps).toEqual([]);
});
