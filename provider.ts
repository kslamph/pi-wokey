/**
 * The native Wokey provider: one `wokey` provider with pi-native auth and one
 * verified API implementation per route.
 *
 * Auth is pi's `envApiKeyAuth`, so the Wokey key lives where every other pi
 * key lives (`auth.json` via `/login wokey`) — this module never reads or
 * writes a custom settings file. The env-var list is deliberately empty:
 * ambient auth is not offered (see `auth`), so the stored credential is the
 * only way in. Catalog refresh re-reads the
 * live catalog through the GPT relay root and overlays it with the validated
 * `refreshFromCatalog`; any failure keeps the last-known lineup.
 */

import {
	createProvider,
	envApiKeyAuth,
	type Model,
	type Provider,
	type RefreshModelsContext,
} from "@earendil-works/pi-ai";
// NOTE: import the wire APIs from the /compat entrypoint, never from the deep
// `/api/*.lazy` paths. Pi aliases only `@earendil-works/pi-ai`, `/compat`,
// `/oauth` and `/providers/all` into extensions; a deep import resolves by plain
// Node lookup, which finds nothing under a managed npm install (peers are
// suppressed) and breaks `pi` startup with "Cannot find module" (seen in 0.6.2).
import { anthropicMessagesApi, openAICompletionsApi, openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import { PROVIDER_ID, type WokeyConfig } from "./config.ts";
import { activeModels, refreshFromCatalog } from "./models.ts";
import { getRoute, type WokeyApi } from "./routes.ts";
import { createVerifiedStreams } from "./stream.ts";
import type { ProofReport } from "./verify/probe.ts";

export const PROVIDER_NAME = "wokey.ai";

export interface WokeyProviderOptions {
	config: WokeyConfig;
	onReport(report: ProofReport): void;
}

/** Live catalog endpoint, served by the GPT route's relay root. */
export const WOKEY_CATALOG_URL = `${getRoute("openai-codex").baseUrl}/models`;

/**
 * Last catalog-overlay warnings, for the `/wokey status` panel. The native
 * `fetchModels` path has no warning channel back through pi's registry, so the
 * overlay result is kept here: a successful refresh replaces the list, while a
 * skipped or failed refresh keeps the previous one rather than blanking it.
 */
let lastCatalogWarnings: string[] = [];

export function getLastCatalogWarnings(): string[] {
	return [...lastCatalogWarnings];
}

function apiKeyOf(credential: RefreshModelsContext["credential"]): string | undefined {
	if (credential?.type === "api_key" && typeof credential.key === "string" && credential.key.trim()) {
		return credential.key.trim();
	}
	return undefined;
}

/**
 * Fetch the live catalog overlay and return the route-aware known model list.
 * Transactional: any failure (no credential, non-2xx, unparseable body,
 * abort) keeps the last-known lineup — a catalog hiccup must not shrink or
 * empty the provider.
 */
export async function refreshWokeyModels(context: RefreshModelsContext): Promise<readonly Model<WokeyApi>[]> {
	const key = apiKeyOf(context.credential);
	if (key) {
		try {
			const res = await fetch(WOKEY_CATALOG_URL, {
				headers: { authorization: `Bearer ${key}` },
				signal: context.signal,
			});
			if (res.ok) lastCatalogWarnings = refreshFromCatalog(await res.json()).warnings;
		} catch {
			// Keep the last-known catalog; the overlay is best-effort.
		}
	}
	return activeModels();
}

export function createWokeyProvider(options: WokeyProviderOptions): Provider<WokeyApi> {
	const { config, onReport } = options;
	return createProvider({
		id: PROVIDER_ID,
		name: PROVIDER_NAME,
		// Empty env list: `login`/`logout` still work (they live in the auth
		// handler, not the env list), but `WOKEY_API_KEY` is not accepted as a
		// credential. Ambient auth resolved unreliably for this provider —
		// `prepareRequest` intermittently threw "Provider is not configured:
		// wokey" — while the stored-credential path never failed.
		auth: { apiKey: envApiKeyAuth("Wokey API key", []) },
		models: activeModels(),
		fetchModels: refreshWokeyModels,
		api: {
			"openai-responses": createVerifiedStreams(getRoute("openai-codex"), config, onReport, openAIResponsesApi()),
			"anthropic-messages": createVerifiedStreams(getRoute("anthropic-direct"), config, onReport, anthropicMessagesApi()),
			// Same verified wrapper, identity policy: the route has no proof-bearing
			// form, so every exchange reports `unproven` — recorded and shown, never
			// warned on. Keeping the wrapper (instead of the raw adapter) preserves
			// uniform accounting and lets verification light up if Wokey adds proofs.
			"openai-completions": createVerifiedStreams(getRoute("openai-chat"), config, onReport, openAICompletionsApi()),
		},
	});
}
