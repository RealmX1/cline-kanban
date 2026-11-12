import { createRoot } from "react-dom/client";
import { CodexConfigurationSyncNotice, CodexConfigurationSyncSettings, CodexConfigurationSyncSummaryButton } from "../src/components/codex-configuration-sync";
import { useCodexConfigurationSyncNotice } from "../src/hooks/use-codex-configuration-sync-notice";
import { notifyCodexConfigurationSyncUpdated } from "../src/runtime/codex-configuration-sync-query";
import "../src/styles/globals.css";
function CodexConfigurationDefaultsFeedbackBrowserHarness(){
 const notice=useCodexConfigurationSyncNotice({workspaceId:"isolated-defaults-feedback"});
 return <main className="min-h-dvh bg-surface-0 text-text-primary"><header className="flex flex-wrap items-center gap-3 border-b border-border bg-surface-1 px-4 py-3"><h1 className="m-0 text-lg font-semibold">Codex 配置预览</h1><label className="min-w-0 flex-1 text-sm">Agent 输入<input aria-label="Agent 输入" className="ml-2 min-h-9 max-w-full rounded border border-border bg-surface-2 px-2"/></label><button type="button" onClick={()=>notifyCodexConfigurationSyncUpdated()}>读取最新概览</button><CodexConfigurationSyncSummaryButton notice={notice}/></header><div className="mx-auto max-w-3xl px-4 pb-8"><CodexConfigurationSyncSettings workspaceId="isolated-defaults-feedback"/></div><CodexConfigurationSyncNotice notice={notice} onOpenSettings={()=>window.scrollTo(0,0)}/></main>;
}
createRoot(document.body.appendChild(document.createElement("div"))).render(<CodexConfigurationDefaultsFeedbackBrowserHarness/>);
