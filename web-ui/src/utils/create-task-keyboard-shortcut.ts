import { isMacPlatform, modifierKeyLabel, optionKeyLabel } from "@/utils/platform";

export const CREATE_TASK_KEYBOARD_SHORTCUT_HOTKEY = isMacPlatform ? "meta+n" : "ctrl+alt+n";

export const CREATE_TASK_KEYBOARD_SHORTCUT_KEYS = isMacPlatform ? ["⌘", "N"] : [modifierKeyLabel, optionKeyLabel, "N"];

export const CREATE_TASK_KEYBOARD_SHORTCUT_INLINE_LABEL = CREATE_TASK_KEYBOARD_SHORTCUT_KEYS.join("+");
