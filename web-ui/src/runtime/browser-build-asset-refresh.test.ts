import { describe, expect, it, vi } from "vitest";

import {
	didServedBuildAssetIdentifiersChange,
	readBuildAssetIdentifiersFromHtml,
	reloadBrowserIfServedBuildAssetsChanged,
} from "@/runtime/browser-build-asset-refresh";

function createIndexHtml(assetNames: string[]): string {
	const tags = assetNames
		.map((assetName) =>
			assetName.endsWith(".css")
				? `<link rel="stylesheet" href="/assets/${assetName}">`
				: `<script type="module" src="/assets/${assetName}"></script>`,
		)
		.join("\n");
	return `<!doctype html><html><head>${tags}</head><body><div id="root"></div></body></html>`;
}

describe("browser build asset refresh", () => {
	it("detects changed Vite build asset names", () => {
		expect(
			didServedBuildAssetIdentifiersChange(
				["/assets/index-old.js", "/assets/index-old.css"],
				["/assets/index-new.js", "/assets/index-new.css"],
			),
		).toBe(true);
	});

	it("does not treat matching build asset names as changed", () => {
		expect(
			didServedBuildAssetIdentifiersChange(
				["/assets/index-current.js", "/assets/index-current.css"],
				["/assets/index-current.js", "/assets/index-current.css"],
			),
		).toBe(false);
	});

	it("reloads when the served index now points at a different build", async () => {
		const currentDocument = new DOMParser().parseFromString(
			createIndexHtml(["index-old.js", "index-old.css"]),
			"text/html",
		);
		const fetchIndexHtml = vi.fn<typeof window.fetch>(async () => {
			return new Response(createIndexHtml(["index-new.js", "index-new.css"]), {
				status: 200,
			});
		});
		const reloadWindow = vi.fn();

		await expect(
			reloadBrowserIfServedBuildAssetsChanged({
				currentDocument,
				fetchIndexHtml,
				location: new URL("http://localhost:3484/project-1?task=abc#panel") as unknown as Location,
				reloadWindow,
			}),
		).resolves.toBe(true);

		expect(fetchIndexHtml).toHaveBeenCalledWith("http://localhost:3484/project-1", {
			cache: "no-store",
			headers: {
				Accept: "text/html",
			},
		});
		expect(reloadWindow).toHaveBeenCalledTimes(1);
	});

	it("parses scripts and stylesheets from served index HTML", () => {
		expect(
			readBuildAssetIdentifiersFromHtml(createIndexHtml(["index-a.js", "index-a.css"]), "http://localhost/"),
		).toEqual(["/assets/index-a.css", "/assets/index-a.js"]);
	});
});
