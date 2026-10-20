#!/usr/bin/env node

/**
 * We Build for Good: Safe Deploy pipeline (wb4g-pipeline)
 *
 * Runs the pre-release checks in order and stops at the first hard failure:
 * - Stage 0: Prior-art brief check (only when RESEARCH-BRIEF.md exists or is required)
 * - Gate 1: System invariants (runs the invariant engine if it is installed)
 * - Gate 2: Visual audit (runs the visual audit tool if it is installed)
 * - Gate 3: Backup and migration safety (built in, always available)
 * - Gate 4: Release packaging (runs the broadcast tool if it is installed)
 * - Gate 5: Release fingerprint (a reproducible hash CI can re-check with --expect-digest)
 *
 * Honesty rule: a gate whose tool is not installed reports NOT_RUN, never PASSED.
 * A tool that runs and fails is a failure; it is never replaced by a weaker fallback.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Sibling tools are found when the catalogue is cloned side by side, or on PATH.
const SKILLS_BASE = path.resolve(__dirname, "../../");

function resolveTool(toolName, relativeSubpath) {
  const localSibling = path.join(SKILLS_BASE, relativeSubpath);
  if (fs.existsSync(localSibling)) {
    return { type: "node", path: localSibling };
  }
  return { type: "bin", command: toolName };
}

const TOOLS = {
  priorArt: resolveTool("wb4g-prior-art", "skill-does-this-exist/bin/does-this-exist.mjs"),
  invariants: resolveTool("wb4g-invariants", "skill-system-invariant-engine/bin/invariant-check.mjs"),
  visualAudit: resolveTool("wb4g-visual-audit", "skill-visual-sensory-audit/bin/visual-audit.mjs"),
  broadcast: resolveTool("wb4g-broadcast", "skill-ship-to-broadcast/bin/ship-broadcast.mjs")
};

/**
 * Minimal brief check used when the prior-art tool is not installed.
 * Accepts the tool's own format ("Verdict: **BUILD**") or a "## Verdict" section. Returns an error message or null.
 */
export function fallbackBriefCheck(content) {
  if (/TODO:/.test(content)) return "RESEARCH-BRIEF.md still has TODO lines.";
  const inline = /Verdict:\s*\*\*(ADOPT|FORK-AND-EXTEND|BUILD)\*\*/i.test(content);
  const section = /^##\s*Verdict\b[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/im.exec(content);
  if (inline || (section && /\b(ADOPT|FORK-AND-EXTEND|BUILD)\b/.test(section[0]))) return null;
  return "RESEARCH-BRIEF.md has no verdict (Verdict: **ADOPT|FORK-AND-EXTEND|BUILD** or a '## Verdict' section).";
}

/**
 * Runs a tool. Distinguishes "not installed" (available: false) from "ran and failed".
 */
export function runTool(toolConfig, args, cwd) {
  const file = toolConfig.type === "node" ? process.execPath : toolConfig.command;
  const fileArgs = toolConfig.type === "node" ? [toolConfig.path, ...args] : args;
  try {
    const output = execFileSync(file, fileArgs, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return { available: true, success: true, exitCode: 0, output };
  } catch (err) {
    if (err.code === "ENOENT") {
      return { available: false, success: false, exitCode: null, output: "", error: `${file} is not installed` };
    }
    return {
      available: true,
      success: false,
      exitCode: typeof err.status === "number" ? err.status : 1,
      output: err.stdout ? err.stdout.toString() : "",
      error: err.stderr ? err.stderr.toString() : err.message
    };
  }
}

// ---------------------------------------------------------------------------
// Rule 1: Backup verification
// ---------------------------------------------------------------------------

const DUMP_COMPLETE_MARKERS = [
  { format: "postgres-plain", pattern: /PostgreSQL database dump complete/ },
  { format: "mysqldump", pattern: /-- Dump completed/ },
  { format: "sqlite-dump", pattern: /COMMIT;\s*$/ }
];

// Runs in a child process so multi-gigabyte backups are streamed, never loaded into memory.
const BACKUP_SCAN_SCRIPT = `
const fs = require("node:fs");
const zlib = require("node:zlib");
const file = process.argv[1];
const fd = fs.openSync(file, "r");
const magic = Buffer.alloc(2);
fs.readSync(fd, magic, 0, 2, 0);
fs.closeSync(fd);
const gzipped = magic[0] === 0x1f && magic[1] === 0x8b;
let stream = fs.createReadStream(file);
if (gzipped) stream = stream.pipe(zlib.createGunzip());
let head = Buffer.alloc(0);
let tail = Buffer.alloc(0);
let bytes = 0;
stream.on("data", (chunk) => {
  bytes += chunk.length;
  if (head.length < 64) head = Buffer.concat([head, chunk]).subarray(0, 64);
  tail = Buffer.concat([tail, chunk]);
  if (tail.length > 4096) tail = tail.subarray(tail.length - 4096);
});
stream.on("error", (e) => {
  process.stdout.write(JSON.stringify({ ok: false, gzipped, error: e.message }));
});
stream.on("end", () => {
  process.stdout.write(JSON.stringify({
    ok: true, gzipped, bytes,
    head: head.toString("latin1"),
    tail: tail.toString("utf8")
  }));
});
`;

function scanBackup(backupPath) {
  try {
    const out = execFileSync(process.execPath, ["-e", BACKUP_SCAN_SCRIPT, backupPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024
    });
    return JSON.parse(out);
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function pgRestoreList(backupPath) {
  try {
    execFileSync("pg_restore", ["--list", backupPath], { stdio: ["ignore", "ignore", "pipe"] });
    return { available: true, ok: true };
  } catch (err) {
    if (err.code === "ENOENT") return { available: false, ok: false };
    return { available: true, ok: false, error: err.stderr ? err.stderr.toString() : err.message };
  }
}

/**
 * Verifies a backup file. Returns { valid, size, format, assurance, reason }.
 * assurance is FULL (the whole archive was read and ends cleanly) or HEADER_ONLY
 * (format recognised but completeness could not be proven on this machine).
 */
export function verifyBackup(backupPath, options = {}) {
  const minBytes = options.minBytes ?? 1024;
  const maxAgeHours = options.maxAgeHours ?? 24;

  if (!backupPath || !fs.existsSync(backupPath)) {
    return { valid: false, reason: "Backup file does not exist or the path is not readable." };
  }

  const stat = fs.statSync(backupPath);
  if (!stat.isFile()) {
    return { valid: false, reason: "Backup path is not a file." };
  }
  if (stat.size === 0) {
    return { valid: false, size: 0, reason: "Backup file is empty (0 bytes): the dump failed or captured an empty database." };
  }
  if (stat.size < minBytes) {
    return {
      valid: false,
      size: stat.size,
      reason: `Backup file size (${stat.size} bytes) is below minimum threshold (${minBytes} bytes).`
    };
  }

  const ageHours = (Date.now() - stat.mtimeMs) / 3_600_000;
  if (maxAgeHours > 0 && ageHours > maxAgeHours) {
    return {
      valid: false,
      size: stat.size,
      reason: `Backup is ${ageHours.toFixed(1)} hours old (limit ${maxAgeHours}h). Take a fresh backup, or raise --backup-max-age-hours.`
    };
  }

  const scan = scanBackup(backupPath);
  if (!scan.ok) {
    return {
      valid: false,
      size: stat.size,
      reason: scan.gzipped
        ? `Corrupted or truncated gzip backup: ${scan.error}`
        : `Could not read backup: ${scan.error}`
    };
  }

  if (backupPath.toLowerCase().endsWith(".gz") && !scan.gzipped) {
    return { valid: false, size: stat.size, reason: "File is named .gz but is not a gzip archive (invalid magic bytes)." };
  }

  // Postgres custom format (pg_dump -Fc): only pg_restore can prove it is complete.
  if (scan.head.startsWith("PGDMP")) {
    if (scan.gzipped) {
      return { valid: false, size: stat.size, reason: "Gzipped pg_dump custom-format archive: decompress it first so pg_restore can check it." };
    }
    const listed = pgRestoreList(backupPath);
    if (listed.available && !listed.ok) {
      return { valid: false, size: stat.size, format: "postgres-custom", reason: `pg_restore --list rejected the archive: ${listed.error}` };
    }
    if (listed.available) {
      return { valid: true, size: stat.size, format: "postgres-custom", assurance: "FULL", reason: "pg_restore --list read the whole archive table of contents." };
    }
    return {
      valid: true,
      size: stat.size,
      format: "postgres-custom",
      assurance: "HEADER_ONLY",
      reason: "pg_dump custom-format header found, but pg_restore is not installed so completeness was not proven."
    };
  }

  for (const marker of DUMP_COMPLETE_MARKERS) {
    if (marker.pattern.test(scan.tail)) {
      return {
        valid: true,
        size: stat.size,
        format: marker.format,
        assurance: "FULL",
        reason: `Backup verified: read end to end${scan.gzipped ? " (gzip decompressed)" : ""} and ends with the ${marker.format} completion marker.`
      };
    }
  }

  return {
    valid: false,
    size: stat.size,
    reason: "Backup has no recognised completion marker at the end (pg_dump, mysqldump, or sqlite .dump). It may be truncated, or in a format this tool cannot check."
  };
}

// ---------------------------------------------------------------------------
// Rule 2: SQL tokenizer and migration risk classifier
// ---------------------------------------------------------------------------

function readDollarTag(text, i) {
  const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 64));
  return m ? m[0] : null;
}

/**
 * Splits SQL into statements on semicolons outside quotes, comments, and
 * Postgres dollar-quoted bodies ($$ ... $$ or $tag$ ... $tag$).
 */
export function splitSqlStatements(sqlText) {
  const statements = [];
  let current = "";
  let quote = null; // "'", '"', or "`"

  for (let i = 0; i < sqlText.length; i++) {
    const ch = sqlText[i];
    const next = sqlText[i + 1] || "";

    if (quote) {
      current += ch;
      if (ch === quote) {
        if (next === quote) {
          current += next;
          i++;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (ch === "-" && next === "-") {
      const end = sqlText.indexOf("\n", i);
      i = end === -1 ? sqlText.length : end;
      current += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = sqlText.indexOf("*/", i + 2);
      i = end === -1 ? sqlText.length : end + 1;
      current += " ";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "$") {
      const tag = readDollarTag(sqlText, i);
      if (tag) {
        const close = sqlText.indexOf(tag, i + tag.length);
        const end = close === -1 ? sqlText.length : close + tag.length;
        current += sqlText.slice(i, end);
        i = end - 1;
        continue;
      }
    }
    if (ch === ";") {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = "";
      continue;
    }
    current += ch;
  }

  const finalTrimmed = current.trim();
  if (finalTrimmed) statements.push(finalTrimmed);
  return statements;
}

/** Replaces string literals and dollar-quoted bodies with empty placeholders. */
function stripLiterals(stmt) {
  let out = "";
  for (let i = 0; i < stmt.length; i++) {
    const ch = stmt[i];
    if (ch === "'") {
      let j = i + 1;
      while (j < stmt.length) {
        if (stmt[j] === "'" && stmt[j + 1] === "'") j += 2;
        else if (stmt[j] === "'") break;
        else j++;
      }
      out += "''";
      i = j;
      continue;
    }
    if (ch === "$") {
      const tag = readDollarTag(stmt, i);
      if (tag) {
        const close = stmt.indexOf(tag, i + tag.length);
        out += "$$ $$";
        i = close === -1 ? stmt.length : close + tag.length - 1;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

function dollarBodies(stmt) {
  const bodies = [];
  for (let i = 0; i < stmt.length; i++) {
    if (stmt[i] !== "$") continue;
    const tag = readDollarTag(stmt, i);
    if (!tag) continue;
    const close = stmt.indexOf(tag, i + tag.length);
    if (close === -1) break;
    bodies.push(stmt.slice(i + tag.length, close));
    i = close + tag.length - 1;
  }
  return bodies;
}

/** Splits on commas that are not inside parentheses. */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

const IDENT = String.raw`(?:"[^"]+"|[\w]+)(?:\.(?:"[^"]+"|[\w]+))?`;
const ALTER_TABLE_RE = new RegExp(String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${IDENT}\s+([\s\S]+)$`, "i");
const ADD_COLUMN_RE = new RegExp(String.raw`^ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?${IDENT}\s+([\s\S]+)$`, "i");
const CONSTANT_DEFAULT_RE = /\bDEFAULT\s+(?:-?\d+(?:\.\d+)?|''(?:::[\w\s]+)?|TRUE|FALSE|NULL)(?:\s+NULL)?\s*$/i;

export const SEVERITY_ORDER = ["SAFE_ADDITIVE", "RISKY_ADDITIVE", "REVIEW_REQUIRED", "DATA_MUTATION_RISK", "DESTRUCTIVE"];

const CATEGORY_LABEL = {
  RISKY_ADDITIVE: "risky",
  REVIEW_REQUIRED: "unclassified",
  DATA_MUTATION_RISK: "dataMutation",
  DESTRUCTIVE: "destructive"
};

function classifyAlterAction(action) {
  const a = action.trim();
  if (/^DROP\b/i.test(a)) {
    return { category: "DESTRUCTIVE", message: "ALTER TABLE ... DROP detected (column or constraint removal)." };
  }
  if (/^ALTER\s+(?:COLUMN\s+)?\S+\s+(?:SET\s+DATA\s+)?TYPE\b/i.test(a)) {
    return { category: "DESTRUCTIVE", message: "Column type change detected (table rewrite, possible data loss)." };
  }
  if (/^ALTER\s+(?:COLUMN\s+)?\S+\s+SET\s+NOT\s+NULL\b/i.test(a)) {
    return { category: "DESTRUCTIVE", message: "SET NOT NULL detected (fails if nulls exist; locks the table while scanning)." };
  }
  if (/^ALTER\s+(?:COLUMN\s+)?\S+\s+(?:SET\s+DEFAULT|DROP\s+DEFAULT|DROP\s+NOT\s+NULL)\b/i.test(a)) {
    return { category: "SAFE_ADDITIVE" };
  }
  if (/^VALIDATE\s+CONSTRAINT\b/i.test(a)) {
    return { category: "SAFE_ADDITIVE" };
  }
  if (/^ADD\s+(?:CONSTRAINT\s+\S+\s+)?(?:FOREIGN\s+KEY|CHECK)\b/i.test(a)) {
    if (/\bNOT\s+VALID\b/i.test(a)) return { category: "SAFE_ADDITIVE" };
    return { category: "RISKY_ADDITIVE", message: "ADD FOREIGN KEY / CHECK without NOT VALID detected (scans the whole table under lock)." };
  }
  const col = ADD_COLUMN_RE.exec(a);
  if (col && !/^ADD\s+CONSTRAINT\b/i.test(a)) {
    const rest = col[1];
    if (/\bNOT\s+NULL\b/i.test(rest) && !/\bDEFAULT\b/i.test(rest)) {
      return { category: "RISKY_ADDITIVE", message: "ADD COLUMN NOT NULL without a default detected (fails on any table that already has rows)." };
    }
    if (/\bDEFAULT\b/i.test(rest) && !CONSTANT_DEFAULT_RE.test(rest.replace(/\s+NOT\s+NULL\b/i, ""))) {
      return { category: "RISKY_ADDITIVE", message: "ADD COLUMN with a computed default detected (volatile defaults rewrite the whole table under lock)." };
    }
    if (/\b(REFERENCES|PRIMARY\s+KEY|UNIQUE|CHECK|GENERATED|CONSTRAINT)\b/i.test(rest)) {
      return { category: "RISKY_ADDITIVE", message: "ADD COLUMN with an inline constraint detected (builds an index or scans the table under lock)." };
    }
    return { category: "SAFE_ADDITIVE" };
  }
  return { category: "REVIEW_REQUIRED", message: `Unrecognised ALTER TABLE action: "${a.slice(0, 60)}".` };
}

const STATEMENT_RULES = [
  { category: "DESTRUCTIVE", pattern: /^DROP\b/i, message: "DROP statement detected (irreversible removal)." },
  { category: "DESTRUCTIVE", pattern: /\bDROP\s+(?:TABLE|COLUMN|SCHEMA|DATABASE)\b/i, message: "DROP statement detected (irreversible removal)." },
  { category: "DESTRUCTIVE", pattern: /\bTRUNCATE\b/i, message: "TRUNCATE detected (erases every row)." },
  { category: "DESTRUCTIVE", pattern: /\bDELETE\s+FROM\b/i, message: "DELETE detected (data deletion)." },
  { category: "DATA_MUTATION_RISK", pattern: new RegExp(String.raw`\bUPDATE\s+(?:ONLY\s+)?${IDENT}(?:\s+(?:AS\s+)?\w+)?\s+SET\b`, "i"), message: "UPDATE detected (data change; check batching and locks)." },
  { category: "DATA_MUTATION_RISK", pattern: /\bINSERT\s+INTO\b/i, message: "INSERT detected (data change or backfill)." },
  { category: "DATA_MUTATION_RISK", pattern: /^(?:MERGE|COPY)\b/i, message: "MERGE / COPY detected (bulk data change)." },
  { category: "RISKY_ADDITIVE", pattern: /^CREATE\s+(?:UNIQUE\s+)?INDEX\b(?!\s+CONCURRENTLY\b)/i, message: "CREATE INDEX without CONCURRENTLY detected (blocks writes to the table while it builds)." },
  { category: "SAFE_ADDITIVE", pattern: /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i },
  { category: "SAFE_ADDITIVE", pattern: /^CREATE\s+TABLE\b/i },
  { category: "SAFE_ADDITIVE", pattern: /^CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\b/i },
  { category: "SAFE_ADDITIVE", pattern: /^CREATE\s+(?:SCHEMA|SEQUENCE|TYPE)\b/i },
  { category: "SAFE_ADDITIVE", pattern: /^COMMENT\s+ON\b/i },
  { category: "SAFE_ADDITIVE", pattern: /^(?:BEGIN|COMMIT|END|START\s+TRANSACTION|ROLLBACK)\b/i },
  { category: "SAFE_ADDITIVE", pattern: /^SET\s+(?:LOCAL\s+|SESSION\s+)?[\w.]+\s*(?:=|TO)\b/i }
];

function classifyStatement(stmt) {
  const structure = stripLiterals(stmt).trim();

  // DO blocks run immediately: classify what is inside them too.
  if (/^DO\b/i.test(structure)) {
    const inner = dollarBodies(stmt).flatMap((body) => classifyStatements(splitSqlStatements(body)));
    return [
      ...inner,
      { category: "REVIEW_REQUIRED", message: "DO block detected (procedural code runs during the migration)." }
    ];
  }

  const alter = ALTER_TABLE_RE.exec(structure);
  if (alter) {
    return splitTopLevel(alter[1]).map(classifyAlterAction);
  }

  for (const rule of STATEMENT_RULES) {
    if (rule.pattern.test(structure)) {
      return [{ category: rule.category, message: rule.message }];
    }
  }
  return [{
    category: "REVIEW_REQUIRED",
    message: `Unrecognised SQL statement: "${stmt.slice(0, 60)}". Fail-closed: needs review.`
  }];
}

function classifyStatements(statements) {
  return statements.flatMap(classifyStatement);
}

/**
 * Classifies migration SQL. Every risk category present is reported in
 * `categories`, so an approval for one category never covers another.
 */
export function analyzeMigrationSql(sqlText) {
  const statements = splitSqlStatements(sqlText);
  if (statements.length === 0) {
    return { classification: "NO_MIGRATIONS", categories: [], canAutoDeploy: true, requiresGovernedApproval: false, issues: [] };
  }

  const results = classifyStatements(statements);
  const present = new Set(results.map((r) => r.category));
  present.delete("SAFE_ADDITIVE");
  const categories = SEVERITY_ORDER.filter((c) => present.has(c));
  const classification = categories.length ? categories[categories.length - 1] : "SAFE_ADDITIVE";

  return {
    classification,
    categories,
    canAutoDeploy: categories.length === 0,
    requiresGovernedApproval: present.has("DESTRUCTIVE"),
    issues: results.filter((r) => r.message).map((r) => r.message)
  };
}

function walkSqlFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walkSqlFiles(full));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".sql")) found.push(full);
  }
  return found;
}

/** Lists SQL files changed since a git ref, including uncommitted and untracked files. */
export function changedFilesSince(repoDir, ref) {
  const changed = execFileSync("git", ["diff", "--name-only", "--diff-filter=ACMR", ref, "--"], {
    cwd: repoDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
    cwd: repoDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: repoDir, encoding: "utf8" }).trim();
  return new Set(
    [...changed.split("\n"), ...untracked.split("\n").map((f) => path.relative(top, path.join(repoDir, f)))]
      .map((f) => f.trim())
      .filter(Boolean)
      .map((f) => path.resolve(top, f))
  );
}

/**
 * Inspects one SQL file or a directory tree of SQL files.
 * options.onlyFiles: a Set of absolute paths; when given, only those files are analysed.
 */
export function inspectMigrationDirectory(target, options = {}) {
  const empty = {
    hasMigrations: false,
    filesCount: 0,
    files: [],
    classification: "NO_MIGRATIONS",
    categories: [],
    canAutoDeploy: true,
    requiresGovernedApproval: false,
    issues: [],
    filesDigest: ""
  };
  if (!fs.existsSync(target)) return empty;

  let sqlFiles = fs.statSync(target).isFile() ? [path.resolve(target)] : walkSqlFiles(target);
  if (options.onlyFiles) sqlFiles = sqlFiles.filter((f) => options.onlyFiles.has(path.resolve(f)));
  sqlFiles.sort();
  if (sqlFiles.length === 0) return empty;

  const base = fs.statSync(target).isFile() ? path.dirname(target) : target;
  const present = new Set();
  const allIssues = [];
  const hasher = crypto.createHash("sha256");

  for (const file of sqlFiles) {
    const rel = path.relative(base, file) || path.basename(file);
    const content = fs.readFileSync(file, "utf8");
    hasher.update(`${rel}\0${content}\0`);
    const analysis = analyzeMigrationSql(content);
    analysis.categories.forEach((c) => present.add(c));
    analysis.issues.forEach((issue) => allIssues.push(`${rel}: ${issue}`));
  }

  const categories = SEVERITY_ORDER.filter((c) => present.has(c));
  return {
    hasMigrations: true,
    filesCount: sqlFiles.length,
    files: sqlFiles.map((f) => path.relative(base, f) || path.basename(f)),
    classification: categories.length ? categories[categories.length - 1] : "SAFE_ADDITIVE",
    categories,
    canAutoDeploy: categories.length === 0,
    requiresGovernedApproval: present.has("DESTRUCTIVE"),
    issues: allIssues,
    filesDigest: hasher.digest("hex")
  };
}

// ---------------------------------------------------------------------------
// Rule 5: Release fingerprint
// ---------------------------------------------------------------------------

function gitState(dir) {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const porcelain = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const diff = execFileSync("git", ["diff", "HEAD"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 });
    const dirty = porcelain.trim().length > 0;
    return {
      sha,
      dirty,
      workingTreeHash: dirty ? crypto.createHash("sha256").update(porcelain + "\0" + diff).digest("hex") : "clean"
    };
  } catch {
    return { sha: "not-a-git-repository", dirty: true, workingTreeHash: "unknown" };
  }
}

/**
 * Reproducible fingerprint of what was checked: commit, working-tree changes,
 * migration file contents, and each gate's status. It contains no timestamp,
 * so CI can re-run the pipeline with --expect-digest and confirm it is
 * deploying exactly what was verified.
 */
export function generateIntegrityDigest(scorecard, migrationDigest = "", gitCommitSha = "", workingTreeHash = "") {
  const statuses = Object.fromEntries(
    Object.entries(scorecard.stages || {}).map(([key, stage]) => [key, stage.status])
  );
  const normalized = JSON.stringify({ gitCommitSha, workingTreeHash, migrationDigest, statuses });
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`
We Build for Good: Safe Deploy pipeline (wb4g-pipeline)

Runs the pre-release checks and stops at the first hard failure.
It never deploys anything: a human runs the irreversible steps.

Usage:
  wb4g-pipeline [options]
  node bin/safe-deploy.mjs [options]

Options:
  --dir <path>                      Repository root (default: current directory)
  --version <tag>                   Release version tag passed to the packaging tool
  --require-prior-art               Fail if RESEARCH-BRIEF.md is missing
  --sql <file-or-dir>               SQL migration file or folder (searched recursively). Fails if the path does not exist.
  --since <git-ref>                 Only check migration files changed since this ref (e.g. your last release tag)
  --backup <file>                   Backup file to verify (.sql, .sql.gz, pg_dump -Fc)
  --backup-max-age-hours <n>        Reject backups older than this (default 24; 0 disables)
  --no-backup-required              Waive the backup (only allowed when no migration is destructive)
  --allow-risky-migrations          Approve lock-heavy additive SQL (e.g. CREATE INDEX without CONCURRENTLY)
  --approve-risk <note>             Same as above, with a recorded reason
  --approve-data-mutation <note>    Approve UPDATE / INSERT / MERGE / COPY
  --approve-unclassified-sql <note> Approve SQL the classifier does not recognise
  --allow-destructive               Approve DROP / TRUNCATE / DELETE / type changes. Requires a FULL-assurance
                                    --backup and --restore-rehearsed.
  --restore-rehearsed <note>        Your record of restoring this backup into a throwaway database
  --skip-visual                     Skip the visual audit (backend-only repos)
  --html <file>                     HTML file for the visual audit
  --url <address>                   URL for the visual audit
  --update-changelog                Ask the packaging tool to update CHANGELOG.md
  --strict                          Fail when any gate's tool is not installed (NOT_RUN) or used a fallback
  --expect-digest <sha256>          Fail unless the release fingerprint matches (use in CI)
  --json                            Print the scorecard as JSON (on success and on failure)
  --help, -h                        Show this help
`);
}

const VALUE_FLAGS = {
  "--dir": "dir",
  "--version": "version",
  "--sql": "sql",
  "--since": "since",
  "--backup": "backup",
  "--backup-max-age-hours": "backupMaxAgeHours",
  "--approve-risk": "approveRisk",
  "--approve-data-mutation": "approveDataMutation",
  "--approve-unclassified-sql": "approveUnclassifiedSql",
  "--restore-rehearsed": "restoreRehearsed",
  "--html": "html",
  "--url": "url",
  "--expect-digest": "expectDigest"
};

const BOOLEAN_FLAGS = {
  "--require-prior-art": "requirePriorArt",
  "--allow-risky-migrations": "allowRiskyMigrations",
  "--allow-destructive": "allowDestructive",
  "--no-backup-required": "noBackupRequired",
  "--skip-visual": "skipVisual",
  "--update-changelog": "updateChangelog",
  "--strict": "strict",
  "--json": "json",
  "--help": "help",
  "-h": "help"
};

const DEFAULT_OPTIONS = {
  dir: process.cwd(),
  version: "",
  requirePriorArt: false,
  sql: "",
  since: "",
  backup: "",
  backupMaxAgeHours: 24,
  allowRiskyMigrations: false,
  approveRisk: "",
  approveDataMutation: "",
  approveUnclassifiedSql: "",
  allowDestructive: false,
  restoreRehearsed: "",
  noBackupRequired: false,
  skipVisual: false,
  html: "",
  url: "",
  updateChangelog: false,
  strict: false,
  expectDigest: "",
  json: false,
  help: false
};

/** Parses CLI flags. Unknown flags and missing values are collected in options.errors. */
export function parseArgs(args) {
  const options = { ...DEFAULT_OPTIONS, dir: process.cwd(), errors: [] };

  for (let i = 0; i < args.length; i++) {
    let arg = args[i];
    let inlineValue;
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq !== -1) {
      inlineValue = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }

    if (BOOLEAN_FLAGS[arg]) {
      if (inlineValue !== undefined) options.errors.push(`${arg} does not take a value.`);
      options[BOOLEAN_FLAGS[arg]] = true;
    } else if (VALUE_FLAGS[arg]) {
      let value = inlineValue;
      if (value === undefined) {
        if (i + 1 >= args.length || args[i + 1].startsWith("--")) {
          options.errors.push(`${arg} needs a value.`);
          continue;
        }
        value = args[++i];
      }
      if (value === "") {
        options.errors.push(`${arg} needs a non-empty value.`);
        continue;
      }
      options[VALUE_FLAGS[arg]] = value;
    } else {
      options.errors.push(`Unknown option: ${args[i]}`);
    }
  }

  options.dir = path.resolve(process.cwd(), options.dir);
  if (options.sql) options.sql = path.resolve(process.cwd(), options.sql);
  if (options.backup) options.backup = path.resolve(process.cwd(), options.backup);
  if (options.approveRisk) options.allowRiskyMigrations = true;
  const hours = Number(options.backupMaxAgeHours);
  if (!Number.isFinite(hours) || hours < 0) {
    options.errors.push("--backup-max-age-hours must be a number of hours (0 disables the check).");
  } else {
    options.backupMaxAgeHours = hours;
  }
  return options;
}

const AUTO_MIGRATION_DIRS = ["migrations", "db/migrations", "supabase/migrations", "prisma/migrations", "drizzle", "src/db/migrations"];

export function runPipeline(rawOptions) {
  const options = { ...DEFAULT_OPTIONS, ...rawOptions };
  if (options.approveRisk) options.allowRiskyMigrations = true;
  const targetDir = path.resolve(options.dir);
  const log = (msg) => { if (!options.json) console.log(msg); };
  const logError = (msg) => { if (!options.json) console.error(msg); };

  const scorecard = {
    targetDir,
    timestamp: new Date().toISOString(),
    overallSuccess: false,
    result: "FAILED",
    failedStage: null,
    gaps: [],
    integrityDigest: "",
    stages: {
      priorArt: { name: "Prior-art brief (Stage 0)", status: "SKIPPED", details: "" },
      invariants: { name: "System invariants (Gate 1)", status: "PENDING", details: "" },
      visualAudit: { name: "Visual audit (Gate 2)", status: "PENDING", details: "" },
      migrations: { name: "Backup and migration safety (Gate 3)", status: "SKIPPED", details: "" },
      broadcast: { name: "Release packaging (Gate 4)", status: "PENDING", details: "" },
      humanGate: { name: "Human sign-off (Gate 5)", status: "STAGED", details: "Nothing was deployed. A human runs the irreversible steps." }
    },
    approvals: {}
  };

  const finish = (success, failedStage = null) => {
    scorecard.overallSuccess = success;
    scorecard.failedStage = failedStage;
    if (options.json) console.log(JSON.stringify(scorecard, null, 2));
    return { success, scorecard };
  };
  const fail = (stageKey, status, details, consoleLines = []) => {
    scorecard.stages[stageKey].status = status;
    scorecard.stages[stageKey].details = details;
    logError(`[${scorecard.stages[stageKey].name}] ${status}: ${details}`);
    consoleLines.forEach((line) => logError(`  - ${line}`));
    return finish(false, stageKey);
  };
  const notRun = (stageKey, details) => {
    scorecard.stages[stageKey].status = "NOT_RUN";
    scorecard.stages[stageKey].details = details;
    scorecard.gaps.push(`${scorecard.stages[stageKey].name}: ${details}`);
    log(`[${scorecard.stages[stageKey].name}] NOT_RUN (${details})`);
  };

  log("===========================================================");
  log(" We Build for Good: Safe Deploy pipeline");
  log(` Target directory : ${targetDir}`);
  log(` Version tag      : ${options.version || "not set"}`);
  log("===========================================================\n");

  if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
    scorecard.stages.priorArt.status = "FAILED";
    scorecard.stages.priorArt.details = `Target directory does not exist: ${targetDir}`;
    logError(scorecard.stages.priorArt.details);
    return finish(false, "priorArt");
  }

  // Stage 0: Prior-art brief
  const briefPath = path.join(targetDir, "RESEARCH-BRIEF.md");
  const briefExists = fs.existsSync(briefPath);
  if (options.requirePriorArt || briefExists) {
    if (!briefExists) {
      return fail("priorArt", "FAILED", "RESEARCH-BRIEF.md is missing and --require-prior-art is set.");
    }
    const run = runTool(TOOLS.priorArt, ["verify", briefPath], targetDir);
    if (run.available && !run.success) {
      return fail("priorArt", "FAILED", `The prior-art tool rejected RESEARCH-BRIEF.md: ${(run.output || run.error).trim().slice(0, 500)}`);
    }
    if (run.available) {
      scorecard.stages.priorArt.status = "PASSED";
      scorecard.stages.priorArt.details = "The prior-art tool verified RESEARCH-BRIEF.md.";
    } else {
      const problem = fallbackBriefCheck(fs.readFileSync(briefPath, "utf8"));
      if (problem) return fail("priorArt", "FAILED", problem);
      scorecard.stages.priorArt.status = "FALLBACK_PASSED";
      scorecard.stages.priorArt.details = "Prior-art tool not installed; only checked for a verdict and no TODO lines.";
      scorecard.gaps.push(`${scorecard.stages.priorArt.name}: structure check only`);
    }
    log(`[${scorecard.stages.priorArt.name}] ${scorecard.stages.priorArt.status}`);
  } else {
    scorecard.stages.priorArt.details = "No RESEARCH-BRIEF.md and --require-prior-art not set.";
    log(`[${scorecard.stages.priorArt.name}] SKIPPED (${scorecard.stages.priorArt.details})`);
  }

  // Gate 1: System invariants
  const invariantRun = runTool(TOOLS.invariants, ["--dir", targetDir], targetDir);
  if (!invariantRun.available) {
    notRun("invariants", "invariant engine not installed (skill-system-invariant-engine)");
  } else if (!invariantRun.success) {
    return fail("invariants", "FAILED", (invariantRun.output || invariantRun.error).trim().slice(0, 2000));
  } else {
    scorecard.stages.invariants.status = "PASSED";
    scorecard.stages.invariants.details = "Invariant engine passed.";
    log(`[${scorecard.stages.invariants.name}] PASSED`);
  }

  // Gate 2: Visual audit
  let hasUi = Boolean(options.url || options.html);
  if (!hasUi && !options.skipVisual) {
    hasUi = ["index.html", "landing.html", "dist/index.html"].some((f) => fs.existsSync(path.join(targetDir, f)));
  }
  if (options.skipVisual || !hasUi) {
    scorecard.stages.visualAudit.status = "SKIPPED";
    scorecard.stages.visualAudit.details = options.skipVisual ? "Skipped with --skip-visual." : "No HTML entry point found and no --url given.";
    log(`[${scorecard.stages.visualAudit.name}] SKIPPED (${scorecard.stages.visualAudit.details})`);
  } else {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb4g-visual-audit-"));
    const auditArgs = options.url ? [options.url] : ["--dir", targetDir];
    if (options.html) auditArgs.push("--file", options.html);
    auditArgs.push("--output-dir", outputDir);
    const visualRun = runTool(TOOLS.visualAudit, auditArgs, targetDir);
    if (!visualRun.available) {
      notRun("visualAudit", "visual audit tool not installed (skill-visual-sensory-audit)");
    } else if (visualRun.exitCode === 3) {
      notRun("visualAudit", `visual audit could not run on this machine: ${(visualRun.error || "").trim().slice(0, 200)}`);
    } else if (!visualRun.success) {
      return fail("visualAudit", "FAILED", (visualRun.output || visualRun.error).trim().slice(0, 2000));
    } else {
      scorecard.stages.visualAudit.status = "PASSED";
      scorecard.stages.visualAudit.details = `Visual audit tool passed. Screenshots: ${outputDir}`;
      log(`[${scorecard.stages.visualAudit.name}] PASSED`);
    }
  }

  // Gate 3: Backup and migration safety
  let sqlTargets = [];
  if (options.sql) {
    if (!fs.existsSync(options.sql)) {
      return fail("migrations", "FAILED", `--sql path does not exist: ${options.sql}`);
    }
    sqlTargets = [options.sql];
  } else {
    sqlTargets = AUTO_MIGRATION_DIRS.map((d) => path.join(targetDir, d)).filter((d) => fs.existsSync(d));
  }

  let onlyFiles;
  if (options.since && sqlTargets.length) {
    try {
      onlyFiles = changedFilesSince(targetDir, options.since);
    } catch (err) {
      return fail("migrations", "FAILED", `Could not list files changed since "${options.since}": ${err.message.split("\n")[0]}`);
    }
  }

  const reports = sqlTargets.map((t) => inspectMigrationDirectory(t, { onlyFiles }));
  const migrationReport = {
    hasMigrations: reports.some((r) => r.hasMigrations),
    filesCount: reports.reduce((n, r) => n + r.filesCount, 0),
    categories: SEVERITY_ORDER.filter((c) => reports.some((r) => r.categories.includes(c))),
    issues: reports.flatMap((r) => r.issues),
    filesDigest: reports.length
      ? crypto.createHash("sha256").update(reports.map((r) => r.filesDigest).join("\0")).digest("hex")
      : ""
  };
  const has = (c) => migrationReport.categories.includes(c);

  if (migrationReport.hasMigrations || options.backup) {
    let backupCheck = null;

    if (options.backup) {
      backupCheck = verifyBackup(options.backup, { maxAgeHours: options.backupMaxAgeHours });
      if (!backupCheck.valid) {
        return fail("migrations", "FAILED", `Backup verification failed: ${backupCheck.reason}`);
      }
      scorecard.stages.migrations.backup = backupCheck;
      if (backupCheck.assurance !== "FULL") {
        scorecard.gaps.push(`Backup: ${backupCheck.reason}`);
      }
    } else if (migrationReport.hasMigrations && !options.noBackupRequired) {
      return fail(
        "migrations",
        "FAILED",
        "SQL migrations found but no --backup artifact was provided. Rule 1 requires a verified backup. Pass --backup <file>, or --no-backup-required if the release truly touches no data."
      );
    }

    if (migrationReport.hasMigrations) {
      const blocked = [];

      if (has("DESTRUCTIVE")) {
        if (!options.allowDestructive) {
          return fail(
            "migrations",
            "GOVERNED_APPROVAL_REQUIRED",
            "Destructive SQL found. Ordinary risk flags cannot approve it. Use --allow-destructive with a fully verified --backup and --restore-rehearsed.",
            migrationReport.issues
          );
        }
        if (!backupCheck || backupCheck.assurance !== "FULL") {
          return fail(
            "migrations",
            "GOVERNED_APPROVAL_REQUIRED",
            "--allow-destructive needs a --backup that was verified end to end (FULL assurance). --no-backup-required is not accepted for destructive SQL."
          );
        }
        if (!options.restoreRehearsed) {
          return fail(
            "migrations",
            "GOVERNED_APPROVAL_REQUIRED",
            "--allow-destructive needs --restore-rehearsed \"<how you restored this backup into a throwaway database>\". This tool records your note; it cannot perform the restore for you."
          );
        }
        scorecard.approvals.destructive = `Restore rehearsal: ${options.restoreRehearsed}`;
      }
      if (has("DATA_MUTATION_RISK")) {
        if (!options.approveDataMutation) blocked.push(["BLOCKED_ON_DATA_MUTATION", "--approve-data-mutation \"<note>\""]);
        else scorecard.approvals.dataMutation = options.approveDataMutation;
      }
      if (has("REVIEW_REQUIRED")) {
        if (!options.approveUnclassifiedSql) blocked.push(["BLOCKED_ON_UNCLASSIFIED_SQL", "--approve-unclassified-sql \"<note>\""]);
        else scorecard.approvals.unclassified = options.approveUnclassifiedSql;
      }
      if (has("RISKY_ADDITIVE")) {
        if (!options.allowRiskyMigrations) blocked.push(["BLOCKED_ON_RISK_REVIEW", "--approve-risk \"<note>\""]);
        else scorecard.approvals.risky = options.approveRisk || "--allow-risky-migrations";
      }

      if (blocked.length) {
        return fail(
          "migrations",
          blocked[0][0],
          `Each risk type needs its own approval. Still missing: ${blocked.map((b) => b[1]).join(", ")}.`,
          migrationReport.issues
        );
      }

      const approved = migrationReport.categories.map((c) => CATEGORY_LABEL[c]);
      scorecard.stages.migrations.status = approved.length ? "PASSED_WITH_APPROVALS" : "PASSED";
      scorecard.stages.migrations.details = approved.length
        ? `${migrationReport.filesCount} migration file(s); approved: ${approved.join(", ")}.`
        : `${migrationReport.filesCount} migration file(s), all safe additive.`;
      scorecard.stages.migrations.categories = migrationReport.categories;
    } else {
      scorecard.stages.migrations.status = "PASSED";
      scorecard.stages.migrations.details = options.since
        ? `Backup verified. No migration files changed since ${options.since}.`
        : "Backup verified. No SQL migration files found.";
    }
    log(`[${scorecard.stages.migrations.name}] ${scorecard.stages.migrations.status}: ${scorecard.stages.migrations.details}`);
  } else {
    scorecard.stages.migrations.details = sqlTargets.length
      ? (options.since ? `No migration files changed since ${options.since}.` : "Migration folder contains no .sql files.")
      : "No migration folder found (checked: " + AUTO_MIGRATION_DIRS.join(", ") + "). Pass --sql if migrations live elsewhere.";
    log(`[${scorecard.stages.migrations.name}] SKIPPED (${scorecard.stages.migrations.details})`);
  }

  // Gate 4: Release packaging
  const gatesFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wb4g-gates-")), "gates.json");
  const gateResults = Object.fromEntries(
    ["priorArt", "invariants", "visualAudit", "migrations"]
      .filter((k) => scorecard.stages[k].status !== "SKIPPED")
      .map((k) => [k, { status: scorecard.stages[k].status.startsWith("PASSED") ? "PASSED" : scorecard.stages[k].status }])
  );
  fs.writeFileSync(gatesFile, JSON.stringify(gateResults));
  const broadcastArgs = ["--dir", targetDir, "--gates", gatesFile, "--allow-empty"];
  if (options.version) broadcastArgs.push("--version", options.version);
  if (options.since) broadcastArgs.push("--since", options.since);
  if (options.updateChangelog) broadcastArgs.push("--update-changelog");
  const git = gitState(targetDir);
  const broadcastRun = git.sha === "not-a-git-repository"
    ? { available: false }
    : runTool(TOOLS.broadcast, broadcastArgs, targetDir);
  if (git.sha === "not-a-git-repository") {
    notRun("broadcast", "target is not a git repository, so there is no history to package");
  } else if (!broadcastRun.available) {
    notRun("broadcast", "release packaging tool not installed (skill-ship-to-broadcast); no release packet was written");
  } else if (!broadcastRun.success) {
    return fail("broadcast", "FAILED", (broadcastRun.output || broadcastRun.error).trim().slice(0, 2000));
  } else {
    scorecard.stages.broadcast.status = "PASSED";
    scorecard.stages.broadcast.details = "Release packet staged for human approval.";
    log(`[${scorecard.stages.broadcast.name}] PASSED`);
  }

  // Gate 5: Fingerprint and the human boundary
  scorecard.git = { commit: git.sha, uncommittedChanges: git.dirty };
  if (git.dirty) scorecard.gaps.push("Working tree has uncommitted changes: the fingerprint covers them, but deploys usually ship commits.");
  scorecard.integrityDigest = generateIntegrityDigest(scorecard, migrationReport.filesDigest, git.sha, git.workingTreeHash);

  if (options.expectDigest && options.expectDigest !== scorecard.integrityDigest) {
    scorecard.stages.humanGate.status = "FAILED";
    scorecard.stages.humanGate.details = `Fingerprint mismatch: expected ${options.expectDigest}, got ${scorecard.integrityDigest}. What is being deployed is not what was verified.`;
    logError(scorecard.stages.humanGate.details);
    return finish(false, "humanGate");
  }

  if (options.strict && scorecard.gaps.length) {
    scorecard.stages.humanGate.status = "FAILED";
    scorecard.stages.humanGate.details = "--strict: some checks did not fully run.";
    logError(`--strict: failing because of gaps:\n  - ${scorecard.gaps.join("\n  - ")}`);
    return finish(false, "humanGate");
  }

  scorecard.result = scorecard.gaps.length ? "PASSED_WITH_GAPS" : "PASSED";

  if (!options.json) {
    const s = scorecard.stages;
    log("\n===========================================================");
    log(scorecard.gaps.length ? " RESULT: PASSED WITH GAPS (some checks did not fully run)" : " RESULT: ALL CHECKS PASSED");
    log("===========================================================");
    log(` Stage 0 : Prior-art brief        : ${s.priorArt.status}`);
    log(` Gate 1  : System invariants      : ${s.invariants.status}`);
    log(` Gate 2  : Visual audit           : ${s.visualAudit.status}`);
    log(` Gate 3  : Backup and migrations  : ${s.migrations.status}`);
    log(` Gate 4  : Release packaging      : ${s.broadcast.status}`);
    log(` Gate 5  : Human sign-off         : ${s.humanGate.status}`);
    log("===========================================================");
    log(` Fingerprint (sha256): ${scorecard.integrityDigest}`);
    if (scorecard.gaps.length) {
      log("\nGaps:");
      scorecard.gaps.forEach((g) => log(`  - ${g}`));
    }
    log("\nNothing has been deployed. In CI, re-run with --expect-digest <fingerprint> to confirm the");
    log("release is exactly what was checked. Keep production credentials out of the agent's");
    log("environment and require a human approver on the deploy job.");
  }

  return finish(true);
}

export function executeCli(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    printHelp();
    return 0;
  }
  if (options.errors.length) {
    options.errors.forEach((e) => console.error(`Error: ${e}`));
    console.error("Run with --help to see the options.");
    return 2;
  }
  const result = runPipeline(options);
  return result.success ? 0 : 1;
}

// Direct invocation check (handles symlinks, e.g. after npm link)
if (process.argv[1]) {
  let isMain = false;
  try {
    isMain = import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href ||
      import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    isMain = false;
  }
  if (isMain) {
    process.exit(executeCli());
  }
}
