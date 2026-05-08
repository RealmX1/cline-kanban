import { describe, expect, it } from "vitest";

import { LAYOUT_CUSTOMIZATION_LOCAL_STORAGE_KEYS, LocalStorageKey } from "@/storage/local-storage-store";

describe("layout customization storage keys", () => {
	it("includes the fixed detail terminal width preference", () => {
		expect(LAYOUT_CUSTOMIZATION_LOCAL_STORAGE_KEYS).toContain(LocalStorageKey.DetailTerminalPanelWidth);
	});
});
