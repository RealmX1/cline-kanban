import * as Popover from "@radix-ui/react-popover";
import { ClipboardCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { showAppToast } from "@/components/app-toaster";
import { usePostDeployVerificationEntryNavigationHost } from "@/components/post-deploy-verification/post-deploy-verification-entry-navigation-host-context";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { fetchTaskPostDeployVerificationEntryNavigationTargets } from "@/runtime/post-deploy-verification-entry-navigation-query";
import type { RuntimePostDeployVerificationEntryNavigationTarget } from "@/runtime/types";

export function PostDeployVerificationEntryNavigationButton({
	taskId,
	workspaceId,
}: {
	taskId: string;
	workspaceId?: string | null;
}) {
	const host = usePostDeployVerificationEntryNavigationHost();
	const targetWorkspaceId = workspaceId ?? host?.workspaceIdOwningHydratedBoard;
	const [loading, setLoading] = useState(false);
	const [targets, setTargets] = useState<RuntimePostDeployVerificationEntryNavigationTarget[]>([]);
	const [selectionNavigationIntent, setSelectionNavigationIntent] = useState<AbortSignal | null>(null);
	const removeIntentCancellationListener = useRef<(() => void) | null>(null);
	const [open, setOpen] = useState(false);
	const readGeneration = useRef(0);
	useEffect(() => {
		readGeneration.current += 1;
		setLoading(false);
		setOpen(false);
		setTargets([]);
		setSelectionNavigationIntent(null);
		return () => {
			readGeneration.current += 1;
			removeIntentCancellationListener.current?.();
		};
	}, [taskId, targetWorkspaceId]);
	if (!host || !targetWorkspaceId) return null;
	const navigate = (
		target: RuntimePostDeployVerificationEntryNavigationTarget,
		navigationIntent: AbortSignal | null,
	) => {
		if (!navigationIntent || navigationIntent.aborted) return;
		setOpen(false);
		host.navigateToEntry(target, navigationIntent);
	};
	const readAndNavigate = async () => {
		const navigationIntent = host.beginNavigationIntent();
		removeIntentCancellationListener.current?.();
		const cancelPendingReadAndSelection = () => {
			readGeneration.current += 1;
			setLoading(false);
			setOpen(false);
			setTargets([]);
			setSelectionNavigationIntent(null);
		};
		navigationIntent.addEventListener("abort", cancelPendingReadAndSelection, { once: true });
		removeIntentCancellationListener.current = () =>
			navigationIntent.removeEventListener("abort", cancelPendingReadAndSelection);
		const generation = ++readGeneration.current;
		setLoading(true);
		try {
			const result = await fetchTaskPostDeployVerificationEntryNavigationTargets({
				workspaceId: targetWorkspaceId,
				taskId,
			});
			if (generation !== readGeneration.current || navigationIntent.aborted) return;
			if (result.originEntriesReadError) showAppToast({ intent: "warning", message: result.originEntriesReadError });
			if (result.targets.length === 0) {
				if (!result.originEntriesReadError)
					showAppToast({ intent: "primary", message: "该 Task 暂无保留的部署后验证记录。" });
				return;
			}
			const onlyTarget = result.targets.length === 1 ? result.targets[0] : null;
			if (onlyTarget?.availability === "retained") navigate(onlyTarget, navigationIntent);
			else {
				setTargets(result.targets);
				setSelectionNavigationIntent(navigationIntent);
				setOpen(true);
			}
		} catch (error) {
			if (generation === readGeneration.current && !navigationIntent.aborted)
				showAppToast({
					intent: "danger",
					message: `读取部署后验证定位失败：${error instanceof Error ? error.message : String(error)}`,
				});
		} finally {
			if (generation === readGeneration.current) setLoading(false);
		}
	};
	return (
		<span
			className="inline-flex"
			onPointerDown={(event) => event.stopPropagation()}
			onClick={(event) => event.stopPropagation()}
			onKeyDown={(event) => event.stopPropagation()}
		>
			<Popover.Root open={open} onOpenChange={setOpen}>
				<Popover.Anchor asChild>
					<Button
						variant="ghost"
						size="xs"
						aria-label="定位部署后验证"
						title="定位当前任务或续接来源的部署后验证"
						aria-busy={loading}
						aria-haspopup="dialog"
						aria-expanded={open}
						disabled={loading}
						icon={loading ? <Spinner size={11} /> : <ClipboardCheck size={12} />}
						onPointerDown={(event) => event.stopPropagation()}
						onMouseDown={(event) => event.stopPropagation()}
						onKeyDown={(event) => event.stopPropagation()}
						onClick={(event) => {
							event.stopPropagation();
							void readAndNavigate();
						}}
					>
						PDV
					</Button>
				</Popover.Anchor>
				<Popover.Portal>
					<Popover.Content
						aria-label="选择部署后验证记录"
						side="bottom"
						align="end"
						sideOffset={4}
						className="z-[80] flex max-w-[calc(100vw-2rem)] flex-col gap-1 rounded-md border border-border-bright bg-surface-2 p-2 text-xs text-text-primary"
						onPointerDown={(event) => event.stopPropagation()}
						onClick={(event) => event.stopPropagation()}
					>
						{targets.map((target) => (
							<button
								key={JSON.stringify([target.navigationKind, target.entry])}
								type="button"
								disabled={target.availability !== "retained"}
								onClick={() => navigate(target, selectionNavigationIntent)}
								className="rounded-sm px-2 py-1.5 text-left hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-default disabled:text-text-tertiary"
							>
								<span className="block">
									{target.navigationKind === "task_own_entry" ? "当前任务的验证" : "来源任务的验证"}
								</span>
								<span className="block text-[11px] text-text-secondary">
									{target.entry.workspaceId} · {target.entry.taskId} ·{" "}
									{target.deployedAtIso?.slice(0, 10) ?? "历史部署记录已清理"}
								</span>
							</button>
						))}
					</Popover.Content>
				</Popover.Portal>
			</Popover.Root>
		</span>
	);
}
