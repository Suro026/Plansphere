import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

const eslintConfig = [
  // next-env.d.ts is written by `next dev` / `next build` (and is git-ignored), so it only exists after a build and
  // cannot be fixed in source; its triple-slash references fail the TypeScript rules.
  { ignores: [".next/**", "node_modules/**", ".demo-build/**", ".demo-data/**", "next-env.d.ts"] },
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
