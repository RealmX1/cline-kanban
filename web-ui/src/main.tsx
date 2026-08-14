import ReactDOM from "react-dom/client";
import { Toaster } from "sonner";

import App from "@/App";
import { AppErrorBoundary } from "@/components/app-error-boundary";
import { PasscodeGateProvider } from "@/components/passcode-gate";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UserInterfacePreferenceMigrationConflictNotice } from "@/components/user-interface-preference-migration-conflict-notice";
import { isThemeId } from "@/hooks/use-theme";
import { startLoadingUserInterfacePreferencesSharedAcrossBrowserOrigins } from "@/runtime/user-interface-preferences-shared-across-browser-origins-store";
import { migrateRenamedLocalStorageKeysIntoCurrentKeys } from "@/storage/legacy-local-storage-key-rename-migration";
import { TelemetryProvider } from "@/telemetry/posthog-provider";
import { initializeSentry } from "@/telemetry/sentry";
import "@/styles/globals.css";

initializeSentry();

// 必须早于 React 渲染：任何消费者一旦先读到空值并把默认值写回新键，搬迁就再也搬不动了。
migrateRenamedLocalStorageKeysIntoCurrentKeys();

// 异步：读到之前界面先用 localStorage 镜像跑，读到后再切到服务端那份并把本地那份合并上去。
startLoadingUserInterfacePreferencesSharedAcrossBrowserOrigins();

// Apply the persisted theme synchronously before first paint to prevent a flash.
try {
	const _savedTheme = localStorage.getItem("kanban.theme");
	if (isThemeId(_savedTheme) && _savedTheme !== "default") {
		document.documentElement.setAttribute("data-theme", _savedTheme);
	}
} catch {
	// Ignore storage access failures and keep the default theme.
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Root element was not found.");
}

ReactDOM.createRoot(root).render(
	<PasscodeGateProvider>
		<TelemetryProvider>
			<AppErrorBoundary>
				<TooltipProvider>
					<App />
					<UserInterfacePreferenceMigrationConflictNotice />
					<Toaster
						theme="dark"
						position="bottom-right"
						// 抬高 toast 起始位置：既避开常驻的 bug 反馈 FAB（右下胶囊），也避开
						// Post-Deploy Verification 折叠 badge（fixed bottom-20，底 80px + 高约 38px），
						// 让 toast 堆叠在两者上方而不是盖住可点击控件。
						offset={{ bottom: 130 }}
						toastOptions={{
							style: {
								background: "var(--color-surface-1)",
								border: "1px solid var(--color-border)",
								color: "var(--color-text-primary)",
								fontSize: "13px",
								whiteSpace: "pre-line",
							},
						}}
					/>
				</TooltipProvider>
			</AppErrorBoundary>
		</TelemetryProvider>
	</PasscodeGateProvider>,
);
