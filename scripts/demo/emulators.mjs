/**
 * Starts the Firebase Auth + Firestore emulators for the demo.
 *
 * Data lives in .demo-data/ (git-ignored): it is loaded on start if present and
 * saved again when you stop the emulators with Ctrl+C, so the seeded world
 * survives restarts. Delete that folder to start from nothing.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PROJECT, demoEnv } from "./env.mjs";

const dataDir = resolve(process.cwd(), ".demo-data");
const args = ["emulators:start", "--only", "auth,firestore", "--project", PROJECT];
if (existsSync(dataDir)) args.push("--import", dataDir);
args.push("--export-on-exit", dataDir);

console.log(`\n  Firebase emulators for project ${PROJECT} (no production access)\n  data: ${dataDir}${existsSync(dataDir) ? " (loading)" : " (new)"}\n`);

const child = spawn("firebase", args, { stdio: "inherit", shell: true, env: demoEnv() });
child.on("exit", (code) => process.exit(code ?? 0));
