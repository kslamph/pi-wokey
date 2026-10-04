/**
 * Account balance, read from wokey for the /wokey status panel.
 *
 * The relay owns this payload, so `parseBalance` is the only place that decides
 * what a number means, and it is pure so the shape can be pinned in tests
 * against the live response. `fetchBalance` is deliberately incapable of
 * throwing: the status panel must render even when the balance call does not,
 * because a failed lookup is a missing number, never a broken panel.
 */

export interface BalanceInfo {
	/** Spendable now, in USD. */
	availableUsd: number;
	/** Held against in-flight video jobs, in USD. Zero unless reported. */
	reservedUsd: number;
	/** `"market_order"` when the key belongs to a procurement order. */
	source?: string;
}

/** Same timeout as the catalog sync: a slow relay must not stall the UI. */
const BALANCE_TIMEOUT_MS = 2000;

/**
 * Validate the relay's balance payload. Anything without a finite
 * `availableUsd` is rejected — a `NaN` here would render as "$NaN", which is
 * worse than showing nothing.
 */
export function parseBalance(json: unknown): BalanceInfo | undefined {
	if (typeof json !== "object" || json === null) return undefined;
	const raw = json as Record<string, unknown>;
	if (typeof raw.availableUsd !== "number" || !Number.isFinite(raw.availableUsd)) return undefined;
	const reserved = typeof raw.reservedUsd === "number" && Number.isFinite(raw.reservedUsd) ? raw.reservedUsd : 0;
	return {
		availableUsd: raw.availableUsd,
		reservedUsd: reserved,
		...(typeof raw.source === "string" ? { source: raw.source } : {}),
	};
}

/**
 * Stable Wokey API root. The dashboard hangs off this root directly — never
 * derive it from a model's baseUrl, which is per-route and may point at a
 * different relay host.
 */
export const WOKEY_API_ROOT = "https://api.wokey.ai/v1";

/**
 * Best-effort balance read against the stable relay root. Resolves to
 * `undefined` for every failure mode — no key, non-2xx, unparseable body,
 * timeout, abort — so callers can render without a branch on the error. The
 * optional caller signal is honored alongside the built-in timeout, so a
 * stalled relay neither hangs the panel nor outlives its caller.
 */
export async function fetchBalance(
	rootUrl: string,
	key: string | undefined,
	signal?: AbortSignal,
): Promise<BalanceInfo | undefined> {
	if (!key) return undefined;
	try {
		const res = await fetch(`${rootUrl}/dashboard/balance`, {
			headers: { authorization: `Bearer ${key}` },
			signal: signal ? AbortSignal.any([AbortSignal.timeout(BALANCE_TIMEOUT_MS), signal]) : AbortSignal.timeout(BALANCE_TIMEOUT_MS),
		});
		if (!res.ok) return undefined;
		return parseBalance(await res.json());
	} catch {
		return undefined;
	}
}