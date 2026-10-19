import { MOBILE_VIEWPORT_MEDIA_QUERY, matchesMobileViewportNow } from "@/utils/mobile-viewport-breakpoint";
import { useMedia } from "@/utils/react-use";

export function useIsMobile(): boolean {
	return useMedia(MOBILE_VIEWPORT_MEDIA_QUERY, matchesMobileViewportNow());
}
