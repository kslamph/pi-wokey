/**
 * Test-run settings isolation.
 *
 * Several suites assert the default lineup (`activeModels()`, catalog-refresh
 * results), and those read `~/.pi/agent/wokey.json` through `WOKEY_CONFIG`.
 * Without this pin, a developer's own selector choice (or any leftover file)
 * leaks into assertions — and worse, a test bug could rewrite the real file.
 * Point every worker at a throwaway path that starts absent (→ defaults);
 * individual suites override `WOKEY_CONFIG` for their own cases as before.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.WOKEY_CONFIG = join(mkdtempSync(join(tmpdir(), "wokey-test-settings-")), "wokey.json");
