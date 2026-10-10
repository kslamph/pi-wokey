/**
 * Tests for the wokey proof probe.
 *
 * The hardware half (COSE/P-384 → AWS Nitro root) cannot be exercised without a
 * real attestation document, so those gates run against a stub verifier. What is
 * tested for real here is everything this extension is responsible for: the
 * proof-record handling, the byte-exactness of the request capture, the
 * host/path gates, and — most importantly — that the PCR0 gate cannot be
 * satisfied by the proof's own self-declared value. The byte-level delivery
 * invariants (relay keepalives, non-streaming bodies, unnegotiated transports) are
 * covered by the end-to-end suite in probe.e2e.test.ts.
 */

import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DEFAULT_CONFIG, PUBLISHED_PCR0, resolveConfig } from "./config.ts";
import { getRoute } from "./routes.ts";
import { buildV2Statement, sha256 } from "./verify/signing.ts";
import { parseTeeProofEvent } from "./verify/tee-verify-core.ts";
import { errorChecks, stripTrailingProofEvent, verifyExchange } from "./verify/probe.ts";
import type { ClassifiedCheck, VerificationPolicy } from "./verify/probe.ts";
import type { AttestationVerifier, TeeProofWire } from "./verify/tee-verify-core.ts";

const VECTORS = JSON.parse(readFileSync(new URL("./test-fixtures/signing-vectors.json", import.meta.url), "utf8")) as {
	cases_v2: {
		name: string;
		nonce_b64: string;
		upstream_host: string;
		upstream_path: string;
		http_method: string;
		http_status: number;
		resp_content_type: string;
		request_body_b64: string;
		response_body_b64: string;
		expected: { statement: string; statement_hex?: string; request_body_sha256: string; response_body_sha256: string };
	}[];
};

const NONCE = Buffer.from("0123456789abcdef", "utf8").toString("base64");
const PUBKEY_B64 = Buffer.alloc(32, 7).toString("base64");

/** Builds a proof whose statement fields are internally consistent. */
function makeProof(over: Partial<TeeProofWire> = {}): TeeProofWire {
	return {
		v: 2,
		alg: "ed25519",
		public_key: PUBKEY_B64,
		nonce: NONCE,
		upstream_host: "chatgpt.com",
		upstream_path: "/backend-api/codex/responses",
		http_method: "POST",
		http_status: 200,
		resp_content_type: "text/event-stream",
		request_body_sha256: "0".repeat(64),
		response_body_sha256: "0".repeat(64),
		signature: "AAAA",
		attestation: "AAAA",
		pcr0: PUBLISHED_PCR0,
		...over,
	};
}

/** A stub that reports an attestation matching the given key/pcr0/nonce. */
function stubAttestation(over: { publicKey?: string; pcr0?: string; nonce?: string; ok?: boolean } = {}): AttestationVerifier {
	return () => ({
		ok: over.ok ?? true,
		sigOk: over.ok ?? true,
		chainOk: over.ok ?? true,
		rootSelf: over.ok ?? true,
		rootPinned: over.ok ?? true,
		timeValid: true,
		pcr0: over.pcr0 ?? PUBLISHED_PCR0,
		publicKey: over.publicKey ?? PUBKEY_B64,
		nonce: over.nonce ?? NONCE,
		rootFingerprint: "64:1A:03:21:A3:E2:44:EF:E4:56:46:31:95:D6:06:31:7E:D7:CD:CC:3C:17:56:E0:98:93:F3:C6:8F:79:BB:5B",
	});
}

function sseWithProof(proof: TeeProofWire, body = "event: response.completed\ndata: {\"response\":{\"model\":\"gpt-6.1-sol\"}}\n\n") {
	return Buffer.concat([
		Buffer.from(body, "utf8"),
		Buffer.from(`event: tee.proof\ndata: ${JSON.stringify(proof)}\n\n`, "utf8"),
	]);
}

function findCheck(checks: { name: string; ok: boolean; severity?: string }[], name: string) {
	return checks.find((c) => c.name === name);
}

/** GPT route under test plus a policy built from it. Per-route binding stays reachable: pass `{ requestBinding: "verify" }` to pin a strict `verified`. */
const GPT_ROUTE = getRoute("openai-codex");
function gptPolicy(over: Partial<VerificationPolicy> = {}): VerificationPolicy {
	return {
		expectedPcr0: resolveConfig().expectedPcr0,
		endpoint: GPT_ROUTE.endpoint,
		requestBinding: GPT_ROUTE.requestBinding,
		...over,
	};
}

describe("statement builder (vendored golden vectors)", () => {
	it.each(VECTORS.cases_v2)("reproduces $name byte-for-byte", (c) => {
		const statement = buildV2Statement({
			nonceB64: c.nonce_b64,
			upstreamHost: c.upstream_host,
			upstreamPath: c.upstream_path,
			httpMethod: c.http_method,
			httpStatus: c.http_status,
			respContentType: c.resp_content_type,
			requestBodySha256Hex: c.expected.request_body_sha256,
			responseBodySha256Hex: c.expected.response_body_sha256,
		});
		expect(statement.toString("utf8")).toBe(c.expected.statement);
		expect(statement.toString("hex")).toBe(c.expected.statement_hex ?? statement.toString("hex"));
		expect(sha256(Buffer.from(c.request_body_b64, "base64")).toString("hex")).toBe(c.expected.request_body_sha256);
		expect(sha256(Buffer.from(c.response_body_b64, "base64")).toString("hex")).toBe(c.expected.response_body_sha256);
	});
});

describe("proof record parsing", () => {
	it("finds the trailing tee.proof event and returns the upstream body", () => {
		const proof = makeProof();
		const parsed = parseTeeProofEvent(sseWithProof(proof, "data: hello\n\n"));
		expect(parsed.proof?.nonce).toBe(NONCE);
		expect(parsed.body.toString("utf8")).toBe("data: hello\n\n");
	});

	it("is not fooled by an identical string inside upstream content", () => {
		const proof = makeProof();
		const parsed = parseTeeProofEvent(sseWithProof(proof, "data: see event: tee.proof docs\n\n"));
		expect(parsed.proof?.nonce).toBe(NONCE);
	});
});

describe("trailing proof-event stripper", () => {
	async function collect(src: ReadableStream<Uint8Array>): Promise<Buffer> {
		const chunks: Buffer[] = [];
		const reader = src.getReader();
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			if (value) chunks.push(Buffer.from(value));
		}
		return Buffer.concat(chunks);
	}

	async function* drip(payload: Buffer, size: number): AsyncGenerator<Uint8Array> {
		for (let i = 0; i < payload.length; i += size) yield new Uint8Array(payload.subarray(i, i + size));
	}

	const proof = makeProof();
	const body = "event: response.completed\ndata: {}\n\n";

	it("drops the proof event even when it straddles chunk boundaries", async () => {
		for (const size of [1, 3, 7, 16, 64, 4096]) {
			const src = new ReadableStream<Uint8Array>({
				async start(c) {
					for await (const chunk of drip(sseWithProof(proof, body), size)) c.enqueue(chunk);
					c.close();
				},
			});
			const out = await collect(stripTrailingProofEvent(src));
			expect(out.toString("utf8"), `chunk size ${size}`).toBe(body);
		}
	});

	it("passes a proof-free stream through untouched", async () => {
		const src = new ReadableStream<Uint8Array>({
			async start(c) {
				c.enqueue(new Uint8Array(Buffer.from(body, "utf8")));
				c.close();
			},
		});
		expect((await collect(stripTrailingProofEvent(src))).toString("utf8")).toBe(body);
	});
});

describe("verification gates", () => {
	it("reports 'unproven' when the response carries no proof", () => {		const { report } = verifyExchange(
			{ extractServedModel: GPT_ROUTE.extractServedModel, wireBytes: Buffer.from("event: response.completed\ndata: {}\n\n", "utf8"), attestationVerifier: stubAttestation() },
			gptPolicy(),
		);
		expect(report.status).toBe("unproven");
		expect(report.checks.every((c) => c.ok)).toBe(false);
	});

	it("reports unproven-by-design for routes with no measured endpoint", () => {
		const chat = getRoute("openai-chat");
		const wire = 'data: {"id":"chatcmpl-1","model":"glm-5.3-flash","choices":[]}\n\n';
		const { report } = verifyExchange(
			{ extractServedModel: chat.extractServedModel, wireBytes: Buffer.from(wire, "utf8") },
			{ expectedPcr0: resolveConfig().expectedPcr0, endpoint: chat.endpoint, requestBinding: chat.requestBinding },
		);
		expect(report.status).toBe("unproven");
		// A single design check, not a failure: nothing here can warn.
		expect(report.checks).toHaveLength(1);
		expect(report.checks[0]!.name).toBe("Proof present");
		expect(report.checks[0]!.detail).toMatch(/Claude \+ GPT routes only/);
		// The relay's self-report is still shown — but with no integrity binding
		// it is display-only: no Served-model check is attached.
		expect(report.reportedModel).toBe("glm-5.3-flash");
		expect(report.checks.some((c) => c.name === "Served model")).toBe(false);
	});

	it("does not let the proof's own pcr0 satisfy the PCR0 gate", () => {
		// The exact defect in wokey's browser verifier: it adopts proof.pcr0 as
		// the "audited" value, so the gate passes for any image at all.
		const roguePcr0 = "1".repeat(96);
		const proof = makeProof({ pcr0: roguePcr0 });
		const { report } = verifyExchange(
			{ extractServedModel: GPT_ROUTE.extractServedModel, wireBytes: sseWithProof(proof), attestationVerifier: stubAttestation({ pcr0: roguePcr0 }) },
			gptPolicy(),
		);
		expect(findCheck(report.checks, "Enclave image (PCR0)")?.ok).toBe(false);
		expect(report.status).toBe("failed");
	});

	it("flags an unset PCR0 anchor as unchecked, not as a failed exchange", () => {
		const proof = makeProof();
		const { report } = verifyExchange(
			{ extractServedModel: GPT_ROUTE.extractServedModel, wireBytes: sseWithProof(proof), attestationVerifier: stubAttestation() },
			gptPolicy({ expectedPcr0: "" }),
		);
		const check = findCheck(report.checks, "Enclave image (PCR0)");
		expect(check?.ok).toBe(false);
		// A local configuration weakness, not something that went wrong in this
		// exchange: it stays visibly not-passing without turning the run red.
		expect(check?.severity).toBe("unchecked");
		// The stub cannot satisfy Ed25519, so the run is red for that reason alone —
		// the unset anchor must not be among the causes.
		const failing = report.checks.filter((c) => c.severity === "fail").map((c) => c.name);
		expect(failing).not.toContain("Enclave image (PCR0)");
		expect(failing).toEqual(["Response signature"]);
	});

	it("rejects a signature key the attestation does not endorse", () => {
		const proof = makeProof({ public_key: Buffer.alloc(32, 9).toString("base64") });
		const { report } = verifyExchange(
			{ extractServedModel: GPT_ROUTE.extractServedModel, wireBytes: sseWithProof(proof), attestationVerifier: stubAttestation() },
			gptPolicy(),
		);
		expect(findCheck(report.checks, "Signing key binding")?.ok).toBe(false);
	});

	it("rejects a nonce that disagrees between proof and attestation", () => {
		const proof = makeProof();
		const { report } = verifyExchange(
			{ extractServedModel: GPT_ROUTE.extractServedModel, wireBytes: sseWithProof(proof), attestationVerifier: stubAttestation({ nonce: Buffer.from("other", "utf8").toString("base64") }) },
			gptPolicy(),
		);
		expect(findCheck(report.checks, "Nonce binding")?.ok).toBe(false);
	});

	it("rejects an unsigned upstream host", () => {
		const proof = makeProof({ upstream_host: "wokey.internal" });
		const { report } = verifyExchange(
			{ extractServedModel: GPT_ROUTE.extractServedModel, wireBytes: sseWithProof(proof), attestationVerifier: stubAttestation() },
			gptPolicy(),
		);
		expect(findCheck(report.checks, "Upstream host")?.ok).toBe(false);
		expect(report.status).toBe("failed");
	});

	it("rejects an unexpected upstream path even on the right host", () => {
		const proof = makeProof({ upstream_path: "/v1/cheap" });
		const { report } = verifyExchange(
			{ extractServedModel: GPT_ROUTE.extractServedModel, wireBytes: sseWithProof(proof), attestationVerifier: stubAttestation() },
			gptPolicy(),
		);
		expect(findCheck(report.checks, "Upstream path")?.ok).toBe(false);
	});

	// Measured against live traffic 2026-10-03: both GPT models sign chatgpt.com,
	// not api.openai.com, and wokey rewrites the body before the enclave sees it.
	// Measured against live traffic 2026-10-03: both GPT models sign chatgpt.com,
	// not api.openai.com, and wokey rewrites the body before the enclave sees it.
	it("accepts the real upstream the relay actually signs", () => {
		const proof = makeProof({ upstream_host: "chatgpt.com", upstream_path: "/backend-api/codex/responses" });
		const { report } = verifyExchange({ extractServedModel: GPT_ROUTE.extractServedModel, wireBytes: sseWithProof(proof), attestationVerifier: stubAttestation() }, gptPolicy());
		expect(findCheck(report.checks, "Upstream host")?.ok).toBe(true);
		expect(findCheck(report.checks, "Upstream path")?.ok).toBe(true);
	});

	it("still rejects api.openai.com, which the GPT lane never signs", () => {
		const proof = makeProof({ upstream_host: "api.openai.com" });
		const { report } = verifyExchange({ extractServedModel: GPT_ROUTE.extractServedModel, wireBytes: sseWithProof(proof), attestationVerifier: stubAttestation() }, gptPolicy());
		expect(findCheck(report.checks, "Upstream host")?.ok).toBe(false);
	});

	it("does not check request binding when the request bytes were not captured", () => {
		const proof = makeProof();
		const { report } = verifyExchange(
			{ extractServedModel: GPT_ROUTE.extractServedModel, wireBytes: sseWithProof(proof), attestationVerifier: stubAttestation() },
			gptPolicy(),
		);
		expect(findCheck(report.checks, "Request binding")).toBeUndefined();
	});

	it("surfaces the model the upstream reported in its own response body", () => {
		const proof = makeProof();
		const { report } = verifyExchange(
			{ extractServedModel: GPT_ROUTE.extractServedModel,
				wireBytes: sseWithProof(proof, 'event: response.completed\ndata: {"response":{"model":"gpt-6.1-sol"}}\n\n'),
				attestationVerifier: stubAttestation(),
			},
			gptPolicy(),
		);
		expect(report.reportedModel).toBe("gpt-6.1-sol");
	});

	it("verifies a well-formed exchange end to end with a stub attestation", () => {
		const body = "event: response.completed\ndata: {}\n\n";
		const proof = makeProof({ response_body_sha256: createHash("sha256").update(body, "utf8").digest("hex") });
		const { report } = verifyExchange(
			{ extractServedModel: GPT_ROUTE.extractServedModel, wireBytes: sseWithProof(proof, body), attestationVerifier: stubAttestation() },
			gptPolicy(),
		);
		// The stub bypasses the Ed25519 half, so the signature check is expected
		// to fail; everything this extension owns must pass.
		expect(findCheck(report.checks, "Remote attestation")?.ok).toBe(true);
		expect(findCheck(report.checks, "Signing key binding")?.ok).toBe(true);
		expect(findCheck(report.checks, "Nonce binding")?.ok).toBe(true);
		expect(findCheck(report.checks, "Enclave image (PCR0)")?.ok).toBe(true);
		expect(findCheck(report.checks, "Upstream host")?.ok).toBe(true);
		expect(findCheck(report.checks, "Upstream path")?.ok).toBe(true);
	});
});

describe("Anthropic route verification", () => {
	const ANTHROPIC = getRoute("anthropic-direct");
	const policy = (over: Partial<VerificationPolicy> = {}): VerificationPolicy => ({
		expectedPcr0: resolveConfig().expectedPcr0,
		endpoint: ANTHROPIC.endpoint,
		requestBinding: ANTHROPIC.requestBinding,
		...over,
	});
	const claudeBody = (model: string) =>
		`event: message_start\ndata: {"type":"message_start","message":{"id":"msg_01","type":"message","role":"assistant","model":"${model}","content":[]}}\n\n`;
	const claudeProof = (over: Partial<TeeProofWire> = {}) =>
		makeProof({ upstream_host: "api.anthropic.com", upstream_path: "/v1/messages", http_method: "POST", ...over });
	const extract = ANTHROPIC.extractServedModel;

	it("passes the served-model check for the requested Claude model", () => {
		const body = claudeBody("claude-opus-5-5");
		const proof = claudeProof({ response_body_sha256: createHash("sha256").update(body, "utf8").digest("hex") });
		const { report } = verifyExchange(
			{ wireBytes: sseWithProof(proof, body), expectedModel: "claude-opus-5-5", extractServedModel: extract, attestationVerifier: stubAttestation() },
			policy(),
		);
		expect(findCheck(report.checks, "Served model")?.ok).toBe(true);
		expect(report.reportedModel).toBe("claude-opus-5-5");
	});

	it("flags a Claude substitution and names both models", () => {
		const body = claudeBody("claude-opus-5-5");
		const proof = claudeProof({ response_body_sha256: createHash("sha256").update(body, "utf8").digest("hex") });
		const { report } = verifyExchange(
			{ wireBytes: sseWithProof(proof, body), expectedModel: "claude-opus-9-9", extractServedModel: extract, attestationVerifier: stubAttestation() },
			policy(),
		);
		const c = report.checks.find((c) => c.name === "Served model");
		expect(c?.ok).toBe(false);
		expect(c?.detail).toContain("claude-opus-5-5");
		expect(c?.detail).toContain("claude-opus-9-9");
	});

	it("reads the model with the Anthropic reader, not the Responses reader", () => {
		const body = claudeBody("claude-opus-5-5");
		const proof = claudeProof({ response_body_sha256: createHash("sha256").update(body, "utf8").digest("hex") });
		const gptExtract = getRoute("openai-codex").extractServedModel;
		expect(gptExtract(Buffer.from(body, "utf8"))).toBeUndefined();
		const { report } = verifyExchange(
			{ wireBytes: sseWithProof(proof, body), expectedModel: "claude-opus-5-5", extractServedModel: gptExtract, attestationVerifier: stubAttestation() },
			policy(),
		);
		expect(findCheck(report.checks, "Served model")?.ok).toBe(false);
	});

	it("still passes the existing GPT fixture under the GPT route policy", () => {
		const body = 'event: response.completed\ndata: {"response":{"model":"gpt-6-luna"}}\n\n';
		const proof = makeProof({ response_body_sha256: createHash("sha256").update(body, "utf8").digest("hex") });
		const { report } = verifyExchange(
			{ wireBytes: sseWithProof(proof, body), expectedModel: "gpt-6-luna", extractServedModel: GPT_ROUTE.extractServedModel, attestationVerifier: stubAttestation() },
			gptPolicy(),
		);
		expect(findCheck(report.checks, "Served model")?.ok).toBe(true);
		expect(report.reportedModel).toBe("gpt-6-luna");
	});
});

describe("exact endpoint tuples", () => {
	const GPT = getRoute("openai-codex");
	const ANTHROPIC = getRoute("anthropic-direct");
	const anthropicPolicy = (): VerificationPolicy => ({
		expectedPcr0: resolveConfig().expectedPcr0,
		endpoint: ANTHROPIC.endpoint,
		requestBinding: ANTHROPIC.requestBinding,
	});
	const extract = GPT.extractServedModel;
	const check = (proof: TeeProofWire, routePolicy: VerificationPolicy, name: string) =>
		verifyExchange({ wireBytes: sseWithProof(proof), extractServedModel: extract, attestationVerifier: stubAttestation() }, routePolicy)
			.report.checks.find((c) => c.name === name);

	it("fails a wrong host, a wrong path, and a wrong method each", () => {
		expect(check(makeProof({ upstream_host: "api.anthropic.com" }), gptPolicy(), "Upstream host")?.ok).toBe(false);
		expect(check(makeProof({ upstream_path: "/v1/cheap" }), gptPolicy(), "Upstream path")?.ok).toBe(false);
		expect(check(makeProof({ http_method: "GET" }), gptPolicy(), "Upstream method")?.ok).toBe(false);
	});

	it("rejects a host from one route combined with a path from another", () => {
		// Anthropic host on the GPT path: host gate fails under the GPT policy.
		expect(check(makeProof({ upstream_host: "api.anthropic.com" }), gptPolicy(), "Upstream host")?.ok).toBe(false);
		// GPT path on the Anthropic host: path gate fails under the Anthropic policy.
		const crossed = makeProof({ upstream_host: "api.anthropic.com", upstream_path: "/backend-api/codex/responses" });
		expect(check(crossed, anthropicPolicy(), "Upstream path")?.ok).toBe(false);
		// And the mirror: GPT host with the Anthropic path under the GPT policy.
		const mirrored = makeProof({ upstream_host: "chatgpt.com", upstream_path: "/v1/messages" });
		expect(check(mirrored, gptPolicy(), "Upstream path")?.ok).toBe(false);
	});

	it("does not accept path suffixes or extra segments", () => {
		expect(check(makeProof({ upstream_path: "/prefix/backend-api/codex/responses" }), gptPolicy(), "Upstream path")?.ok).toBe(false);
		expect(check(makeProof({ upstream_path: "/backend-api/codex/responses/extra" }), gptPolicy(), "Upstream path")?.ok).toBe(false);
	});

	it("matches the tuple exactly: case and method included", () => {
		expect(check(makeProof({ upstream_host: "ChatGPT.com" }), gptPolicy(), "Upstream host")?.ok).toBe(false);
		expect(check(makeProof({ http_method: "post" }), gptPolicy(), "Upstream method")?.ok).toBe(false);
		expect(check(makeProof(), gptPolicy(), "Upstream method")?.ok).toBe(true);
	});
});

describe("config", () => {
	it("pins an audited PCR0 rather than trusting the wire", () => {
		expect(DEFAULT_CONFIG.expectedPcr0).toBe(PUBLISHED_PCR0);
		expect(DEFAULT_CONFIG.expectedPcr0).toMatch(/^[a-f0-9]{96}$/);
	});
});
describe("English-only, concise, per-case reasons", () => {
	const find = (checks: { name: string; ok: boolean; detail?: string; severity?: string }[], name: string) =>
		checks.find((c) => c.name === name);
	const text = (r: { checks: { name: string; detail: string }[] }) =>
		r.checks.map((c) => `${c.name}: ${c.detail}`).join("\n");

	it("never emits non-English text", () => {
		const proof = makeProof({ upstream_host: "wokey.internal" });
		const { report } = verifyExchange({ extractServedModel: GPT_ROUTE.extractServedModel, wireBytes: sseWithProof(proof), attestationVerifier: stubAttestation() }, gptPolicy());
		expect(text(report)).not.toMatch(/[一-鿿]/);
	});

	it("states the actual served model and expected host on a host failure", () => {
		const proof = makeProof({ upstream_host: "wokey.internal", upstream_path: "/x" });
		const { report } = verifyExchange({ extractServedModel: GPT_ROUTE.extractServedModel, wireBytes: sseWithProof(proof), attestationVerifier: stubAttestation() }, gptPolicy());
		expect(find(report.checks, "Upstream host")?.detail).toBe("served from wokey.internal — not the official endpoint");
	});

	it("flags model substitution and names both models", () => {
		const body = 'event: response.completed\ndata: {"response":{"model":"gpt-6-luna"}}\n\n';
		const proof = makeProof({ response_body_sha256: createHash("sha256").update(body, "utf8").digest("hex") });
		const { report } = verifyExchange(
			{ extractServedModel: GPT_ROUTE.extractServedModel, wireBytes: sseWithProof(proof, body), expectedModel: "gpt-6-astra", attestationVerifier: stubAttestation() },
			gptPolicy(),
		);
		const c = find(report.checks, "Served model");
		expect(c?.ok).toBe(false);
		expect(c?.detail).toContain("gpt-6-luna");
		expect(c?.detail).toContain("gpt-6-astra");
	});

	it("passes the served-model check when the upstream reports what was requested", () => {
		const body = 'event: response.completed\ndata: {"response":{"model":"gpt-6-luna"}}\n\n';
		const proof = makeProof({ response_body_sha256: createHash("sha256").update(body, "utf8").digest("hex") });
		const { report } = verifyExchange(
			{ extractServedModel: GPT_ROUTE.extractServedModel, wireBytes: sseWithProof(proof, body), expectedModel: "gpt-6-luna", attestationVerifier: stubAttestation() },
			gptPolicy(),
		);
		expect(find(report.checks, "Served model")?.ok).toBe(true);
	});

	it("labels the known request-binding case as a documented gap, not a failure reason", () => {
		const proof = makeProof();
		// Request bytes must be captured for the check to exist at all.
		const { report } = verifyExchange(
			{ extractServedModel: GPT_ROUTE.extractServedModel, wireBytes: sseWithProof(proof), requestBytes: Buffer.from('{"model":"gpt-6-luna"}'), attestationVerifier: stubAttestation() },
			gptPolicy(),
		);
		expect(find(report.checks, "Request binding")?.ok).toBe(false);
		expect(find(report.checks, "Request binding")?.detail).toMatch(/documented gap/);
		// Accepted, so it is never surfaced as an error — only as a disclosed limit.
		expect(find(report.checks, "Request binding")?.severity).toBe("gap");
	});
});
describe("check severity", () => {
	const officialPolicy = (): VerificationPolicy => ({
		expectedPcr0: resolveConfig().expectedPcr0,
		endpoint: GPT_ROUTE.endpoint!,
		requestBinding: GPT_ROUTE.requestBinding,
	});
	/**
	 * A healthy official-route run. The attestation stub bypasses the Ed25519
	 * half, so `Response signature` cannot pass under it — see "verifies a
	 * well-formed exchange end to end". It is coerced here so the gap/fail split
	 * can be asserted without that artifact; every other check is genuine.
	 */
	const healthy = (): ClassifiedCheck[] => {
		const body = 'event: response.completed\ndata: {"response":{"model":"gpt-6.1-sol"}}\n\n';
		const proof = makeProof({ response_body_sha256: createHash("sha256").update(body, "utf8").digest("hex") });
		return verifyExchange(
			{
				extractServedModel: GPT_ROUTE.extractServedModel,
				wireBytes: sseWithProof(proof, body),
				requestBytes: Buffer.from('{"model":"gpt-6-luna"}'),
				attestationVerifier: stubAttestation(),
			},
			officialPolicy(),
		).report.checks.map((c) => (c.name === "Response signature" ? { ...c, ok: true, severity: "pass" as const } : c));
	};

	it("stamps every check, so nothing has to be re-derived from a boolean", () => {
		const checks = healthy();
		expect(checks.length).toBeGreaterThan(0);
		for (const c of checks) expect(["pass", "fail", "gap", "unchecked"]).toContain(c.severity);
	});

	it("marks exactly one accepted gap on a healthy official-route run", () => {
		const checks = healthy();
		expect(checks.filter((c) => c.severity === "gap").map((c) => c.name)).toEqual(["Request binding"]);
		expect(checks.filter((c) => c.severity === "fail")).toEqual([]);
		expect(checks.filter((c) => c.severity === "unchecked")).toEqual([]);
	});

	it("drops the gap entirely when the route can bind request bytes", () => {
		const body = 'event: response.completed\ndata: {"response":{"model":"gpt-6.1-sol"}}\n\n';
		const requestBody = '{"model":"gpt-6-luna"}';
		const proof = makeProof({
			response_body_sha256: createHash("sha256").update(body, "utf8").digest("hex"),
			request_body_sha256: createHash("sha256").update(requestBody, "utf8").digest("hex"),
		});
		const { report } = verifyExchange(
			{
				extractServedModel: GPT_ROUTE.extractServedModel,
				wireBytes: sseWithProof(proof, body),
				requestBytes: Buffer.from(requestBody, "utf8"),
				attestationVerifier: stubAttestation(),
			},
			{ ...officialPolicy(), requestBinding: "verify" },
		);
		// The signature still cannot pass under the stub, so assert the gap is gone
		// rather than that the whole run is green.
		expect(report.checks.find((c) => c.name === "Request binding")?.severity).toBe("pass");
		expect(report.checks.filter((c) => c.severity === "gap")).toEqual([]);
	});

	it("marks a blocked check as a failure, never a gap", () => {
		const { report } = verifyExchange(
			{ extractServedModel: GPT_ROUTE.extractServedModel, wireBytes: sseWithProof(makeProof({ upstream_host: "wokey.internal" })), attestationVerifier: stubAttestation() },
			officialPolicy(),
		);
		expect(report.checks.find((c) => c.name === "Upstream host")?.severity).toBe("fail");
		expect(report.status).toBe("failed");
	});

	it("marks an unverifiable-by-design route as unchecked, so it can never be an error", () => {
		const chat = getRoute("openai-chat");
		const wire = 'data: {"id":"chatcmpl-1","model":"glm-5.3-flash","choices":[]}\n\n';
		const { report } = verifyExchange(
			{ extractServedModel: chat.extractServedModel, wireBytes: Buffer.from(wire, "utf8") },
			{ expectedPcr0: resolveConfig().expectedPcr0, endpoint: chat.endpoint, requestBinding: chat.requestBinding },
		);
		expect(report.checks[0]!.severity).toBe("unchecked");
	});

	it("surfaces only real failures as error checks", () => {
		// The healthy run's single gap must never reach an error card.
		expect(errorChecks({ status: "verified-with-gaps", checks: healthy(), bytes: 1 })).toEqual([]);
		const broken = healthy().map((c) => (c.name === "Remote attestation" ? { ...c, ok: false, severity: "fail" as const } : c));
		expect(errorChecks({ status: "failed", checks: broken, bytes: 1 }).map((c) => c.name)).toEqual(["Remote attestation"]);
	});

	it("falls back to ok when a report carries no severity at all", () => {
		const legacy = { status: "failed" as const, bytes: 1, checks: [{ name: "Response signature", ok: false, detail: "boom" }] };
		expect(errorChecks(legacy as never).map((c) => c.name)).toEqual(["Response signature"]);
	});
});

describe("accepted upstream hosts", () => {
	const hostOf = (host: string) =>
		verifyExchange({ extractServedModel: GPT_ROUTE.extractServedModel, wireBytes: sseWithProof(makeProof({ upstream_host: host })), attestationVerifier: stubAttestation() }, gptPolicy())
			.report.checks.find((c) => c.name === "Upstream host");

	it("accepts only the measured route", () => {
		expect(hostOf("chatgpt.com")?.ok).toBe(true);
		expect(hostOf("api.openai.com")?.ok).toBe(false);
	});

	it("rejects look-alikes rather than matching on suffix", () => {
		expect(hostOf("evil.chatgpt.com")?.ok).toBe(false);
		expect(hostOf("chatgpt.com.evil.net")?.ok).toBe(false);
	});

	// Trust anchors are code-pinned on the route profile, not user-configurable:
	// there is no settings knob that widens the accepted host anymore. A new
	// route arrives only as a new measured route profile.
	it("pins the accepted host on the route, not in user settings", () => {
		expect(getRoute("openai-codex").endpoint!.host).toBe("chatgpt.com");
	});
});
