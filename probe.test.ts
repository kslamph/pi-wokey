/**
 * Tests for the wokey proof probe.
 *
 * The hardware half (COSE/P-384 → AWS Nitro root) cannot be exercised without a
 * real attestation document, so those gates run against a stub verifier. What is
 * tested for real here is everything this extension is responsible for: the
 * proof-record handling, the byte-exactness of the request capture, the
 * host/path gates, and — most importantly — that the PCR0 gate cannot be
 * satisfied by the proof's own self-declared value. The byte-level delivery
 * invariants (relay keepalives, non-streaming bodies, multipart envelopes) are
 * covered by the end-to-end suite in probe.e2e.test.ts.
 */

import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DEFAULT_CONFIG, PUBLISHED_PCR0, resolveConfig, type WokeyConfig } from "./config.ts";
import { buildV2Statement, sha256 } from "./verify/signing.ts";
import { parseTeeProofEvent } from "./verify/tee-verify-core.ts";
import { stripTrailingProofEvent, verifyExchange } from "./verify/probe.ts";
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

function findCheck(checks: { name: string; ok: boolean }[], name: string) {
	return checks.find((c) => c.name === name);
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
	const config: WokeyConfig = resolveConfig();

	it("reports 'unproven' when the response carries no proof", () => {
		const { report } = verifyExchange(
			{ wireBytes: Buffer.from("event: response.completed\ndata: {}\n\n", "utf8"), attestationVerifier: stubAttestation() },
			config,
		);
		expect(report.status).toBe("unproven");
		expect(report.checks.every((c) => c.ok)).toBe(false);
	});

	it("does not let the proof's own pcr0 satisfy the PCR0 gate", () => {
		// The exact defect in wokey's browser verifier: it adopts proof.pcr0 as
		// the "audited" value, so the gate passes for any image at all.
		const roguePcr0 = "1".repeat(96);
		const proof = makeProof({ pcr0: roguePcr0 });
		const { report } = verifyExchange(
			{ wireBytes: sseWithProof(proof), attestationVerifier: stubAttestation({ pcr0: roguePcr0 }) },
			config,
		);
		expect(findCheck(report.checks, "Enclave image (PCR0)")?.ok).toBe(false);
		expect(report.status).toBe("failed");
	});

	it("flags an unset PCR0 anchor instead of reporting a pass", () => {
		const proof = makeProof();
		const { report } = verifyExchange(
			{ wireBytes: sseWithProof(proof), attestationVerifier: stubAttestation() },
			resolveConfig({ expectedPcr0: "" }),
		);
		expect(findCheck(report.checks, "Enclave image (PCR0)")?.ok).toBe(false);
		expect(report.status).toBe("failed");
	});

	it("rejects a signature key the attestation does not endorse", () => {
		const proof = makeProof({ public_key: Buffer.alloc(32, 9).toString("base64") });
		const { report } = verifyExchange(
			{ wireBytes: sseWithProof(proof), attestationVerifier: stubAttestation() },
			config,
		);
		expect(findCheck(report.checks, "Signing key binding")?.ok).toBe(false);
	});

	it("rejects a nonce that disagrees between proof and attestation", () => {
		const proof = makeProof();
		const { report } = verifyExchange(
			{ wireBytes: sseWithProof(proof), attestationVerifier: stubAttestation({ nonce: Buffer.from("other", "utf8").toString("base64") }) },
			config,
		);
		expect(findCheck(report.checks, "Nonce binding")?.ok).toBe(false);
	});

	it("rejects an unsigned upstream host", () => {
		const proof = makeProof({ upstream_host: "wokey.internal" });
		const { report } = verifyExchange(
			{ wireBytes: sseWithProof(proof), attestationVerifier: stubAttestation() },
			config,
		);
		expect(findCheck(report.checks, "Upstream host")?.ok).toBe(false);
		expect(report.status).toBe("failed");
	});

	it("rejects an unexpected upstream path even on the right host", () => {
		const proof = makeProof({ upstream_path: "/v1/cheap" });
		const { report } = verifyExchange(
			{ wireBytes: sseWithProof(proof), attestationVerifier: stubAttestation() },
			config,
		);
		expect(findCheck(report.checks, "Upstream path")?.ok).toBe(false);
	});

	// Measured against live traffic 2026-10-03: both GPT models sign chatgpt.com,
	// not api.openai.com, and wokey rewrites the body before the enclave sees it.
	// Measured against live traffic 2026-10-03: both GPT models sign chatgpt.com,
	// not api.openai.com, and wokey rewrites the body before the enclave sees it.
	it("accepts the real upstream the relay actually signs", () => {
		const proof = makeProof({ upstream_host: "chatgpt.com", upstream_path: "/backend-api/codex/responses" });
		const { report } = verifyExchange({ wireBytes: sseWithProof(proof), attestationVerifier: stubAttestation() }, config);
		expect(findCheck(report.checks, "Upstream host")?.ok).toBe(true);
		expect(findCheck(report.checks, "Upstream path")?.ok).toBe(true);
	});

	it("still rejects api.openai.com, which the GPT lane never signs", () => {
		const proof = makeProof({ upstream_host: "api.openai.com" });
		const { report } = verifyExchange({ wireBytes: sseWithProof(proof), attestationVerifier: stubAttestation() }, config);
		expect(findCheck(report.checks, "Upstream host")?.ok).toBe(false);
	});

	it("does not check request binding when the request bytes were not captured", () => {
		const proof = makeProof();
		const { report } = verifyExchange(
			{ wireBytes: sseWithProof(proof), attestationVerifier: stubAttestation() },
			config,
		);
		expect(findCheck(report.checks, "Request binding")).toBeUndefined();
	});

	it("surfaces the model the upstream reported in its own response body", () => {
		const proof = makeProof();
		const { report } = verifyExchange(
			{
				wireBytes: sseWithProof(proof, 'event: response.completed\ndata: {"response":{"model":"gpt-6.1-sol"}}\n\n'),
				attestationVerifier: stubAttestation(),
			},
			config,
		);
		expect(report.reportedModel).toBe("gpt-6.1-sol");
	});

	it("verifies a well-formed exchange end to end with a stub attestation", () => {
		const body = "event: response.completed\ndata: {}\n\n";
		const proof = makeProof({ response_body_sha256: createHash("sha256").update(body, "utf8").digest("hex") });
		const { report } = verifyExchange(
			{ wireBytes: sseWithProof(proof, body), attestationVerifier: stubAttestation() },
			config,
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

describe("config", () => {
	it("pins an audited PCR0 rather than trusting the wire", () => {
		expect(DEFAULT_CONFIG.expectedPcr0).toBe(PUBLISHED_PCR0);
		expect(DEFAULT_CONFIG.expectedPcr0).toMatch(/^[a-f0-9]{96}$/);
	});
});
describe("English-only, concise, per-case reasons", () => {
	const cfg = resolveConfig();
	const find = (checks: { name: string; ok: boolean; detail?: string }[], name: string) =>
		checks.find((c) => c.name === name);
	const text = (r: { checks: { name: string; detail: string }[] }) =>
		r.checks.map((c) => `${c.name}: ${c.detail}`).join("\n");

	it("never emits non-English text", () => {
		const proof = makeProof({ upstream_host: "wokey.internal" });
		const { report } = verifyExchange({ wireBytes: sseWithProof(proof), attestationVerifier: stubAttestation() }, cfg);
		expect(text(report)).not.toMatch(/[一-鿿]/);
	});

	it("states the actual served model and expected host on a host failure", () => {
		const proof = makeProof({ upstream_host: "wokey.internal", upstream_path: "/x" });
		const { report } = verifyExchange({ wireBytes: sseWithProof(proof), attestationVerifier: stubAttestation() }, cfg);
		expect(find(report.checks, "Upstream host")?.detail).toBe("served from wokey.internal — not the official endpoint");
	});

	it("flags model substitution and names both models", () => {
		const body = 'event: response.completed\ndata: {"response":{"model":"gpt-6-luna"}}\n\n';
		const proof = makeProof({ response_body_sha256: createHash("sha256").update(body, "utf8").digest("hex") });
		const { report } = verifyExchange(
			{ wireBytes: sseWithProof(proof, body), expectedModel: "gpt-6-astra", attestationVerifier: stubAttestation() },
			cfg,
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
			{ wireBytes: sseWithProof(proof, body), expectedModel: "gpt-6-luna", attestationVerifier: stubAttestation() },
			cfg,
		);
		expect(find(report.checks, "Served model")?.ok).toBe(true);
	});

	it("labels the known request-binding case as a documented gap, not a failure reason", () => {
		const proof = makeProof();
		// Request bytes must be captured for the check to exist at all.
		const { report } = verifyExchange(
			{ wireBytes: sseWithProof(proof), requestBytes: Buffer.from('{"model":"gpt-6-luna"}'), attestationVerifier: stubAttestation() },
			cfg,
		);
		expect(find(report.checks, "Request binding")?.ok).toBe(false);
		expect(find(report.checks, "Request binding")?.detail).toMatch(/documented gap/);
	});
});

describe("accepted upstream hosts", () => {
	const hostOf = (host: string, cfg = resolveConfig()) =>
		verifyExchange({ wireBytes: sseWithProof(makeProof({ upstream_host: host })), attestationVerifier: stubAttestation() }, cfg)
			.report.checks.find((c) => c.name === "Upstream host");

	it("accepts only the measured route by default", () => {
		expect(hostOf("chatgpt.com")?.ok).toBe(true);
		expect(hostOf("api.openai.com")?.ok).toBe(false);
	});

	it("rejects look-alikes rather than matching on suffix", () => {
		expect(hostOf("evil.chatgpt.com")?.ok).toBe(false);
		expect(hostOf("chatgpt.com.evil.net")?.ok).toBe(false);
	});

	it("accepts a second route only once it is explicitly added", () => {
		const wide = resolveConfig({ expectedHosts: ["chatgpt.com", "api.openai.com"] });
		expect(hostOf("api.openai.com", wide)?.ok).toBe(true);
		expect(hostOf("chatgpt.com", wide)?.ok).toBe(true);
		expect(hostOf("evil.chatgpt.com", wide)?.ok).toBe(false);
	});

	it("falls back to expectedHost when no list is set", () => {
		expect(hostOf("chatgpt.com", resolveConfig({ expectedHosts: [] }))?.ok).toBe(true);
	});
});
