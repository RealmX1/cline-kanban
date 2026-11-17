import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { runCodexConfigurationSyncRequestWithinBudget } from "@/hooks/codex-configuration-source-observation-recovery";
import type { useCodexConfigurationSync } from "@/hooks/use-codex-configuration-sync";
import { fetchCodexConfigurationSessionAdoptionProgress } from "@/runtime/codex-configuration-sync-query";
import type { CodexConfigurationSessionAdoptionProgressPage } from "@/runtime/types";

const statusLabels = {
	adopted: "已确认采用",
	local_selection: "保留局部选择",
	saved: "已保存，待核验采用",
	pending: "自动采用中",
	conflict: "目标有冲突",
	unverified: "待核验",
};
export function CodexConfigurationSessionAdoptionProgress({
	controller,
	profileId,
}: {
	controller: ReturnType<typeof useCodexConfigurationSync>;
	profileId: string;
}) {
	const [page, setPage] = useState<CodexConfigurationSessionAdoptionProgressPage | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [refreshGeneration, setRefreshGeneration] = useState(0);
	const requestGeneration = useRef(0);
	const abortController = useRef<AbortController | null>(null);
	const load = async (cursor?: string) => {
		abortController.current?.abort();
		const abort = new AbortController();
		abortController.current = abort;
		const generation = ++requestGeneration.current;
		setLoading(true);
		setError(null);
		try {
			const next = await runCodexConfigurationSyncRequestWithinBudget(
				(signal) =>
					fetchCodexConfigurationSessionAdoptionProgress(
						controller.workspaceId,
						{ profileId, limit: 50, cursor },
						signal,
					),
				abort.signal,
			);
			if (abort.signal.aborted || generation !== requestGeneration.current) return;
			setPage((current) =>
				cursor && current?.storageIdentity === next.storageIdentity
					? { ...next, entries: [...current.entries, ...next.entries] }
					: next,
			);
		} catch {
			if (!abort.signal.aborted && generation === requestGeneration.current)
				setError("采用进度暂不可读，连接或原所有者恢复后可重新核验。");
		} finally {
			if (!abort.signal.aborted && generation === requestGeneration.current) setLoading(false);
		}
	};
	useEffect(() => {
		setPage(null);
		void load();
		return () => abortController.current?.abort();
	}, [controller.workspaceId, profileId, controller.state?.revision, refreshGeneration]);
	const counts = controller.state?.adoptionCounts?.find((entry) => entry.profileId === profileId);
	const selectedProfile = controller.state?.profiles?.find((entry) => entry.profileId === profileId);
	return (
		<section
			aria-label="会话自动采用"
			className="space-y-3 py-3"
			data-verification-anchor="codex-configuration-session-adoption-progress"
		>
			<h3 className="m-0 text-lg font-semibold text-text-primary">自动采用</h3>
			<p className="m-0 max-w-prose text-sm text-text-secondary">
				原进程支持的配置会热更新；显示模式可在回合结束并保全草稿后自动重启。模型、权限或未知 cache
				风险等待下次正常启动。文件已保存与已确认采用分别展示，旧代目标不计入当前会话。
			</p>
			{counts && (
				<p className="m-0 text-sm text-text-primary">
					{counts.total} 个会话 · 已确认 {counts.adopted} · 局部选择 {counts.local_selection} · 自动采用中{" "}
					{counts.pending} · 已保存待核验 {counts.saved} · 冲突 {counts.conflict} · 待核验 {counts.unverified}
				</p>
			)}
			<Button
				size="sm"
				variant="ghost"
				disabled={loading}
				onClick={() => setRefreshGeneration((value) => value + 1)}
			>
				重新核验采用进度
			</Button>
			{page?.entries.map((entry) => (
				<div
					key={JSON.stringify([entry.workspaceId, entry.conversationSessionId, entry.runtimeSessionIncarnationId])}
					className="space-y-2 border-t border-border py-3"
				>
					<p className="m-0 break-words text-sm font-medium text-text-primary">
						{entry.workspaceId} · {entry.conversationSessionId}
					</p>
					<p
						className={`m-0 text-sm ${entry.status === "conflict" ? "text-status-red" : ["pending", "saved"].includes(entry.status) ? "text-status-orange" : "text-text-secondary"}`}
					>
						{statusLabels[entry.status]}
						{entry.localExceptionGroups.length ? ` · 局部选择：${entry.localExceptionGroups.join("、")}` : ""}
					</p>
					{entry.recoveryCondition && <p className="m-0 text-xs text-text-secondary">{entry.recoveryCondition}</p>}
					<details className="text-xs text-text-secondary">
						<summary className="cursor-pointer">会话归属详情</summary>
						<p className="break-all">当前代际：{entry.runtimeSessionIncarnationId || "待核验"}</p>
						<label className="flex flex-wrap items-center gap-2">
							所属配置
							<select
								aria-label={`会话 ${entry.conversationSessionId} 所属配置`}
								className="min-h-9 max-w-full rounded border border-border bg-surface-2 px-2 text-sm text-text-primary"
								value={entry.profileId}
								disabled={
									!entry.writerId || !entry.runtimeSessionIncarnationId || controller.pendingChangeId !== null
								}
								onChange={(event) =>
									void controller.profileAction({
										action: "bind_session",
										profileId: event.target.value,
										workspaceId: entry.workspaceId,
										conversationSessionId: entry.conversationSessionId,
										expectedRuntimeSessionIncarnationId: entry.runtimeSessionIncarnationId,
										idempotencyKey: crypto.randomUUID(),
									})
								}
							>
								{controller.state?.profiles
									?.filter((profile) => profile.sourceIdentity === selectedProfile?.sourceIdentity)
									.map((profile) => (
										<option key={profile.profileId} value={profile.profileId}>
											{profile.name}
										</option>
									))}
							</select>
						</label>
					</details>
				</div>
			))}
			{loading && (
				<p role="status" className="text-sm text-text-secondary">
					正在读取采用进度…
				</p>
			)}
			{error && (
				<p role="status" className="text-sm text-status-orange">
					{error}
				</p>
			)}
			{page && !loading && !page.entries.length && (
				<p className="text-sm text-text-secondary">此配置尚无可核验的会话绑定。</p>
			)}
			{page?.nextCursor && (
				<Button
					size="sm"
					variant="ghost"
					disabled={loading}
					onClick={() => void load(page.nextCursor ?? undefined)}
				>
					加载更多会话
				</Button>
			)}
		</section>
	);
}
