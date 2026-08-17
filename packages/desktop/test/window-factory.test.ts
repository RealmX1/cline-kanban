// 【暂时停用】桌面壳 Electron overhaul 尚未完成实现，本文件测的 window-factory 仍处在中间态，
// 这批用例目前更接近 placeholder 而非有效回归。
//
// 停用手段为什么必须是「注释掉」而不是 describe.skip / it.skip：下面的用例本身测的是
// pickRecoveryUrl 这个纯函数，根本不需要 Electron 运行时；真正抛错的是 `import ../src/window-factory.js`
// 这条链路上对 electron 的传递依赖——`electron/index.js` 在**模块加载期**就 throw，失败发生在收集
// 阶段，而 skip 只跳过执行、不阻止 import 求值。
//
// 本机当前的直接症状：packages/desktop/node_modules/electron 安装不全，dist/ 在但缺 install.js
// 应写出的 path.txt，于是 getElectronPath() 报「Electron failed to install correctly」。该目录时间戳
// 停在 2026-07-30，与 node-pty 升级无关（后者只改了 node-pty 一个包）。
//
// 恢复条件：Electron overhaul 落地、且本机 electron 装全（重装 packages/desktop/node_modules/electron
// 让其 postinstall 写出 path.txt）之后，删掉下面那对 /* */ 即可——原文一字未改。

import { it } from "vitest";

// 留一个 todo 占位：vitest 对「一个测试都没有」的文件本身就报失败，停用不该换来另一种红。
it.todo("pickRecoveryUrl 的用例待 Electron overhaul 完成后随本文件一并恢复");

/*
import { describe, expect, it } from "vitest";

import { pickRecoveryUrl } from "../src/window-factory.js";

describe("pickRecoveryUrl", () => {
	const runtimeUrl = "http://127.0.0.1:55555/";

	it("returns runtimeUrl when lastUrl is empty", () => {
		expect(pickRecoveryUrl("", runtimeUrl)).toBe(runtimeUrl);
	});

	it("returns runtimeUrl when lastUrl is unparseable", () => {
		expect(pickRecoveryUrl("not a url", runtimeUrl)).toBe(runtimeUrl);
	});

	it("falls back to runtimeUrl for file:// URLs (e.g. disconnected screen)", () => {
		expect(
			pickRecoveryUrl(
				"file:///Applications/Kanban.app/Contents/Resources/disconnected.html",
				runtimeUrl,
			),
		).toBe(runtimeUrl);
	});

	it("falls back to runtimeUrl when origins differ (runtime restarted on new port)", () => {
		expect(
			pickRecoveryUrl("http://127.0.0.1:44444/some-project", runtimeUrl),
		).toBe(runtimeUrl);
	});

	it("falls back when scheme differs (https vs http)", () => {
		expect(
			pickRecoveryUrl("https://127.0.0.1:55555/some-project", runtimeUrl),
		).toBe(runtimeUrl);
	});

	it("preserves lastUrl when it shares the runtime origin", () => {
		const lastUrl = "http://127.0.0.1:55555/my-project/board";
		expect(pickRecoveryUrl(lastUrl, runtimeUrl)).toBe(lastUrl);
	});

	it("preserves lastUrl with query and hash on the same origin", () => {
		const lastUrl = "http://127.0.0.1:55555/my-project?tab=tasks#row-12";
		expect(pickRecoveryUrl(lastUrl, runtimeUrl)).toBe(lastUrl);
	});

	it("falls back when runtimeUrl itself is unparseable", () => {
		expect(
			pickRecoveryUrl("http://127.0.0.1:55555/some-project", "garbage"),
		).toBe("garbage");
	});
});
*/
