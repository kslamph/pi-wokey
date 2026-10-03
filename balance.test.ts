/**
 * The balance probe behind the /wokey status panel. `parseBalance` is the
 * gatekeeper (the relay's payload is not ours to trust); `fetchBalance` must
 * never throw, because a balance lookup failing must not break the panel.
 */

import { describe, expect, it, vi } from "vitest";
import { fetchBalance, parseBalance } from "./balance.ts";
import { resolveConfig } from "./config.ts";

/** The exact payload the live endpoint returned, trimmed to what we read. */
const LIVE = { userId: "2690", availableUsd: 10.787384, reservedUsd: 0 };

function stubFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>) {
	const spy = vi.fn(async (url: string, init: RequestInit) => impl(url, init));
	vi.stubGlobal("fetch", spy);
	return spy;
}

function ok(body: unknown): Response {
	return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

describe("parseBalance", () => {
	it("reads the live account payload", () => {
		expect(parseBalance(LIVE)).toEqual({ availableUsd: 10.787384, reservedUsd: 0 });
	});

	it("tolerates a missing reservedUsd and defaults it to zero", () => {
		expect(parseBalance({ availableUsd: 3 })).toEqual({ availableUsd: 3, reservedUsd: 0 });
	});

	it("keeps the procurement-order source and its reserved amount", () => {
		expect(parseBalance({ availableUsd: 5, reservedUsd: 1.5, source: "market_order" })).toEqual({
			availableUsd: 5,
			reservedUsd: 1.5,
			source: "market_order",
		});
	});

	it("rejects payloads without a usable availableUsd", () => {
		// A NaN or string balance would render as "$NaN" in the panel, which is
		// worse than showing nothing at all.
		expect(parseBalance(null)).toBeUndefined();
		expect(parseBalance({})).toBeUndefined();
		expect(parseBalance({ availableUsd: "10.78" })).toBeUndefined();
		expect(parseBalance({ availableUsd: Number.NaN })).toBeUndefined();
		expect(parseBalance({ availableUsd: Number.POSITIVE_INFINITY })).toBeUndefined();
		expect(parseBalance({ availableUsd: Number.NaN, reservedUsd: 2 })).toBeUndefined();
	});

	it("ignores a non-numeric reservedUsd rather than failing the whole read", () => {
		expect(parseBalance({ availableUsd: 4, reservedUsd: "nope" })).toEqual({ availableUsd: 4, reservedUsd: 0 });
	});

	it("ignores a non-string source", () => {
		expect(parseBalance({ availableUsd: 4, source: 7 })).toEqual({ availableUsd: 4, reservedUsd: 0 });
	});
});

describe("fetchBalance", () => {
	const config = resolveConfig();

	it("asks the balance endpoint under the configured base URL", async () => {
		const spy = stubFetch(() => ok(LIVE));
		await fetchBalance(config, "sk-test");
		expect(spy).toHaveBeenCalledWith(
			`${config.baseUrl}/dashboard/balance`,
			expect.objectContaining({ headers: { authorization: "Bearer sk-test" } }),
		);
	});

	it("returns the parsed balance on success", async () => {
		stubFetch(() => ok(LIVE));
		await expect(fetchBalance(config, "sk-test")).resolves.toEqual({ availableUsd: 10.787384, reservedUsd: 0 });
	});

	it("does not call out at all when no key is set", async () => {
		const spy = stubFetch(() => ok(LIVE));
		await expect(fetchBalance(config, undefined)).resolves.toBeUndefined();
		expect(spy).not.toHaveBeenCalled();
	});

	it("gives up quietly on a non-2xx reply", async () => {
		stubFetch(() => ({ ok: false, status: 401, json: async () => ({}) }) as unknown as Response);
		await expect(fetchBalance(config, "sk-test")).resolves.toBeUndefined();
	});

	it("gives up quietly when the body is not JSON", async () => {
		stubFetch(() => ({ ok: true, status: 200, json: async () => Promise.reject(new Error("not json")) }) as unknown as Response);
		await expect(fetchBalance(config, "sk-test")).resolves.toBeUndefined();
	});

	it("gives up quietly when the relay hangs", async () => {
		stubFetch(() => Promise.reject(new DOMException("timeout", "TimeoutError")));
		await expect(fetchBalance(config, "sk-test")).resolves.toBeUndefined();
	});

	it("gives up quietly when the payload is not a balance", async () => {
		stubFetch(() => ok({ error: { code: "invalid_api_key" } }));
		await expect(fetchBalance(config, "sk-test")).resolves.toBeUndefined();
	});

	it("bounds the wait so a stalled relay cannot hang the panel", async () => {
		const spy = stubFetch(() => ok(LIVE));
		await fetchBalance(config, "sk-test");
		// A timeout signal is what keeps "open the panel" fast on a bad network.
		expect(spy).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal: expect.anything() }));
	});
});