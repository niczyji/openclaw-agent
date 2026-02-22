import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier, // schaltet ESLint-Regeln aus, die Prettier widersprechen
  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      // deine Preferences:
      "no-console": "off", // für CLI/Tools ok
    },
  },
];