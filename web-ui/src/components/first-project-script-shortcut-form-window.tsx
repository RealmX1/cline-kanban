import * as RadixPopover from "@radix-ui/react-popover";
import { ChevronDown, Play } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";
import { hostNonModalFloatingForm } from "@/components/host-non-modal-floating-form";
import {
	getRuntimeShortcutIconComponent,
	getRuntimeShortcutPickerOption,
	RUNTIME_SHORTCUT_ICON_OPTIONS,
	type RuntimeShortcutPickerIconId,
} from "@/components/shared/runtime-shortcut-icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { NonModalFormDialog } from "@/components/ui/non-modal-form-dialog";
import { Spinner } from "@/components/ui/spinner";
import {
	FORM_PRIMARY_ACTION_SUBMIT_SHORTCUT_BUTTON_PROPS,
	useFormPrimaryActionSubmitKeyboardShortcut,
} from "@/hooks/use-form-primary-action-submit-keyboard-shortcut";
import type { RuntimeProjectShortcut } from "@/runtime/types";

function FirstShortcutIconPicker({
	value,
	onSelect,
}: {
	value: RuntimeShortcutPickerIconId;
	onSelect: (icon: RuntimeShortcutPickerIconId) => void;
}): ReactElement {
	const [open, setOpen] = useState(false);
	const selectedOption = getRuntimeShortcutPickerOption(value);
	const SelectedIconComponent = getRuntimeShortcutIconComponent(value);

	return (
		<RadixPopover.Root open={open} onOpenChange={setOpen}>
			<RadixPopover.Trigger asChild>
				<button
					type="button"
					aria-label={`Shortcut icon: ${selectedOption.label}`}
					className="inline-flex items-center gap-1 h-8 px-2 rounded-md border border-border bg-surface-2 text-text-primary hover:bg-surface-3"
				>
					<SelectedIconComponent size={14} />
					<ChevronDown size={12} />
				</button>
			</RadixPopover.Trigger>
			<RadixPopover.Portal>
				<RadixPopover.Content
					side="bottom"
					align="start"
					sideOffset={4}
					className="z-50 rounded-md border border-border bg-surface-2 p-1 shadow-lg"
					style={{ animation: "kb-tooltip-show 100ms ease" }}
				>
					<div className="flex gap-0.5">
						{RUNTIME_SHORTCUT_ICON_OPTIONS.map((option) => {
							const IconComponent = getRuntimeShortcutIconComponent(option.value);
							return (
								<button
									key={option.value}
									type="button"
									aria-label={option.label}
									className={cn(
										"p-1.5 rounded hover:bg-surface-3",
										selectedOption.value === option.value && "bg-surface-3",
									)}
									onClick={() => {
										onSelect(option.value);
										setOpen(false);
									}}
								>
									<IconComponent size={14} />
								</button>
							);
						})}
					</div>
				</RadixPopover.Content>
			</RadixPopover.Portal>
		</RadixPopover.Root>
	);
}

function FirstProjectScriptShortcutForm({
	open,
	onClose,
	onCreateFirstShortcut,
}: {
	open: boolean;
	workspaceId?: string | null;
	openingRequestSequence: number;
	onClose: () => void;
	onCreateFirstShortcut?: (shortcut: RuntimeProjectShortcut) => Promise<{ ok: boolean; message?: string }>;
}) {
	const [isCreateShortcutSaving, setIsCreateShortcutSaving] = useState(false);
	const [createShortcutError, setCreateShortcutError] = useState<string | null>(null);
	const [newShortcutIcon, setNewShortcutIcon] = useState<RuntimeShortcutPickerIconId>("play");
	const [newShortcutLabel, setNewShortcutLabel] = useState("Run");
	const [newShortcutCommand, setNewShortcutCommand] = useState("");
	const canSaveNewShortcut = newShortcutCommand.trim().length > 0;
	const handleSaveFirstShortcut = async () => {
		if (!onCreateFirstShortcut || !canSaveNewShortcut || isCreateShortcutSaving) {
			return;
		}
		setCreateShortcutError(null);
		setIsCreateShortcutSaving(true);
		try {
			const result = await onCreateFirstShortcut({
				label: newShortcutLabel.trim(),
				command: newShortcutCommand.trim(),
				icon: newShortcutIcon,
			});
			if (!result.ok) {
				setCreateShortcutError(result.message ?? "无法保存快捷方式，填写内容已保留。");
				return;
			}
			onClose();
		} catch (failure) {
			setCreateShortcutError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			setIsCreateShortcutSaving(false);
		}
	};

	useEffect(() => {
		if (open) {
			setCreateShortcutError(null);
			setNewShortcutIcon("play");
			setNewShortcutLabel("Run");
			setNewShortcutCommand("");
		}
	}, [open]);
	const handlePrimaryActionKeyDown = useFormPrimaryActionSubmitKeyboardShortcut({
		onSubmit: handleSaveFirstShortcut,
		disabled: !canSaveNewShortcut || isCreateShortcutSaving,
	});
	return (
		<NonModalFormDialog
			onKeyDown={handlePrimaryActionKeyDown}
			open={open}
			contentAriaDescribedBy={undefined}
			onOpenChange={(nextOpen) => {
				if (isCreateShortcutSaving) {
					return;
				}
				if (!nextOpen) onClose();
				if (!nextOpen) {
					setCreateShortcutError(null);
				}
			}}
		>
			<DialogHeader title="Set up your first script shortcut" icon={<Play size={16} />} />
			<DialogBody>
				<p className="text-text-secondary text-[13px] mt-0 mb-2">
					Script shortcuts run a command in the bottom terminal so you can quickly run and test your project.
				</p>
				<p className="text-text-secondary text-[13px] mt-0 mb-3">
					You can always open Settings to add and manage more shortcuts later.
				</p>
				<div className="grid grid-cols-[max-content_1fr_2fr] gap-2">
					<FirstShortcutIconPicker value={newShortcutIcon} onSelect={setNewShortcutIcon} />
					<input
						value={newShortcutLabel}
						onChange={(event) => setNewShortcutLabel(event.target.value)}
						placeholder="Label"
						disabled={isCreateShortcutSaving}
						className="h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-xs text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none disabled:opacity-60"
					/>
					<input
						value={newShortcutCommand}
						onChange={(event) => setNewShortcutCommand(event.target.value)}
						placeholder="npm run dev"
						disabled={isCreateShortcutSaving}
						className="h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-xs text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none disabled:opacity-60"
					/>
				</div>
				{createShortcutError ? (
					<p className="text-status-red text-[13px] mt-3 mb-0">{createShortcutError}</p>
				) : null}
			</DialogBody>
			<DialogFooter>
				<Button
					onClick={() => {
						if (!isCreateShortcutSaving) {
							onClose();
							setCreateShortcutError(null);
						}
					}}
					disabled={isCreateShortcutSaving}
				>
					Cancel
				</Button>
				<Button
					variant="primary"
					{...FORM_PRIMARY_ACTION_SUBMIT_SHORTCUT_BUTTON_PROPS}
					onClick={() => {
						void handleSaveFirstShortcut();
					}}
					disabled={!canSaveNewShortcut || isCreateShortcutSaving}
				>
					{isCreateShortcutSaving ? (
						<>
							<Spinner size={12} />
							Saving...
						</>
					) : (
						"Save"
					)}
				</Button>
			</DialogFooter>
		</NonModalFormDialog>
	);
}

export const FirstProjectScriptShortcutFormWindow = hostNonModalFloatingForm(FirstProjectScriptShortcutForm, {
	formKind: "first-project-script-shortcut",
	isOpen: (props) => props.open,
	instanceIdentity: (props) => props.workspaceId ?? "global-shortcut",
	openingRequestIdentity: (props) => props.openingRequestSequence,
	ownership: (props) => ({ workspaceId: props.workspaceId }),
	withClose: (props, close) => ({ ...props, open: true, onClose: close }),
	onClosed: (props) => props.onClose(),
});
