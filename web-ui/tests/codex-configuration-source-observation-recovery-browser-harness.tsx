import { createRoot } from "react-dom/client";
import {
	CodexConfigurationSyncNotice,
	CodexConfigurationSyncSettings,
	CodexConfigurationSyncSummaryButton,
} from "../src/components/codex-configuration-sync";
import { useCodexConfigurationSyncNotice } from "../src/hooks/use-codex-configuration-sync-notice";
import { notifyCodexConfigurationSyncUpdated } from "../src/runtime/codex-configuration-sync-query";
import "../src/styles/globals.css";

function SourceObservationRecoveryBrowserHarness() {
	const notice = useCodexConfigurationSyncNotice({ workspaceId: "isolated-source-workspace" });
	return (
		<main className="min-h-dvh bg-surface-0 p-4 text-text-primary">
			<button type="button" onClick={() => notifyCodexConfigurationSyncUpdated("runtime_reconnected")}>模拟运行时重连</button>
			<CodexConfigurationSyncSummaryButton notice={notice} />
			<div className="relative h-96" aria-label="通知展示区域">
				<CodexConfigurationSyncNotice notice={notice} onOpenSettings={() => {}} />
			</div>
			<section aria-label="隔离配置设置页"><CodexConfigurationSyncSettings workspaceId="isolated-source-workspace" /></section>
		</main>
	);
}

createRoot(document.body.appendChild(document.createElement("div"))).render(<SourceObservationRecoveryBrowserHarness />);
