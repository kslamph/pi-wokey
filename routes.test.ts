/**
 * Route-profile invariants for the Wokey multi-protocol provider.
 *
 * The route registry owns every protocol-specific assumption (API type, relay
 * base URL, signed endpoint tuple, request/header policy, served-model reader)
 * so verification and model dispatch can stay protocol-neutral. These tests pin
 * the exact measured endpoint tuples: a route change must fail loudly here
 * before it can silently widen what verification accepts.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, PUBLISHED_PCR0, resolveConfig } from "./config.ts";
import { getRoute, ROUTES, type WokeyRouteId } from "./routes.ts";

describe("route registry", () => {
	it("exposes the two measured routes plus the unverified chat route", () => {
		expect(Object.keys(ROUTES).sort()).toEqual(["anthropic-direct", "openai-chat", "openai-codex"]);
	});

	it("pins the chat route as unverifiable: no fabricated endpoint, never warns", () => {
		const route = getRoute("openai-chat");
		expect(route.api).toBe("openai-completions");
		expect(route.baseUrl).toBe("https://api.wokey.ai/v1");
		expect(route.endpoint).toBeNull();
		expect(route.verification).toBe("none");
		expect(getRoute("openai-codex").verification).toBe("official");
		expect(getRoute("anthropic-direct").verification).toBe("official");
	});

	it("resolves each route by id", () => {
		for (const id of ["openai-codex", "anthropic-direct", "openai-chat"] as WokeyRouteId[]) {
			expect(getRoute(id).id).toBe(id);
		}
	});

	it("rejects an unknown route id instead of falling back", () => {
		expect(() => getRoute("openai-compatible-claude" as WokeyRouteId)).toThrow(/unknown route/);
	});

	it("is immutable, so a later route cannot be smuggled in at runtime", () => {
		expect(Object.isFrozen(ROUTES)).toBe(true);
		expect(Object.isFrozen(getRoute("openai-codex"))).toBe(true);
		expect(Object.isFrozen(getRoute("openai-codex").endpoint)).toBe(true);
		expect(Object.isFrozen(getRoute("anthropic-direct"))).toBe(true);
		expect(Object.isFrozen(getRoute("anthropic-direct").endpoint)).toBe(true);
		expect(Object.isFrozen(getRoute("openai-chat"))).toBe(true);
	});
});

describe("openai-codex route", () => {
	const route = getRoute("openai-codex");

	it("uses the bearer-key Responses API, not the ChatGPT-OAuth codex adapter", () => {
		expect(route.api).toBe("openai-responses");
	});

	it("points at the API relay base URL", () => {
		expect(route.baseUrl).toBe("https://api.wokey.ai/v1");
	});

	it("pins the exact measured signed endpoint tuple", () => {
		expect(route.endpoint).toEqual({ host: "chatgpt.com", path: "/backend-api/codex/responses", method: "POST" });
	});

	it("marks request binding unavailable (the relay rewrites the body)", () => {
		expect(route.requestBinding).toBe("unavailable");
	});

	it("reads the served model from the Responses completion event", () => {
		const body = Buffer.from(
			'event: response.created\ndata: {"response":{"model":"gpt-6-luna"}}\n\nevent: response.completed\ndata: {"response":{"model":"gpt-6.1-sol"}}\n\n',
			"utf8",
		);
		expect(route.extractServedModel(body)).toBe("gpt-6.1-sol");
	});

	it("returns undefined when the body names no model", () => {
		expect(route.extractServedModel(Buffer.from("event: response.completed\ndata: {}\n\n", "utf8"))).toBeUndefined();
	});

	it("shapes requests into the Codex envelope the upstream expects", () => {
		const out = route.transformPayload({ model: "gpt-6-luna" }, "session-xyz");
		expect(out.store).toBe(false);
		expect(out.instructions).toBe("You are a helpful assistant.");
		expect(out.prompt_cache_key).toBe("session-xyz");
	});

	it("sends codex session headers carrying the cache key", () => {
		const out = route.transformHeaders({}, "session-xyz");
		expect(out["session-id"]).toBe("session-xyz");
		expect(out["x-client-request-id"]).toBe("session-xyz");
		expect(out["session_id"]).toBeNull();
	});
});

describe("anthropic-direct route", () => {
	const route = getRoute("anthropic-direct");

	it("uses pi's native Anthropic Messages API", () => {
		expect(route.api).toBe("anthropic-messages");
	});

	it("points at the bare relay root, not the GPT /v1 base", () => {
		expect(route.baseUrl).toBe("https://api.wokey.ai");
	});

	it("pins the exact measured signed endpoint tuple", () => {
		expect(route.endpoint).toEqual({ host: "api.anthropic.com", path: "/v1/messages", method: "POST" });
	});

	it("marks request binding unavailable, like the GPT route", () => {
		expect(route.requestBinding).toBe("unavailable");
	});

	it("reads the served model from message_start.message.model", () => {
		const body = Buffer.from(
			'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-opus-5-5"}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta"}\n\n',
			"utf8",
		);
		expect(route.extractServedModel(body)).toBe("claude-opus-5-5");
	});

	it("returns undefined when the body names no model", () => {
		expect(route.extractServedModel(Buffer.from('event: ping\ndata: {"type":"ping"}\n\n', "utf8"))).toBeUndefined();
	});

	it("adds no Codex envelope to the payload", () => {
		const payload = { model: "claude-opus-5-5", max_tokens: 128000 };
		expect(route.transformPayload(payload, "session-xyz")).toEqual(payload);
		expect(route.transformPayload(payload, "session-xyz")).not.toBe(payload);
	});

	it("adds no Codex session headers", () => {
		const out = route.transformHeaders({ "x-other": "keep" }, "session-xyz");
		expect(out).toEqual({ "x-other": "keep" });
		expect(out["session-id"]).toBeUndefined();
		expect(out["x-client-request-id"]).toBeUndefined();
		expect(out["session_id"]).toBeUndefined();
	});
});

describe("shared verification anchors", () => {
	it("pins the audited PCR0 in code, not in user settings", () => {
		expect(DEFAULT_CONFIG.expectedPcr0).toBe(PUBLISHED_PCR0);
		expect(resolveConfig().expectedPcr0).toBe(PUBLISHED_PCR0);
	});
});
