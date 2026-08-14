// 界面偏好从 localStorage 合并进服务端时，两边都有值且不一致的那些字段——提示用户去复核一次。
//
// 为什么必须提示而不是静默按规则处理：合并规则是「服务端赢」，也就是说这个浏览器里攒下的那个选择被
// 悄悄换掉了。规则本身是对的（服务端那份是更晚的意图），但「替用户改了一个他没改过的设置、还不告诉他」
// 不行。提示只出现一次，且不带动作——真要改，用户自己去那个设置项改比我们猜要准。

import { useEffect, useRef } from "react";

import { showAppToast } from "@/components/app-toaster";
import { useUserInterfacePreferenceFieldsWhereServerAndBrowserDisagree } from "@/runtime/use-user-interface-preferences-shared-across-browser-origins";

// 契约字段名对用户没有意义，这里翻译成设置项在界面上的说法。
const HUMAN_READABLE_LABEL_BY_PREFERENCE_FIELD_NAME: Record<string, string> = {
	newTaskAutoReviewEnabled: "新任务的「自动评审」默认开关",
	newTaskAutoReviewMode: "自动评审的收尾方式（提交 / PR）",
	taskCreateDialogPrimaryStartAction: "新建任务对话框的主按钮动作",
	workspaceOpenTargetPreferredApplicationId: "「在…中打开」的默认应用",
	taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey: "各终端 agent 上次选定的模型",
	projectNumericSlotGroupAssignmentsBySlotNumber: "项目数字槽位编组",
};

function describePreferenceField(fieldName: string): string {
	return HUMAN_READABLE_LABEL_BY_PREFERENCE_FIELD_NAME[fieldName] ?? fieldName;
}

/**
 * 不渲染任何东西，只在检测到冲突时弹一次 toast。
 *
 * 用 ref 而不是 state 记「弹过了」：它不影响渲染输出，写进 state 只会白白多一次重渲染。
 */
export function UserInterfacePreferenceMigrationConflictNotice(): null {
	const conflictingFieldNames = useUserInterfacePreferenceFieldsWhereServerAndBrowserDisagree();
	const hasShownNoticeRef = useRef(false);

	useEffect(() => {
		if (hasShownNoticeRef.current || conflictingFieldNames.length === 0) {
			return;
		}
		hasShownNoticeRef.current = true;
		showAppToast(
			{
				intent: "warning",
				icon: "warning-sign",
				message: `这些设置在本浏览器和服务端各存了一份且不一致，已按服务端那份生效，请确认是否需要改回：\n${conflictingFieldNames
					.map((fieldName) => `· ${describePreferenceField(fieldName)}`)
					.join("\n")}`,
				timeout: 15000,
			},
			"user-interface-preference-migration-conflict",
		);
	}, [conflictingFieldNames]);

	return null;
}
