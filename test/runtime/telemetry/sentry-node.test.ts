import { afterEach, describe, expect, it, vi } from "vitest";

const sentryMocks = vi.hoisted(() => ({
	withScope: vi.fn((callback: (scope: { setTag: (key: string, value: string) => void }) => void) => {
		callback({ setTag: vi.fn() });
	}),
	captureException: vi.fn(),
	flush: vi.fn(async () => undefined),
	init: vi.fn(),
}));

vi.mock("@sentry/node", () => ({
	withScope: sentryMocks.withScope,
	captureException: sentryMocks.captureException,
	flush: sentryMocks.flush,
	init: sentryMocks.init,
}));

import { captureNodeException, flushNodeTelemetry } from "../../../src/telemetry/sentry-node";

describe("sentry-node", () => {
	afterEach(() => {
		sentryMocks.withScope.mockClear();
		sentryMocks.captureException.mockClear();
		sentryMocks.flush.mockClear();
	});

	it("does not throw when Sentry.withScope fails", () => {
		sentryMocks.withScope.mockImplementation(() => {
			throw new Error("sentry capture failed");
		});

		expect(() => {
			captureNodeException(new Error("boom"), { area: "startup" });
		}).not.toThrow();
	});

	it("does not throw when Sentry.flush fails", async () => {
		sentryMocks.flush.mockRejectedValueOnce(new Error("sentry flush failed"));

		await expect(flushNodeTelemetry(10)).resolves.toBeUndefined();
	});
});
