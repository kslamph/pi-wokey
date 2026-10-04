// Regenerate the committed Anthropic fixtures in test-fixtures/.
//
//   node scripts/gen-anthropic-fixtures.mjs
//
// The SSE bodies are hand-authored, live-shaped, and fully synthetic: a fixed
// prompt placeholder stands in for any real user prompt (never commit a full
// sensitive prompt), and the thinking text / tool input are obvious filler.
// What is genuine is the proof/body hash relationship: each proof's
// response_body_sha256 is the sha256 of the exact body bytes in its .sse file,
// and the Ed25519 signature is real — verify it with the repo's own
// buildV2Statement (see the fixture round-trip tests).
//
// The embedded keypair is TEST-ONLY fixture scaffolding. It attests nothing:
// tests stub the COSE/P-384 → AWS Nitro chain (no Nitro hardware in CI) and
// derive the stub's public key / nonce / PCR0 from the fixture itself.
//
// Statement layout must match buildV2Statement in verify/signing.ts; the
// round-trip tests fail loudly if it drifts.

import { createHash, createPrivateKey, sign } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "test-fixtures");

// TEST-ONLY fixture signing key (public half also lands in the fixtures).
const PRIVATE_KEY_DER_B64 = "MC4CAQAwBQYDK2VwBCIEIHYozZsdk5mghCCuMws2shcRI9lGU80f8VkmZz1L4Yci";
const PUBLIC_KEY_SPKI_B64 = "MCowBQYDK2VwAyEAEVOywKkdc/scY4fGXEsjf5uS9TGNR76waqWpG2eI2zo=";

// Published production PCR0, copied from config.ts so the fixture pins the
// same anchor the provider verifies against.
const PCR0 = "437cbab8c2e5dd11a35ae5b062fe115623a013910b7c26b333e2b3af477944d630fb1dcd76fa9a9b1eefdf1d1021dec2";

const UPSTREAM = { host: "api.anthropic.com", path: "/v1/messages", method: "POST", status: 200 };
const CONTENT_TYPE = "text/event-stream";

const shaHex = (s) => createHash("sha256").update(s, "utf8").digest("hex");

// Mirror of buildV2Statement (verify/signing.ts). Deliberately local so the
// generator runs on plain node with no TS toolchain; drift is caught by tests.
function statement({ nonceB64, requestBodySha256Hex, responseBodySha256Hex }) {
	return Buffer.from(
		[
			"tee-exchange-v2",
			`nonce=${nonceB64}`,
			`upstream-host=${UPSTREAM.host.toLowerCase()}`,
			`upstream-path=${UPSTREAM.path}`,
			`http-method=${UPSTREAM.method.toUpperCase()}`,
			`http-status=${UPSTREAM.status}`,
			`resp-content-type=${CONTENT_TYPE}`,
			`request-body-sha256=${requestBodySha256Hex}`,
			`response-body-sha256=${responseBodySha256Hex}`,
		]
			.map((l) => `${l}\n`)
			.join(""),
		"utf8",
	);
}

function event(type, data) {
	return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

// --- fixture 1: thinking + text + tool_use, cache_creation usage --------------

const BODY_MAIN = [
	event("message_start", {
		type: "message_start",
		message: {
			id: "msg_fixture_01",
			type: "message",
			role: "assistant",
			model: "claude-opus-5-5",
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 7, cache_creation_input_tokens: 2048, cache_read_input_tokens: 0, output_tokens: 3 },
		},
	}),
	event("ping", { type: "ping" }),
	event("content_block_start", {
		type: "content_block_start",
		index: 0,
		content_block: { type: "thinking", thinking: "", signature: "sig_fixture_redacted_001" },
	}),
	event("content_block_delta", {
		type: "content_block_delta",
		index: 0,
		delta: { type: "thinking_delta", thinking: "Fixture thinking: the clock question needs the time tool." },
	}),
	event("content_block_delta", {
		type: "content_block_delta",
		index: 0,
		delta: { type: "signature_delta", signature: "sig_fixture_redacted_002" },
	}),
	event("content_block_stop", { type: "content_block_stop", index: 0 }),
	event("content_block_start", {
		type: "content_block_start",
		index: 1,
		content_block: { type: "text", text: "" },
	}),
	event("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "The fixture clock says noon." } }),
	event("content_block_stop", { type: "content_block_stop", index: 1 }),
	event("content_block_start", {
		type: "content_block_start",
		index: 2,
		content_block: { type: "tool_use", id: "toolu_fixture_01", name: "get_time", input: {} },
	}),
	event("content_block_delta", {
		type: "content_block_delta",
		index: 2,
		delta: { type: "input_json_delta", partial_json: '{"timezone": "UTC"}' },
	}),
	event("content_block_stop", { type: "content_block_stop", index: 2 }),
	event("message_delta", {
		type: "message_delta",
		delta: { stop_reason: "tool_use", stop_sequence: null },
		usage: { output_tokens: 47 },
	}),
	event("message_stop", { type: "message_stop" }),
].join("");

const REQUEST_MAIN = JSON.stringify({
	model: "claude-opus-5-5",
	max_tokens: 1024,
	messages: "[fixture prompt redacted]",
	stream: true,
});

// --- fixture 2: text-only repeat, cache_read usage ------------------------------

const BODY_CACHE_READ = [
	event("message_start", {
		type: "message_start",
		message: {
			id: "msg_fixture_02",
			type: "message",
			role: "assistant",
			model: "claude-opus-5-5",
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 2048, output_tokens: 2 },
		},
	}),
	event("ping", { type: "ping" }),
	event("content_block_start", {
		type: "content_block_start",
		index: 0,
		content_block: { type: "text", text: "" },
	}),
	event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Still noon." } }),
	event("content_block_stop", { type: "content_block_stop", index: 0 }),
	event("message_delta", {
		type: "message_delta",
		delta: { stop_reason: "end_turn", stop_sequence: null },
		usage: { output_tokens: 12 },
	}),
	event("message_stop", { type: "message_stop" }),
].join("");

const REQUEST_CACHE_READ = JSON.stringify({
	model: "claude-opus-5-5",
	max_tokens: 1024,
	messages: "[fixture prompt redacted — identical repeat for cache read]",
	stream: true,
});

function buildFixture(name, body, requestBody, nonceLabel) {
	const nonceB64 = Buffer.from(nonceLabel, "utf8").toString("base64");
	const requestSha = shaHex(requestBody);
	const responseSha = shaHex(body);
	const privateKey = createPrivateKey({ key: Buffer.from(PRIVATE_KEY_DER_B64, "base64"), format: "der", type: "pkcs8" });
	const signature = sign(null, statement({ nonceB64, requestBodySha256Hex: requestSha, responseBodySha256Hex: responseSha }), privateKey).toString("base64");
	const proof = {
		v: 2,
		alg: "ed25519",
		public_key: PUBLIC_KEY_SPKI_B64,
		nonce: nonceB64,
		upstream_host: UPSTREAM.host,
		upstream_path: UPSTREAM.path,
		http_method: UPSTREAM.method,
		http_status: UPSTREAM.status,
		resp_content_type: CONTENT_TYPE,
		request_body_sha256: requestSha,
		response_body_sha256: responseSha,
		signature,
		attestation: "fixture-test-only",
		pcr0: PCR0,
	};
	const wire = `${body}event: tee.proof\ndata: ${JSON.stringify(proof)}\n\n`;
	const doc = {
		_comment:
			"Live-shaped Anthropic fixture for claude-opus-5-5. Synthetic body, sanitized prompt placeholder, TEST-ONLY signature (see scripts/gen-anthropic-fixtures.mjs). response_body_sha256 matches the .sse body bytes exactly.",
		proof,
		sanitized_request_body: requestBody,
	};
	writeFileSync(join(ROOT, `${name}.sse`), wire);
	writeFileSync(join(ROOT, `${name}-proof.json`), `${JSON.stringify(doc, null, 2)}\n`);
	console.log(`wrote ${name}.sse (${Buffer.byteLength(wire)} bytes) + ${name}-proof.json`);
}

buildFixture("anthropic-opus-5-5", BODY_MAIN, REQUEST_MAIN, "anthropic-fixture-01");
buildFixture("anthropic-opus-5-5-cache-read", BODY_CACHE_READ, REQUEST_CACHE_READ, "anthropic-fixture-02");
