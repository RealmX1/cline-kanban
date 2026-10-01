/**
 * 把任意字符串转成可放进**双引号** CSS 属性选择器（`[data-task-id="…"]`）的值：只需转义反斜杠与双引号。
 * Focus View 左侧的钉住分类、焦点卡钉住判定、stage 跳转/折叠滚动调整都按 `data-task-id` /
 * `data-stage-section-id` 查询真实 DOM，共用这一份转义，免得各自复制一份再各自漂移。
 */
export function escapeCssAttributeSelectorValue(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
