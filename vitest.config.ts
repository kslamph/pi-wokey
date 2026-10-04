import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["**/*.test.ts"],
		// Linked worktrees hold a full checkout of the same suites; without this
		// they are collected too and every count is doubled.
		exclude: ["**/node_modules/**", "**/.worktrees/**", "**/worktrees/**"],
		testTimeout: 10_000,
	},
});
