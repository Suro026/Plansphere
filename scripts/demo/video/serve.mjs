/**
 * Serves the vertical-video title cards at http://localhost:5055/ (cards.html).
 *
 * Read-only and deliberately narrow: only the cards page and the two original
 * brand files (public/logo.png, public/icon-mark.png) are reachable.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const FILES = {
  "/": ["scripts/demo/video/cards.html", "text/html; charset=utf-8"],
  "/cards.html": ["scripts/demo/video/cards.html", "text/html; charset=utf-8"],
  "/scripts/demo/video/cards.html": ["scripts/demo/video/cards.html", "text/html; charset=utf-8"],
  "/public/logo.png": ["public/logo.png", "image/png"],
  "/public/icon-mark.png": ["public/icon-mark.png", "image/png"],
};

createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  // cards.html asks for ../../../public/logo.png, which the browser resolves to /public/logo.png.
  const entry = FILES[path];
  if (!entry) {
    response.writeHead(404).end("Not found");
    return;
  }
  try {
    response.writeHead(200, { "content-type": entry[1], "cache-control": "no-store" }).end(await readFile(resolve(root, entry[0])));
  } catch {
    response.writeHead(500).end("Could not read file");
  }
}).listen(5055, "127.0.0.1", () => console.log("\n  Title cards: http://localhost:5055/#intro   (also #what, #c03 … #c20, #closing, #index)\n"));
