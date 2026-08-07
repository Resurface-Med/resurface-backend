import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: [".next/**", "node_modules/**"] },

  js.configs.recommended,

  {
    files: ["app/**/*.{js,jsx}", "tests/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      "no-unused-vars": ["error", { varsIgnorePattern: "^[A-Z_]", argsIgnorePattern: "^_" }],
    },
  },
];
