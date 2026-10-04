/**
 * The native Wokey provider: one `wokey` provider with pi-native auth and one
 * verified API implementation per route.
 *
 * Auth is pi's `envApiKeyAuth`, so the Wokey key lives where every other pi
 * key lives (`auth.json` via `/login wokey`, or `WOKEY_API_KEY`) — this module
 * never reads or writes a custom settings file. Catalog refresh re-reads the
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
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { PROVIDER_ID, type WokeyConfig } from "./config.ts";
import { activeModels, refreshFromCatalog } from "./models.ts";
import { getRoute, type WokeyApi } from "./routes.ts";
import { createVerifiedStreams } from "./stream.ts";
import type { ProofReport } from "./verify/probe.ts";

export const PROVIDER_NAME = "wokey.ai (verified)";

export interface WokeyProviderOptions {
	config: WokeyConfig;
	onReport(report: ProofReport): void;
}

/** Live catalog endpoint, served by the GPT route's relay root. */
export const WOKEY_CATALOG_URL = `${getRoute("openai-codex").baseUrl}/models`;

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
			if (res.ok) refreshFromCatalog(await res.json());
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
		auth: { apiKey: envApiKeyAuth("Wokey API key", ["WOKEY_API_KEY"]) },
		models: activeModels(),
		fetchModels: refreshWokeyModels,
		api: {
			"openai-responses": createVerifiedStreams(getRoute("openai-codex"), config, onReport, openAIResponsesApi()),
			"anthropic-messages": createVerifiedStreams(getRoute("anthropic-direct"), config, onReport, anthropicMessagesApi()),
		},
	});
}
