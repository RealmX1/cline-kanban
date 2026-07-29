import { MOBILE_VIEWPORT_MEDIA_QUERY } from "@/utils/mobile-viewport-breakpoint";
import { useMedia } from "@/utils/react-use";

export function useIsMobile(): boolean {
	return useMedia(MOBILE_VIEWPORT_MEDIA_QUERY, false);
}
