import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "data/**", "workers/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Sanitizers intentionally match control characters.
      "no-control-regex": "off",
      "no-useless-escape": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Existing code has many fire-and-forget calls; tighten to "error" once they are cleaned up.
      "@typescript-eslint/no-floating-promises": "warn",
    },
  },
);
