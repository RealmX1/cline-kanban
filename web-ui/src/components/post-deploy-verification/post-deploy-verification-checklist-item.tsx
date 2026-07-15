import * as RadixCheckbox from "@radix-ui/react-checkbox";
import { Check, ChevronDown, ChevronRight, Crosshair, Play, RotateCw, Trash2, X } from "lucide-react";
import { type ReactElement, useState } from "react";

import { VerificationGuidanceOverlay } from "@/components/post-deploy-verification/verification-guidance-overlay";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import type {
	RuntimePostDeployVerificationChecklistItem,
	RuntimePostDeployVerificationCleanup,
	RuntimePostDeployVerificationRunStatus,
} from "@/runtime/types";

export interface PostDeployVerificationChecklistItemProps {
	item: RuntimePostDeployVerificationChecklistItem;
	// active 组未核对未移除时可交互；history / 已核对 / 已移除 一律只读。
	interactive: boolean;
	// 完成流进行中：禁用一切勾选 / 运行。
	isCompleting: boolean;
	// 所属任务是否已核对完成（决定 automatic 清理文案是「将自动清理」还是「已自动清理」）。
	taskVerified: boolean;
	onToggle: (checked: boolean) => void;
	onRun: () => void;
	onRemoveCustom: () => void;
	// 引导人工型「定位并核对」：导航到 anchor.view + spotlight 高亮目标元素（由 task-card 绑定 taskId 后提供）。
	onLocate: () => void;
}

// per-verification 清理提示（plan Stage 5）：automatic 项显示自动清理状态；manual 项展开人工清理步骤；retain 项标注保留。
function CleanupHint({
	cleanup,
	taskVerified,
}: {
	cleanup: RuntimePostDeployVerificationCleanup;
	taskVerified: boolean;
}): ReactElement | null {
	const [stepsOpen, setStepsOpen] = useState(false);

	if (cleanup.mode === "retain") {
		return <p className="m-0 pl-5 text-[10px] text-text-tertiary">验证资产：保留（retain）</p>;
	}
	if (cleanup.mode === "automatic") {
		return (
			<p className="m-0 pl-5 text-[10px] text-text-tertiary">
				{taskVerified ? "已自动清理验证资产" : "核对完成后自动清理验证资产"}
			</p>
		);
	}
	// manual
	if (cleanup.manualSteps.length === 0) {
		return <p className="m-0 pl-5 text-[10px] text-status-orange">需手动清理（未提供步骤说明）</p>;
	}
	return (
		<div className="pl-5">
			<button
				type="button"
				onClick={() => setStepsOpen((current) => !current)}
				className="inline-flex cursor-pointer items-center gap-1 text-[10px] text-status-orange hover:text-status-orange/80"
			>
				{stepsOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
				<Trash2 size={10} />
				清理指引（手动）
			</button>
			{stepsOpen ? (
				<ol className="m-0 mt-1 list-decimal space-y-0.5 pl-4 text-[10px] text-text-secondary">
					{cleanup.manualSteps.map((step, index) => (
						<li key={`${index}-${step}`}>{step}</li>
					))}
				</ol>
			) : null}
		</div>
	);
}

// 自动脚本 run 状态 → 展示标签 + 配色（passed/failed/... 与运行中 spinner）。
function runStatusBadge(status: RuntimePostDeployVerificationRunStatus): { label: string; className: string } {
	switch (status) {
		case "running":
			return { label: "运行中", className: "border-status-blue/30 bg-status-blue/10 text-status-blue" };
		case "passed":
			return { label: "通过", className: "border-status-green/30 bg-status-green/10 text-status-green" };
		case "failed":
			return { label: "失败", className: "border-status-red/30 bg-status-red/10 text-status-red" };
		case "errored":
			return { label: "错误", className: "border-status-red/30 bg-status-red/10 text-status-red" };
		case "timed_out":
			return { label: "超时", className: "border-status-orange/30 bg-status-orange/10 text-status-orange" };
		default:
			return { label: "未运行", className: "border-border bg-surface-3 text-text-tertiary" };
	}
}

// 自动脚本型：checkbox 只读反映 run 结果、不接受手动切换；渲染运行按钮 + 状态徽标 + 可展开输出摘录。
function AutomatedScriptItem({
	item,
	interactive,
	isCompleting,
	onRun,
}: {
	item: RuntimePostDeployVerificationChecklistItem;
	interactive: boolean;
	isCompleting: boolean;
	onRun: () => void;
}): ReactElement {
	const [outputExpanded, setOutputExpanded] = useState(false);
	const status = item.run?.status ?? "not_run";
	const badge = runStatusBadge(status);
	const isRunning = status === "running";
	const hasRun = item.run !== null && status !== "not_run";
	const outputExcerpt = item.run?.outputExcerpt ?? "";

	return (
		<div className="rounded-sm border border-border bg-surface-2 p-1.5">
			<div className="flex items-center gap-2">
				{/* 只读结果格：反映 run pass/fail，不可手动切换 */}
				<span
					aria-hidden
					className={cn(
						"flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border",
						item.checked ? "border-accent bg-accent" : "border-border-bright bg-surface-3",
					)}
				>
					{item.checked ? <Check size={11} className="text-white" /> : null}
				</span>
				<span
					className={cn(
						"flex-1 text-[12px]",
						item.checked ? "text-text-tertiary line-through" : "text-text-secondary",
					)}
				>
					{item.label}
				</span>
				<span className={cn("shrink-0 rounded-sm border px-1.5 py-0.5 text-[10px]", badge.className)}>
					{isRunning ? (
						<span className="inline-flex items-center gap-1">
							<Spinner size={9} />
							{badge.label}
						</span>
					) : (
						badge.label
					)}
				</span>
				{interactive ? (
					<Tooltip content={hasRun ? "重新运行脚本" : "运行验证脚本"}>
						<Button
							size="xs"
							variant="ghost"
							icon={hasRun ? <RotateCw size={12} /> : <Play size={12} />}
							disabled={isRunning || isCompleting}
							onClick={onRun}
							aria-label={hasRun ? "重新运行验证脚本" : "运行验证脚本"}
						/>
					</Tooltip>
				) : null}
			</div>

			{/* 输出摘录：运行过就可展开 */}
			{hasRun && outputExcerpt.length > 0 ? (
				<div className="mt-1">
					<button
						type="button"
						onClick={() => setOutputExpanded((current) => !current)}
						className="inline-flex cursor-pointer items-center gap-1 text-[10px] text-text-tertiary hover:text-text-secondary"
					>
						{outputExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
						脚本输出
					</button>
					{outputExpanded ? (
						<pre className="m-0 mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-sm border border-border bg-surface-0 p-1.5 text-[10px] text-text-secondary">
							{outputExcerpt}
						</pre>
					) : null}
				</div>
			) : null}
		</div>
	);
}

// 引导人工型 / commit / custom：普通 checkbox + label（+ 可删自定义项）。
// 带 guidance 的引导项额外渲染「定位并核对」触发器：点击 → 导航+spotlight（onLocate）+ 打开分步浮层。
function GuidedManualItem({
	item,
	interactive,
	isCompleting,
	onToggle,
	onRemoveCustom,
	onLocate,
}: {
	item: RuntimePostDeployVerificationChecklistItem;
	interactive: boolean;
	isCompleting: boolean;
	onToggle: (checked: boolean) => void;
	onRemoveCustom: () => void;
	onLocate: () => void;
}): ReactElement {
	const [overlayOpen, setOverlayOpen] = useState(false);
	const guidance = item.guidance;
	const canLocate = interactive && guidance !== null;

	return (
		<div className="group/item flex items-center gap-2">
			<RadixCheckbox.Root
				checked={item.checked}
				disabled={!interactive || isCompleting}
				onCheckedChange={(next) => onToggle(next === true)}
				className="flex h-3.5 w-3.5 shrink-0 cursor-pointer items-center justify-center rounded-sm border border-border-bright bg-surface-3 data-[state=checked]:border-accent data-[state=checked]:bg-accent disabled:cursor-default disabled:opacity-50"
			>
				<RadixCheckbox.Indicator>
					<Check size={11} className="text-white" />
				</RadixCheckbox.Indicator>
			</RadixCheckbox.Root>
			<span
				className={cn(
					"flex-1 text-[12px]",
					item.checked ? "text-text-tertiary line-through" : "text-text-secondary",
				)}
			>
				{item.label}
			</span>
			{canLocate ? (
				<Tooltip content="定位并核对：跳转并高亮目标，按分步指引核对">
					<Button
						size="xs"
						variant="ghost"
						icon={<Crosshair size={12} />}
						disabled={isCompleting}
						onClick={() => {
							onLocate();
							setOverlayOpen(true);
						}}
						aria-label="定位并核对"
					/>
				</Tooltip>
			) : null}
			{interactive && item.source === "custom" ? (
				<Tooltip content="移除自定义核对项">
					<button
						type="button"
						aria-label="移除自定义核对项"
						onClick={onRemoveCustom}
						className="shrink-0 cursor-pointer text-text-tertiary opacity-0 transition-opacity hover:text-status-red group-hover/item:opacity-100"
					>
						<X size={12} />
					</button>
				</Tooltip>
			) : null}
			{overlayOpen && guidance ? (
				<VerificationGuidanceOverlay
					label={item.label}
					guidance={guidance}
					onConfirmObserved={() => {
						onToggle(true);
						setOverlayOpen(false);
					}}
					onReportFailed={() => setOverlayOpen(false)}
					onClose={() => setOverlayOpen(false)}
				/>
			) : null}
		</div>
	);
}

// 单个核对项分发：automated_script 走运行 UI，其余走 checkbox；带 cleanup 的项在下方附清理提示。
export function PostDeployVerificationChecklistItem({
	item,
	interactive,
	isCompleting,
	taskVerified,
	onToggle,
	onRun,
	onRemoveCustom,
	onLocate,
}: PostDeployVerificationChecklistItemProps): ReactElement {
	const kindItem =
		item.kind === "automated_script" ? (
			<AutomatedScriptItem item={item} interactive={interactive} isCompleting={isCompleting} onRun={onRun} />
		) : (
			<GuidedManualItem
				item={item}
				interactive={interactive}
				isCompleting={isCompleting}
				onToggle={onToggle}
				onRemoveCustom={onRemoveCustom}
				onLocate={onLocate}
			/>
		);
	return (
		<div className="space-y-0.5">
			{kindItem}
			{item.cleanup ? <CleanupHint cleanup={item.cleanup} taskVerified={taskVerified} /> : null}
		</div>
	);
}
