#!/usr/bin/env node
// Restores the demo-app backend to a known state and ensures the demo DB has rows.
// Run only while demo-api is stopped — it overwrites the file the server is running.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const seedDir = join(repoRoot, "infra", "seed");
const backendDir = join(repoRoot, "apps", "demo-app", "backend");
const targetFile = join(backendDir, "src", "index.ts");
const dataDir = join(backendDir, "data");
const dbFile = join(dataDir, "buggyboard.db");

const pristine = process.argv.includes("--pristine");
const source = join(seedDir, pristine ? "index.ts.pristine" : "index.ts.seeded");

function fail(message) {
  console.error(`reseed: ${message}`);
  process.exit(1);
}

const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

if (!existsSync(source)) fail(`canonical copy missing: ${source}`);

copyFileSync(source, targetFile);

const expected = sha(source);
const actual = sha(targetFile);
if (expected !== actual) {
  fail(`hash mismatch after write\n  expected ${expected} (${source})\n  actual   ${actual} (${targetFile})`);
}
console.log(`reseed: ${pristine ? "pristine" : "seeded"} index.ts written, sha256 ${expected}`);

// better-sqlite3 comes from BuggyBoard's own hoisted node_modules, not our root deps.
const require = createRequire(join(repoRoot, "apps", "demo-app", "package.json"));
let Database;
try {
  Database = require("better-sqlite3");
} catch (err) {
  fail(`cannot load better-sqlite3 from apps/demo-app/node_modules — run npm install there first (${err.message})`);
}

if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
const db = new Database(dbFile);

// Schema kept byte-identical to backend/src/db.ts initBugsTable().
db.exec(`
    CREATE TABLE IF NOT EXISTS bugs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('HIGH', 'MID', 'LOW')),
      owner TEXT NOT NULL,
      description TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN', 'CLOSED'))
    )
  `);

const count = db.prepare("SELECT COUNT(*) AS n FROM bugs").get().n;
if (count === 0) {
  const insert = db.prepare(
    "INSERT INTO bugs (title, severity, owner, description, state) VALUES (?, ?, ?, ?, ?)"
  );
  const rows = [
    ["Login button unresponsive on Safari", "HIGH", "buggy", "Clicking Log In does nothing on Safari 17.", "OPEN"],
    ["Board sort ignores severity", "MID", "vanny", "Sorting by severity orders alphabetically instead of HIGH/MID/LOW.", "CLOSED"],
    ["Delete modal closes without deleting", "HIGH", "buggy", "Confirming delete dismisses the modal but the bug remains.", "OPEN"],
    ["Typo in empty-state message", "LOW", "vanny", "Empty board reads No bugz found.", "OPEN"],
    ["Edit form drops description on save", "MID", "buggy", "Saving an edit blanks the description field.", "OPEN"],
  ];
  db.transaction(() => rows.forEach((r) => insert.run(...r)))();
  console.log(`reseed: inserted ${rows.length} sample bugs`);
} else {
  console.log(`reseed: bugs table already has ${count} rows, left untouched`);
}
db.close();
