import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["**/*.test.ts"],
		// Linked worktrees hold a full checkout of the same suites; without this
		// they are collected too and every count is doubled.
		exclude: ["**/node_modules/**", "**/.worktrees/**", "**/worktrees/**"],
		testTimeout: 10_000,
		// Pin settings to a throwaway file (see the module doc): without this,
		// the developer's own ~/.pi/agent/wokey.json leaks into lineup
		// assertions — and a test bug could rewrite the real file.
		setupFiles: ["./vitest.setup.ts"],
	},
});
