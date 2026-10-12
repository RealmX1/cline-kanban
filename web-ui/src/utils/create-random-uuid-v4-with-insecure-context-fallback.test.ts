import { afterEach, describe, expect, it, vi } from "vitest";

import { createRandomUuidV4WithInsecureContextFallback } from "@/utils/create-random-uuid-v4-with-insecure-context-fallback";

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("createRandomUuidV4WithInsecureContextFallback", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("uses crypto.randomUUID when the page is a secure context", () => {
		vi.spyOn(crypto, "randomUUID").mockReturnValue("11111111-1111-4111-8111-111111111111");
		expect(createRandomUuidV4WithInsecureContextFallback()).toBe("11111111-1111-4111-8111-111111111111");
		vi.restoreAllMocks();
	});

	it("builds a v4 UUID from getRandomValues when randomUUID is unavailable (plain http)", () => {
		const getRandomValues = vi.fn(<T extends ArrayBufferView | null>(array: T): T => {
			if (array instanceof Uint8Array) {
				array.fill(0xff);
			}
			return array;
		});
		vi.stubGlobal("crypto", { randomUUID: undefined, getRandomValues });

		const uuid = createRandomUuidV4WithInsecureContextFallback();

		expect(getRandomValues).toHaveBeenCalledTimes(1);
		expect(uuid).toMatch(UUID_V4_PATTERN);
		expect(uuid).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
	});
});
