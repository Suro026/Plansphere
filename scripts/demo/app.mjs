/**
 * Runs the Plansphere web app against the demo emulators (never production).
 *
 * The emulator environment is passed to Next explicitly, which takes
 * precedence over .env.local, so the real Firebase project and service
 * account in that file are not used.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { demoEnv } from "./env.mjs";

const next = resolve(process.cwd(), "node_modules/next/dist/bin/next");
console.log("\n  Plansphere on http://localhost:3000 — backed by the Firebase emulators (demo-plansphere)\n");
const child = spawn(process.execPath, [next, "dev", "--turbopack"], { stdio: "inherit", env: demoEnv() });
child.on("exit", (code) => process.exit(code ?? 0));
