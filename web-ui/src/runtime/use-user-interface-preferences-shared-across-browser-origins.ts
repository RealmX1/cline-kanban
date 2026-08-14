// 跨浏览器 origin 共享的界面偏好：React 侧的读写入口。
//
// 每个偏好一个具名 hook，签名与它替换掉的那个 localStorage hook 保持 `[value, setValue]` 一致，于是
// 调用点只换 hook 名、不改用法。默认值仍由**调用方**给：服务端的 null 表示「尚未设定」，不是「设成了
// 某个值」，把默认值搬进 store 会让这两件事再也分不开（也就毁掉迁移的播种判据）。

import type { Dispatch, SetStateAction } from "react";
import { useCallback, useRef, useSyncExternalStore } from "react";

import type { RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins } from "@/runtime/types";
import {
	getUserInterfacePreferencesSharedAcrossBrowserOriginsStoreState,
	readEffectiveUserInterfacePreferenceValue,
	saveUserInterfacePreferencesSharedAcrossBrowserOrigins,
	subscribeToUserInterfacePreferencesSharedAcrossBrowserOrigins,
	type UserInterfacePreferenceFieldName,
} from "@/runtime/user-interface-preferences-shared-across-browser-origins-store";

function useUserInterfacePreferenceStoreState() {
	return useSyncExternalStore(
		subscribeToUserInterfacePreferencesSharedAcrossBrowserOrigins,
		getUserInterfacePreferencesSharedAcrossBrowserOriginsStoreState,
		getUserInterfacePreferencesSharedAcrossBrowserOriginsStoreState,
	);
}

function useUserInterfacePreference<TFieldName extends UserInterfacePreferenceFieldName>(
	fieldName: TFieldName,
	fallbackValueWhenNothingIsSet: NonNullable<RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins[TFieldName]>,
): [
	NonNullable<RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins[TFieldName]>,
	Dispatch<SetStateAction<NonNullable<RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins[TFieldName]>>>,
] {
	// 订阅整份 store state：任一字段变化都重渲染。这些偏好只在用户主动改设置时才变（不是每次击键），
	// 为省这点重渲染去做逐字段订阅不值得。
	useUserInterfacePreferenceStoreState();
	const value =
		(readEffectiveUserInterfacePreferenceValue(fieldName) as NonNullable<
			RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins[TFieldName]
		> | null) ?? fallbackValueWhenNothingIsSet;
	// 函数式更新器要拿到**最新**值，不能是首帧闭包里那个。渲染期同步一个 ref 即可：store 一变就重渲染，
	// 所以 ref 始终跟着当前显示值走。
	const latestValueRef = useRef(value);
	latestValueRef.current = value;
	const setValue = useCallback<
		Dispatch<SetStateAction<NonNullable<RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins[TFieldName]>>>
	>(
		(nextValueOrUpdater) => {
			const nextValue =
				typeof nextValueOrUpdater === "function"
					? (
							nextValueOrUpdater as (
								previousValue: NonNullable<
									RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins[TFieldName]
								>,
							) => NonNullable<RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins[TFieldName]>
						)(latestValueRef.current)
					: nextValueOrUpdater;
			saveUserInterfacePreferencesSharedAcrossBrowserOrigins({
				[fieldName]: nextValue,
			} as Partial<RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins>);
		},
		[fieldName],
	);
	return [value, setValue];
}

/** 新建任务时「自动评审」默认是否开启。 */
export function useNewTaskAutoReviewEnabledPreference(): [boolean, Dispatch<SetStateAction<boolean>>] {
	return useUserInterfacePreference("newTaskAutoReviewEnabled", false);
}

/** 新建任务时自动评审的收尾方式（提交 / 开 PR）。 */
export function useNewTaskAutoReviewModePreference(): [
	NonNullable<RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins["newTaskAutoReviewMode"]>,
	Dispatch<
		SetStateAction<NonNullable<RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins["newTaskAutoReviewMode"]>>
	>,
] {
	return useUserInterfacePreference("newTaskAutoReviewMode", "commit");
}

/** 新建任务对话框上那个主按钮记住的动作（仅创建并启动 / 启动并打开）。 */
export function useTaskCreateDialogPrimaryStartActionPreference(): [
	NonNullable<RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins["taskCreateDialogPrimaryStartAction"]>,
	Dispatch<
		SetStateAction<
			NonNullable<RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins["taskCreateDialogPrimaryStartAction"]>
		>
	>,
] {
	return useUserInterfacePreference("taskCreateDialogPrimaryStartAction", "start");
}

/**
 * 「在…中打开」记住的应用。
 *
 * 可选集合随平台变化（macOS 才有 Xcode / iTerm2 之类），所以校验留给调用方：store 只负责存回哪个 id，
 * 调用方拿到后仍要按当前平台的可选集合过一遍，否则换机器后会读到一个本机装不了的目标。
 */
export function useWorkspaceOpenTargetPreferredApplicationIdPreference(
	fallbackApplicationId: string,
): [string, Dispatch<SetStateAction<string>>] {
	return useUserInterfacePreference("workspaceOpenTargetPreferredApplicationId", fallbackApplicationId);
}

/** 顶栏项目快速切换器的《红警》式编组：槽位号 → projectId。 */
export function useProjectNumericSlotGroupAssignmentsPreference(): [
	Record<string, string>,
	Dispatch<SetStateAction<Record<string, string>>>,
] {
	return useUserInterfacePreference("projectNumericSlotGroupAssignmentsBySlotNumber", {});
}

/** 迁移时两边都有值且不一致的字段（服务端胜出）。空数组表示无冲突。 */
export function useUserInterfacePreferenceFieldsWhereServerAndBrowserDisagree(): readonly string[] {
	return useUserInterfacePreferenceStoreState().fieldsWhereServerAndBrowserDisagree;
}
