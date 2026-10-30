/**
 * Secret scan over every tracked file (and, with --history, every commit on
 * every ref). Exits 1 on a finding so CI blocks the merge.
 *
 *   npm run scan:secrets
 *   npm run scan:secrets -- --history
 *
 * Prints file:line and the pattern name only — never the matched value.
 */

import { execSync } from "node:child_process";
import { ENV_TEMPLATE_FILE, envTemplateProblems } from "./lib/env-template.mjs";

const PATTERNS = [
  ["Google API key", /AIza[0-9A-Za-z_-]{35}/],
  ["PEM private key", /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
  ["Service-account JSON", /"private_key_id"\s*:/],
  ["Service-account email", /[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com/],
  ["Resend key", /\bre_[0-9A-Za-z]{20,}\b/],
  ["Stripe key", /\b[sr]k_(live|test)_[0-9A-Za-z]{10,}\b/],
  ["Razorpay key", /\brzp_(live|test)_[0-9A-Za-z]{8,}\b/],
  ["GitHub token", /\b(ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{30,}\b|github_pat_[0-9A-Za-z_]{30,}/],
  ["Slack token", /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Sentry DSN", /https:\/\/[0-9a-f]{32}@[a-z0-9.]*ingest\.sentry\.io/],
  ["Upstash token", /\bA[A-Za-z0-9]{20,}[A-Za-z0-9=]{10,}\b(?=.*upstash)/i],
  ["JWT", /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/],
  ["Django secret", /django-insecure-[0-9A-Za-z!@#$%^&*(){}\[\]_+=-]{20,}/],
  ["Hardcoded credential", /\b(password|passwd|secret|token|api[_-]?key)\b\s*[:=]\s*["'][^"'\s]{12,}["']/i],
];

// Places where a match is expected and harmless.
const ALLOW = [
  /^tests\//, // fake emulator credentials
  // (An env template is NOT allowed here: it is scanned like any other file, and in a tree scan every assignment in it
  // must also be empty or a known harmless default, see scripts/lib/env-template.mjs.)
  /^scripts\/scan-secrets\.mjs$/,
  /^package-lock\.json$/,
];

const history = process.argv.includes("--history");
const run = (cmd) => execSync(cmd, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const findings = [];

const scanBlob = (label, text) => {
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    for (const [name, re] of PATTERNS) {
      if (re.test(line)) findings.push(`${label}:${i + 1}  ${name}`);
    }
  });
};

if (!history) {
  const files = run("git ls-files -z").split("\0").filter(Boolean);
  for (const file of files) {
    if (ALLOW.some((re) => re.test(file))) continue;
    let text;
    try {
      text = run(`git show :"${file}"`);
    } catch {
      continue; // binary or unreadable
    }
    if (text.includes("\0")) continue;
    scanBlob(file, text);
    if (ENV_TEMPLATE_FILE.test(file)) {
      for (const { line, name } of envTemplateProblems(text)) findings.push(`${file}:${line}  Value in an env template (${name}); templates list names only`);
    }
  }
} else {
  const commits = run("git rev-list --all").split("\n").filter(Boolean);
  const seen = new Set();
  for (const commit of commits) {
    const tree = run(`git ls-tree -r ${commit}`).split("\n").filter(Boolean);
    for (const row of tree) {
      const [meta, path] = row.split("\t");
      const blob = meta.split(" ")[2];
      if (!blob || seen.has(blob) || ALLOW.some((re) => re.test(path))) continue;
      seen.add(blob);
      if (/\.(png|jpg|jpeg|gif|ico|woff2?|ttf|pdf|pyc|lock)$/i.test(path)) continue;
      let text;
      try {
        text = run(`git cat-file -p ${blob}`);
      } catch {
        continue;
      }
      if (text.includes("\0")) continue;
      scanBlob(`${commit.slice(0, 8)}:${path}`, text);
    }
  }
}

if (findings.length) {
  console.error(`\n  ${findings.length} possible secret(s) found${history ? " in history" : ""}:\n`);
  for (const f of [...new Set(findings)]) console.error(`    ${f}`);
  console.error("\n  Move the value to an environment variable and rotate it if it was real.\n");
  process.exit(1);
}
console.log(`  No secrets found in ${history ? "any commit" : "tracked files"}.`);
