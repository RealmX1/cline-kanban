/**
 * 移动端可点击控件的最小触控目标（44×44，iOS HIG / WCAG 2.5.8 的通行下限）。
 *
 * 顶栏在窄屏下会把若干控件挤到一行，各控件必须共用同一个下限，否则相邻按钮的命中区大小不一，
 * 手指落点稍偏就点到隔壁。历史上这个类名是 top-bar.tsx 的私有常量，项目切换器加入顶栏后提到这里共享。
 */
export const MOBILE_MINIMUM_TOUCH_TARGET_CLASS_NAME = "min-w-[44px] min-h-[44px]";
