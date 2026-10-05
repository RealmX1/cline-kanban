import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);
const rootPkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf-8")) as { version: string };

export default defineConfig({
	plugins: [react()],
	define: {
		__APP_VERSION__: JSON.stringify(rootPkg.version),
	},
	resolve: {
		alias: {
			// 模型只由插件间接依赖；统一身份以允许离线测试替换模型。
			"@tensorflow-models/universal-sentence-encoder": require.resolve(
				"@tensorflow-models/universal-sentence-encoder",
				{ paths: [require.resolve("@orama/plugin-embeddings")] },
			),
			"@": resolve(__dirname, "src"),
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
		conditions: ["import", "module", "browser", "default"],
	},
	test: {
		server: { deps: { inline: ["@orama/plugin-embeddings"] } },
		environment: "jsdom",
		include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
		passWithNoTests: true,
		setupFiles: ["./vitest.setup.ts"],
	},
});
