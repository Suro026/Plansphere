/**
 * Rules for a committed environment template (`.env.example`): it lists names, and holds a value only where the value
 * is a harmless default that is the same for everyone. Anything else (a real project id, a key, a URL with something
 * glued to it) is a finding. Used by scripts/scan-secrets.mjs; never returns or prints a value.
 */

/** Name -> the only non-empty value the template may carry for it. */
export const ENV_TEMPLATE_DEFAULTS = new Map([
  ["NEXT_PUBLIC_APP_URL", "http://localhost:3000"],
  ["EMAIL_PROVIDER", "console"],
  ["EMAIL_FROM", "Plansphere <noreply@plansphere.in>"],
  ["APP_CHECK_ENFORCE", "false"],
]);

/** `.env.example`, `.env.production.example`, `config/.env.sample`, ... */
export const ENV_TEMPLATE_FILE = /(^|\/)\.env(\.[A-Za-z0-9_-]+)*\.(example|sample|template)$/;

/** The value of what follows `=`: the quoted text if quoted, else the text up to a trailing ` # comment`. */
const valueOf = (rest) => {
  const quoted = /^\s*(["'])(.*)\1\s*(?:#.*)?$/.exec(rest);
  return quoted ? quoted[2] : rest.replace(/\s+#.*$/, "").trim();
};

/** @returns {{ line: number, name: string }[]} the assignments that hold a value the template is not allowed to hold. */
export const envTemplateProblems = (text) => {
  const problems = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(raw);
    if (!match) return;
    const [, name, rest] = match;
    const value = valueOf(rest);
    if (value === "") return;
    if (ENV_TEMPLATE_DEFAULTS.get(name) === value) return;
    problems.push({ line: index + 1, name });
  });
  return problems;
};
