import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

const eslintConfig = [
  { ignores: [".next/**", "node_modules/**"] },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      // Prose in JSX uses typographic quotes by design; escaping every
      // apostrophe as &apos; makes copy unreadable in source for no benefit.
      "react/no-unescaped-entities": "off",
    },
  },
];

export default eslintConfig;
