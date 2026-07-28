import { useHotkeys } from "react-hotkeys-hook";

import { showAppToast } from "@/components/app-toaster";
import {
	buildProjectNumericSlotGroupBindHotkeyBinding,
	buildProjectNumericSlotGroupJumpHotkeyBinding,
	formatProjectNumericSlotGroupBindHotkeyLabel,
	formatProjectNumericSlotGroupJumpHotkeyLabel,
	isProjectNumericSlotGroupJumpHotkeyPreemptedByOperatingSystem,
} from "@/components/top-bar-project-switcher/project-numeric-slot-group-hotkey-descriptors";
import {
	PROJECT_NUMERIC_SLOT_GROUP_NUMBERS,
	type ProjectNumericSlotGroupAssignments,
	type ProjectNumericSlotGroupNumber,
} from "@/hooks/use-project-numeric-slot-group-assignments";
import type { RuntimeProjectSummary } from "@/runtime/types";
import { isMacPlatform } from "@/utils/platform";

/**
 * 每个 useHotkeys 都注册整组键串（库支持 `readonly string[]`），再用回调里的 `hotkeysEvent.hotkey`
 * ——它就是注册时传进去的原始串——反查槽位号。这样只要两次 useHotkeys 调用，而不是在循环里调 18 次
 * （那会违反 rules-of-hooks）。
 */
const PROJECT_NUMERIC_SLOT_GROUP_JUMP_HOTKEY_BINDINGS: readonly string[] = PROJECT_NUMERIC_SLOT_GROUP_NUMBERS.map(
	buildProjectNumericSlotGroupJumpHotkeyBinding,
);
const PROJECT_NUMERIC_SLOT_GROUP_BIND_HOTKEY_BINDINGS: readonly string[] = PROJECT_NUMERIC_SLOT_GROUP_NUMBERS.map(
	buildProjectNumericSlotGroupBindHotkeyBinding,
);

const SLOT_NUMBER_BY_JUMP_HOTKEY_BINDING = new Map<string, ProjectNumericSlotGroupNumber>(
	PROJECT_NUMERIC_SLOT_GROUP_NUMBERS.map((slotNumber) => [
		buildProjectNumericSlotGroupJumpHotkeyBinding(slotNumber),
		slotNumber,
	]),
);
const SLOT_NUMBER_BY_BIND_HOTKEY_BINDING = new Map<string, ProjectNumericSlotGroupNumber>(
	PROJECT_NUMERIC_SLOT_GROUP_NUMBERS.map((slotNumber) => [
		buildProjectNumericSlotGroupBindHotkeyBinding(slotNumber),
		slotNumber,
	]),
);

/**
 * 判定一个 keydown 是否是 AltGr 正在敲出字符——这类事件必须完全绕开绑定热键。
 *
 * Windows/Linux 的 AltGr 在事件层就等价于 Ctrl+Alt，而绑定热键 `mod+alt+数字` 在非 mac 平台上
 * `mod` 解析成 ctrlKey，于是 AltGr+数字 会实打实命中绑定热键（react-hotkeys-hook 的 `mod` 只要
 * metaKey 或 ctrlKey 之一为真即通过）。多个国际布局用 AltGr+数字 输入字符（德语 AltGr+7/8/9/0 是
 * `{` `[` `]` `}`），加上这两个热键开着 enableOnFormTags / enableOnContentEditable，用户在任务
 * prompt 输入框里打这些字符时，字符会被 preventDefault 吞掉、当前项目还被误绑到那个槽位。
 * `getModifierState("AltGraph")` 是把 AltGr 与真·Ctrl+Alt 区分开的唯一手段（没有对应的
 * `event.altGraphKey` 简写属性）。
 *
 * 必须限定在非 mac：macOS 把 ⌥ Option 自身就报成 AltGraph（Alt 与 AltGraph 同时为真），
 * 不带平台判断会把 mac 上正常的 ⌘⌥+数字 绑定热键一并吞掉。AltGr 这个键本来也只存在于
 * Windows/Linux 布局，所以按平台切掉整个判断既安全又贴合语义。
 */
function isAltGraphCharacterInputKeyboardEvent(keyboardEvent: KeyboardEvent): boolean {
	return !isMacPlatform && keyboardEvent.getModifierState("AltGraph");
}

interface UseProjectNumericSlotGroupHotkeysInput {
	projects: readonly RuntimeProjectSummary[];
	currentProjectId: string | null;
	numericSlotGroupAssignments: ProjectNumericSlotGroupAssignments;
	onSelectProject: (projectId: string) => void;
	onAssignProjectToNumericSlotGroupNumber: (slotNumber: ProjectNumericSlotGroupNumber, projectId: string) => void;
}

/**
 * 《红警》式项目编组热键：`mod+shift+1..9` 跳转，`mod+alt+1..9` 把当前项目绑到该槽位。
 *
 * 与 use-app-hotkeys 并列而非塞进它：后者已有 8 个 useHotkeys 调用，再加一组编组键会把那个文件的
 * 主题冲淡成「什么键都在这」。
 *
 * 键匹配走 `event.code`（react-hotkeys-hook 默认 `useKey: false`，内部把 `Digit1` 归一成 `1`），
 * 所以 macOS 上 ⌥ 对字符的替换（⌥1 = ¡）不影响识别，无需额外兜底。
 */
export function useProjectNumericSlotGroupHotkeys({
	projects,
	currentProjectId,
	numericSlotGroupAssignments,
	onSelectProject,
	onAssignProjectToNumericSlotGroupNumber,
}: UseProjectNumericSlotGroupHotkeysInput): void {
	useHotkeys(
		PROJECT_NUMERIC_SLOT_GROUP_JUMP_HOTKEY_BINDINGS,
		(_keyboardEvent, hotkeysEvent) => {
			const slotNumber = SLOT_NUMBER_BY_JUMP_HOTKEY_BINDING.get(hotkeysEvent.hotkey);
			if (slotNumber === undefined) {
				return;
			}
			const projectId = numericSlotGroupAssignments[String(slotNumber)];
			// 空槽位静默 no-op：按到没绑过的数字不该弹提示打断手感。
			if (!projectId || projectId === currentProjectId) {
				return;
			}
			onSelectProject(projectId);
		},
		{
			enableOnFormTags: true,
			enableOnContentEditable: true,
			preventDefault: true,
		},
		[currentProjectId, numericSlotGroupAssignments, onSelectProject],
	);

	useHotkeys(
		PROJECT_NUMERIC_SLOT_GROUP_BIND_HOTKEY_BINDINGS,
		(_keyboardEvent, hotkeysEvent) => {
			const slotNumber = SLOT_NUMBER_BY_BIND_HOTKEY_BINDING.get(hotkeysEvent.hotkey);
			if (slotNumber === undefined || !currentProjectId) {
				return;
			}
			const project = projects.find((candidate) => candidate.id === currentProjectId);
			if (!project) {
				return;
			}
			onAssignProjectToNumericSlotGroupNumber(slotNumber, currentProjectId);

			const jumpHotkeyLabel = formatProjectNumericSlotGroupJumpHotkeyLabel(slotNumber);
			const bindHotkeyLabel = formatProjectNumericSlotGroupBindHotkeyLabel(slotNumber);
			const isJumpHotkeyPreempted = isProjectNumericSlotGroupJumpHotkeyPreemptedByOperatingSystem(slotNumber);
			showAppToast(
				{
					intent: "success",
					message: isJumpHotkeyPreempted
						? `${project.name} is now slot ${slotNumber}. ${jumpHotkeyLabel} is reserved by macOS for screenshots, so use the project switcher to jump there.`
						: `${project.name} is now slot ${slotNumber}. Jump back with ${jumpHotkeyLabel}.`,
				},
				// 同一槽位连按只更新同一条 toast，不堆一叠。
				`project-numeric-slot-group-binding:${bindHotkeyLabel}`,
			);
		},
		{
			enableOnFormTags: true,
			enableOnContentEditable: true,
			preventDefault: true,
			// ignoreEventWhen 在 react-hotkeys-hook 内部先于 preventDefault 与回调执行，所以 AltGr
			// 敲出的字符既不会被吞掉、也不会误绑槽位。放在回调里判断已经太晚（preventDefault 先跑了）。
			ignoreEventWhen: isAltGraphCharacterInputKeyboardEvent,
		},
		[currentProjectId, onAssignProjectToNumericSlotGroupNumber, projects],
	);
}
