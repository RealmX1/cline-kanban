import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type ResolvedConfig, transformWithEsbuild } from "vite";

const rootPkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf-8")) as { version: string };
const XTERM_CHUNK_NAME = "xterm-vendor";

function isXtermModule(id: string): boolean {
	return id.includes("/node_modules/@xterm/") || id.includes("\\node_modules\\@xterm\\");
}

function selectiveBuildMinifyPlugin(): Plugin {
	let resolvedConfig: ResolvedConfig | null = null;

	return {
		name: "kanban-selective-build-minify",
		apply: "build",
		configResolved(config) {
			resolvedConfig = config;
		},
		async renderChunk(code, chunk, outputOptions) {
			if (!resolvedConfig || !chunk.fileName.endsWith(".js")) {
				return null;
			}
			if (Object.keys(chunk.modules).some((id) => isXtermModule(id))) {
				return null;
			}
			const minified = await transformWithEsbuild(
				code,
				chunk.fileName,
				{
					format: outputOptions.format === "cjs" ? "cjs" : "esm",
					minify: true,
					sourcemap: Boolean(resolvedConfig.build.sourcemap),
					treeShaking: true,
				},
				undefined,
				resolvedConfig,
			);
			return {
				code: minified.code,
				map: minified.map ?? null,
			};
		},
	};
}

export default defineConfig({
	// OpenCode broke in production because esbuild minification corrupted xterm's
	// requestMode handling. We isolate all @xterm code into its own chunk and leave
	// that chunk unminified, while still minifying the rest of the app here.
	// Compared with leaving the entire frontend unminified, this saves about
	// 770 KB raw and 108.5 KB gzipped across emitted frontend assets.
	// Compared with fully minifying everything, this costs about 545 KB raw and
	// 58.5 KB gzipped, which is the current tradeoff for keeping OpenCode stable.
	plugins: [tailwindcss(), react(), selectiveBuildMinifyPlugin()],
	worker: { format: "es" },
	envPrefix: ["VITE_", "POSTHOG_"],
	define: {
		__APP_VERSION__: JSON.stringify(rootPkg.version),
	},
	build: {
		// esbuild minification corrupts xterm's DECRQM requestMode helper in the
		// production bundle, which breaks full-screen TUIs like OpenCode at runtime.
		// Keep xterm unminified, but selectively minify the rest of the app below.
		minify: false,
		sourcemap: true,
		rollupOptions: {
			output: {
				manualChunks(id) {
					if (isXtermModule(id)) {
						return XTERM_CHUNK_NAME;
					}
					return undefined;
				},
			},
		},
	},
	resolve: {
		alias: {
			"@runtime-agent-prompt-image-attachment-reference": resolve(
				__dirname,
				"../src/core/agent-prompt-image-attachment-reference.ts",
			),
			"@runtime-work-unit-relation-modeling-api-contract": resolve(
				__dirname,
				"../src/core/work-unit-relation-modeling-api-contract.ts",
			),
			"@": resolve(__dirname, "src"),
			"@runtime-project-visual-identity": resolve(__dirname, "../src/core/project-visual-identity.ts"),
			"@runtime-agent-catalog": resolve(__dirname, "../src/core/agent-catalog.ts"),
			"@runtime-agent-session-transport-selection": resolve(
				__dirname,
				"../src/core/agent-session-transport-selection.ts",
			),
			"@runtime-cline-tool-call-display": resolve(__dirname, "../src/cline-sdk/cline-tool-call-display.ts"),
			"@runtime-home-agent-session": resolve(__dirname, "../src/core/home-agent-session.ts"),
			// dd2db 1b Relations 面板要用 kind 注册表（值引用），所以 tsconfig / vite / vitest 三处同步。
			"@runtime-inter-work-unit-recorded-relation-projection-contract": resolve(
				__dirname,
				"../src/core/inter-work-unit-recorded-relation-projection-contract.ts",
			),
			// dd2db 2.1 断言型关系：「添加关系」对话框列 kind、面板按决策来源分组都是值引用，同样三处同步。
			"@runtime-inter-work-unit-asserted-relation-kind-registry-contract": resolve(
				__dirname,
				"../src/core/inter-work-unit-asserted-relation-kind-registry-contract.ts",
			),
			"@runtime-inter-work-unit-relation-assertion-lifecycle-event-contract": resolve(
				__dirname,
				"../src/core/inter-work-unit-relation-assertion-lifecycle-event-contract.ts",
			),
			"@runtime-kanban-web-ui-page-load-request-origin-nonce": resolve(
				__dirname,
				"../src/core/kanban-web-ui-page-load-request-origin-nonce.ts",
			),
			"@runtime-last-conversation-progress-observation": resolve(
				__dirname,
				"../src/core/last-conversation-progress-observation.ts",
			),
			"@runtime-notification-intelligence-purpose-binding-problems": resolve(
				__dirname,
				"../src/core/notification-intelligence-purpose-binding-problems.ts",
			),
			"@runtime-post-deploy-verification-done-entry-closure-contract": resolve(
				__dirname,
				"../src/core/post-deploy-verification-done-entry-closure-contract.ts",
			),
			"@runtime-post-deploy-verification-task-closed-and-awaiting-verification-predicates": resolve(
				__dirname,
				"../src/core/post-deploy-verification-task-closed-and-awaiting-verification-predicates.ts",
			),
			"@runtime-cross-project-recently-active-task-switcher-section-assignment": resolve(
				__dirname,
				"../src/core/cross-project-recently-active-task-switcher-section-assignment.ts",
			),
			"@runtime-session-activity": resolve(__dirname, "../src/core/session-activity.ts"),
			"@runtime-state-stream-workspace-metadata-probe-scope-declaration": resolve(
				__dirname,
				"../src/core/runtime-state-stream-workspace-metadata-probe-scope-declaration.ts",
			),
			"@runtime-shortcuts": resolve(__dirname, "../src/config/shortcut-utils.ts"),
			"@runtime-task-agent-permission-mode": resolve(__dirname, "../src/core/task-agent-permission-mode.ts"),
			"@runtime-task-card-action-board-column-transitions": resolve(
				__dirname,
				"../src/core/task-card-action-board-column-transitions.ts",
			),
			"@runtime-task-create-base-ref-resolution": resolve(
				__dirname,
				"../src/core/task-create-base-ref-resolution.ts",
			),
			"@runtime-task-id": resolve(__dirname, "../src/core/task-id.ts"),
			"@runtime-task-pinboard-pinning": resolve(__dirname, "../src/core/task-pinboard-pinning.ts"),
			"@runtime-task-title": resolve(__dirname, "../src/core/task-title.ts"),
			"@runtime-task-worktree-path": resolve(__dirname, "../src/workspace/task-worktree-path.ts"),
			"@runtime-task-state": resolve(__dirname, "../src/core/task-board-mutations.ts"),
		},
	},
	server: {
		host: "127.0.0.1",
		port: Number(process.env.KANBAN_WEB_UI_PORT || "4173"),
		strictPort: true,
		proxy: {
			"/api": {
				target: `http://127.0.0.1:${process.env.KANBAN_RUNTIME_PORT || "3484"}`,
				changeOrigin: true,
				ws: true,
			},
		},
	},
});
