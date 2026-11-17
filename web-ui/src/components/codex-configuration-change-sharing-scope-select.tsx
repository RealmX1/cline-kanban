import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, Monitor, Network } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import type { CodexConfigurationChange } from "@/runtime/types";

export function CodexConfigurationChangeSharingScopeSelect({
	change,
	pending = false,
	onScopeChange,
}: {
	change: CodexConfigurationChange;
	pending?: boolean;
	onScopeChange: (
		change: CodexConfigurationChange,
		scope: "session_only" | "profile",
	) => Promise<CodexConfigurationChange | false | undefined>;
}) {
	const descriptionId = useId();
	const [confirmedChange, setConfirmedChange] = useState<CodexConfigurationChange | null>(null);
	if (confirmedChange?.changeId === change.changeId && confirmedChange.version >= change.version)
		change = confirmedChange;
	if (
		!change.codexConfigurationProfileId ||
		change.settingsIsolationArchivedAtMs !== undefined ||
		change.recordKind === "source_observation" ||
		change.compensationForChangeId ||
		change.sourceWriterId.startsWith("profile:")
	)
		return null;
	const scope =
		change.changeSharingScope?.currentScope ?? (change.approvalStatus === "approved" ? "profile" : "session_only");
	const shared = scope === "profile";
	const sourceLabel = change.sourceEvidence?.detectedOwner.task?.taskTitle ?? change.sourceConversationSessionId;
	return (
		<div
			className="min-w-0 space-y-1.5"
			data-configuration-change-sharing-scope={scope}
			data-verification-anchor="codex-configuration-change-sharing-scope"
		>
			<DropdownMenu.Root modal={false}>
				<DropdownMenu.Trigger asChild>
					<Button
						size="sm"
						className={cn(
							"min-h-9 max-w-full gap-2 border text-text-primary focus-visible:outline-2 focus-visible:outline-accent",
							shared
								? "border-accent bg-accent/15 hover:bg-accent/25"
								: "border-text-secondary bg-surface-2 hover:bg-surface-3",
						)}
						disabled={pending}
						aria-label={`${change.fieldLabel}本次修改的共享范围，来源 ${sourceLabel}`}
						aria-describedby={descriptionId}
					>
						{shared ? (
							<Network aria-hidden="true" className="size-4 shrink-0" />
						) : (
							<Monitor aria-hidden="true" className="size-4 shrink-0" />
						)}
						<span>{shared ? "共享到配置方案" : "仅本会话"}</span>
						<ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
					</Button>
				</DropdownMenu.Trigger>
				<DropdownMenu.Portal>
					<DropdownMenu.Content
						align="start"
						sideOffset={5}
						collisionPadding={12}
						className="z-50 max-w-[calc(100vw-1.5rem)] rounded-md border border-border-bright bg-surface-1 p-1 text-text-primary"
					>
						<DropdownMenu.Label className="max-w-72 px-2 py-1.5 text-xs break-words text-text-secondary">
							本次修改 · {sourceLabel}
						</DropdownMenu.Label>
						<DropdownMenu.RadioGroup
							value={change.changeSharingScope?.requestedScope ?? scope}
							onValueChange={(value) => {
								if (value === "session_only" || value === "profile")
									void onScopeChange(change, value).then((next) => {
										if (next) setConfirmedChange(next);
									});
							}}
						>
							{(
								[
									["session_only", "仅本会话", Monitor],
									["profile", "共享到配置方案", Network],
								] as const
							).map(([value, label, Icon]) => (
								<DropdownMenu.RadioItem
									key={value}
									value={value}
									className="flex min-h-10 cursor-pointer items-center gap-2 rounded-sm px-2 text-sm outline-none data-[highlighted]:bg-surface-3 data-[disabled]:opacity-50"
								>
									<Icon className="size-4" aria-hidden="true" />
									<span className="flex-1">{label}</span>
									<DropdownMenu.ItemIndicator>
										<Check className="size-4" aria-hidden="true" />
									</DropdownMenu.ItemIndicator>
								</DropdownMenu.RadioItem>
							))}
						</DropdownMenu.RadioGroup>
					</DropdownMenu.Content>
				</DropdownMenu.Portal>
			</DropdownMenu.Root>
			<p id={descriptionId} className="m-0 text-xs leading-relaxed text-text-secondary">
				仅影响这次修改。显示模式可在回合结束后自动重启；有 cache 风险时等待下次启动。
			</p>
			{change.changeSharingScope?.withdrawalStatus === "pending" && (
				<div role="status" className="m-0 text-xs text-text-primary">
					{change.changeSharingScope.requestedScope === "profile"
						? "正在核验共享归属；条件恢复后自动继续。"
						: "正在核验撤回；已采用目标按安全时机恢复。"}
					{change.changeSharingScope.conflicts.map((conflict, index) => (
						<p key={`${conflict.writerId}:${conflict.fieldKey}:${index}`} className="m-0 mt-1 break-words">
							{conflict.reason}
							{conflict.recoveryCondition ? ` 恢复条件：${conflict.recoveryCondition}` : ""}
						</p>
					))}
				</div>
			)}
			{change.changeSharingScope?.withdrawalStatus === "protected_conflicts" && (
				<div role="status" className="text-xs text-status-orange">
					已保留较新决定，部分目标未回退。
					{change.changeSharingScope.conflicts.map((conflict, index) => (
						<p key={`${conflict.writerId}:${conflict.fieldKey}:${index}`} className="m-0 mt-1 break-words">
							{conflict.reason}
							{conflict.recoveryCondition ? ` 恢复条件：${conflict.recoveryCondition}` : ""}
						</p>
					))}
				</div>
			)}
		</div>
	);
}
