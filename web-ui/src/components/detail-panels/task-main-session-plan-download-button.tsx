import { Download } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogHeader } from "@/components/ui/dialog";
import { fetchTaskMainSessionPlan, startTaskFileDownload } from "@/runtime/task-file-download-query";
import type { RuntimeTaskMainSessionPlanResponse } from "@/runtime/types";

export function TaskMainSessionPlanDownloadButton({
	workspaceId,
	taskId,
	taskCreatedAtEpochMs,
}: {
	workspaceId: string | null;
	taskId: string;
	taskCreatedAtEpochMs: number;
}) {
	const [busy, setBusy] = useState(false);
	const [open, setOpen] = useState(false);
	const [result, setResult] = useState<RuntimeTaskMainSessionPlanResponse | null>(null);
	const [error, setError] = useState<string | null>(null);
	const generation = useRef(0);
	const downloadAbortController = useRef<AbortController | null>(null);
	useEffect(() => {
		downloadAbortController.current = new AbortController();
		generation.current++;
		setBusy(false);
		setOpen(false);
		setResult(null);
		setError(null);
		return () => {
			generation.current++;
			downloadAbortController.current?.abort();
		};
	}, [workspaceId, taskId, taskCreatedAtEpochMs]);
	const download = async (candidateId: string) => {
		if (!workspaceId) return;
		const requestedGeneration = generation.current;
		setBusy(true);
		try {
			await startTaskFileDownload(
				workspaceId,
				{
					taskId,
					expectedTaskIncarnationCreatedAtEpochMs: taskCreatedAtEpochMs,
					source: "main_session_plan",
					candidateId,
				},
				downloadAbortController.current?.signal,
			);
			if (generation.current === requestedGeneration) setOpen(false);
		} catch (failure) {
			if (generation.current === requestedGeneration) {
				setError(failure instanceof Error ? failure.message : "Plan 下载失败，请重试。");
				setOpen(true);
			}
		} finally {
			if (generation.current === requestedGeneration) setBusy(false);
		}
	};
	const load = async () => {
		if (!workspaceId) return;
		const requestedGeneration = generation.current;
		setBusy(true);
		setError(null);
		try {
			const plan = await fetchTaskMainSessionPlan(workspaceId, {
				taskId,
				expectedTaskIncarnationCreatedAtEpochMs: taskCreatedAtEpochMs,
			});
			if (generation.current !== requestedGeneration) return;
			setResult(plan);
			if (plan.candidates.length === 1) await download(plan.candidates[0]!.candidateId);
			else setOpen(true);
		} catch (failure) {
			if (generation.current === requestedGeneration) {
				setError(failure instanceof Error ? failure.message : "Plan 来源暂不可读，请重试。");
				setOpen(true);
			}
		} finally {
			if (generation.current === requestedGeneration) setBusy(false);
		}
	};
	return (
		<>
			<Button
				size="sm"
				variant="ghost"
				aria-label="下载主会话 Plan"
				disabled={!workspaceId || busy}
				icon={<Download size={13} />}
				onClick={() => void load()}
			>
				{busy ? "读取 Plan…" : "下载主会话 Plan"}
			</Button>
			<Dialog open={open} onOpenChange={setOpen} contentAriaDescribedBy="task-main-session-plan-download-notice">
				<DialogHeader title="下载主会话 Plan" />
				<DialogBody>
					<p id="task-main-session-plan-download-notice" className="mb-3 text-xs text-text-secondary">
						{error ?? result?.notice ?? "同一计划包含多个来源，请选择要下载的文件。"}
					</p>
					{result?.candidates.map((candidate) => (
						<Button
							key={candidate.candidateId}
							size="sm"
							className="mb-2 w-full justify-start"
							title={candidate.sourceReference}
							disabled={busy}
							icon={<Download size={13} />}
							onClick={() => void download(candidate.candidateId)}
						>
							{candidate.fileName}
						</Button>
					))}
					<Button size="sm" disabled={busy} onClick={() => void load()}>
						重新读取 Plan
					</Button>
				</DialogBody>
			</Dialog>
		</>
	);
}
