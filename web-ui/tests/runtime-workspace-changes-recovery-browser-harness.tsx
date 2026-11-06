import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useRuntimeWorkspaceChanges } from "@/runtime/use-runtime-workspace-changes";

function WorkspaceChangesRecoveryBrowserHarness() {
	const [taskId, setTaskId] = useState("first-task");
	const changes = useRuntimeWorkspaceChanges(taskId, "isolated-project", "main", null, "working_copy", 0, 1_000);
	return <main>
		<button type="button" onClick={() => void changes.refresh()}>刷新读取</button>
		<button type="button" onClick={() => setTaskId("second-task")}>切换任务</button>
		<output data-testid="query-phase">{changes.queryPhase}</output>
		{changes.error ? <p role="alert">{changes.error.message}</p> : null}
		<pre data-testid="diff-paths">{changes.changes?.files.map((file) => file.path).join(",") ?? ""}</pre>
	</main>;
}
const root = document.getElementById("root");
if (!root) throw new Error("缺少隔离读取核验挂载点。");
createRoot(root).render(<WorkspaceChangesRecoveryBrowserHarness />);
