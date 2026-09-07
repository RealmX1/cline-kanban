import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A-P0-7 把 motion / framer-motion 从 web-ui 移除（动画全部改走纯 CSS，见
 * `styles/globals.css` 的 kb-text-shimmer-sweep 等）。这条边界防它悄悄回魂：
 * 任何「重新 `npm install motion`」都必须先改动 web-ui/package.json，会被这里拦下。
 */
describe("web-ui dependency boundary", () => {
	it("does not declare motion / framer-motion in dependencies or devDependencies", () => {
		const packageJsonPath = resolve(dirname(fileURLToPath(import.meta.url)), "../package.json");
		const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
		};

		for (const field of ["dependencies", "devDependencies"] as const) {
			const declaredNames = Object.keys(packageJson[field] ?? {});
			expect(declaredNames, `web-ui ${field} must stay free of motion libraries`).not.toContain("motion");
			expect(declaredNames, `web-ui ${field} must stay free of motion libraries`).not.toContain("framer-motion");
		}
	});
});
