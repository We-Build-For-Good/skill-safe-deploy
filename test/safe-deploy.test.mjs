import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  parseArgs,
  runPipeline,
  executeCli,
  verifyBackup,
  analyzeMigrationSql,
  inspectMigrationDirectory,
  checkInvariantsFallback,
  generateApprovalToken
} from "../bin/safe-deploy.mjs";

test("parseArgs parses all pipeline and safety options properly", () => {
  const args = [
    "--dir", "/tmp/demo-repo",
    "--version", "v1.2.0",
    "--require-prior-art",
    "--sql", "/tmp/migrations",
    "--backup", "/tmp/prod.sql",
    "--skip-visual",
    "--update-changelog",
    "--json"
  ];
  const parsed = parseArgs(args);
  assert.equal(parsed.dir, "/tmp/demo-repo");
  assert.equal(parsed.version, "v1.2.0");
  assert.equal(parsed.requirePriorArt, true);
  assert.equal(parsed.sql, "/tmp/migrations");
  assert.equal(parsed.backup, "/tmp/prod.sql");
  assert.equal(parsed.skipVisual, true);
  assert.equal(parsed.updateChangelog, true);
  assert.equal(parsed.json, true);
});

test("Rule 1: Backup verification catches missing, empty, and corrupt artifacts", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "backup-test-"));
  try {
    // 1. Missing file
    const missing = verifyBackup(path.join(tmpDir, "nonexistent.sql"));
    assert.equal(missing.valid, false);

    // 2. Empty 0-byte file
    const emptyFile = path.join(tmpDir, "empty.sql");
    fs.writeFileSync(emptyFile, "");
    const empty = verifyBackup(emptyFile);
    assert.equal(empty.valid, false);
    assert.match(empty.reason, /empty/i);

    // 3. File below minimum threshold
    const tinyFile = path.join(tmpDir, "tiny.sql");
    fs.writeFileSync(tinyFile, "hello");
    const tiny = verifyBackup(tinyFile, { minBytes: 100 });
    assert.equal(tiny.valid, false);
    assert.match(tiny.reason, /below minimum/i);

    // 4. Corrupt gzip file
    const corruptGz = path.join(tmpDir, "corrupt.sql.gz");
    fs.writeFileSync(corruptGz, Buffer.from([0x00, 0x00, 0x00, 0x00]));
    const gzResult = verifyBackup(corruptGz, { minBytes: 2 });
    assert.equal(gzResult.valid, false);
    assert.match(gzResult.reason, /magic bytes/i);

    // 5. Valid SQL backup
    const validSql = path.join(tmpDir, "valid.sql");
    const dummySql = "-- PostgreSQL Database Dump\nCREATE TABLE users (id SERIAL PRIMARY KEY);\n" + "x".repeat(1500);
    fs.writeFileSync(validSql, dummySql);
    const valid = verifyBackup(validSql, { minBytes: 1024 });
    assert.equal(valid.valid, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Rule 2: Migration SQL risk classifier blocks destructive DDL", () => {
  // Destructive examples
  const dropSql = "ALTER TABLE orders DROP COLUMN customer_notes;";
  const dropResult = analyzeMigrationSql(dropSql);
  assert.equal(dropResult.classification, "DESTRUCTIVE");
  assert.equal(dropResult.canAutoDeploy, false);
  assert.equal(dropResult.requiresGovernedApproval, true);

  const truncateSql = "TRUNCATE sessions;";
  const truncResult = analyzeMigrationSql(truncateSql);
  assert.equal(truncResult.classification, "DESTRUCTIVE");

  const typeAlterSql = "ALTER TABLE users ALTER COLUMN age TYPE bigint;";
  const typeResult = analyzeMigrationSql(typeAlterSql);
  assert.equal(typeResult.classification, "DESTRUCTIVE");
});

test("Rule 2: Migration SQL risk classifier flags risky additive operations", () => {
  // Risky Additive: CREATE INDEX without CONCURRENTLY
  const riskyIndexSql = "CREATE INDEX idx_orders_user_id ON orders(user_id);";
  const indexResult = analyzeMigrationSql(riskyIndexSql);
  assert.equal(indexResult.classification, "RISKY_ADDITIVE");
  assert.equal(indexResult.canAutoDeploy, false);
  assert.match(indexResult.issues[0], /CONCURRENTLY/);

  // Risky Additive: ADD COLUMN with default value
  const riskyColSql = "ALTER TABLE users ADD COLUMN is_active boolean DEFAULT true;";
  const colResult = analyzeMigrationSql(riskyColSql);
  assert.equal(colResult.classification, "RISKY_ADDITIVE");
  assert.match(colResult.issues[0], /default/i);
});

test("Rule 2: Safe additive migrations are cleared on standard path", () => {
  const safeSql = `
    CREATE TABLE audit_logs (id uuid primary key, created_at timestamp);
    CREATE INDEX CONCURRENTLY idx_audit_time ON audit_logs(created_at);
    ALTER TABLE users ADD COLUMN nickname text;
  `;
  const safeResult = analyzeMigrationSql(safeSql);
  assert.equal(safeResult.classification, "SAFE_ADDITIVE");
  assert.equal(safeResult.canAutoDeploy, true);
  assert.equal(safeResult.requiresGovernedApproval, false);
  assert.equal(safeResult.issues.length, 0);
});

test("Rule 2: inspectMigrationDirectory aggregates multiple SQL migration files", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "migrations-test-"));
  try {
    fs.writeFileSync(path.join(tmpDir, "001_create.sql"), "CREATE TABLE posts (id int);");
    fs.writeFileSync(path.join(tmpDir, "002_drop.sql"), "DROP TABLE legacy_posts;");

    const report = inspectMigrationDirectory(tmpDir);
    assert.equal(report.hasMigrations, true);
    assert.equal(report.filesCount, 2);
    assert.equal(report.classification, "DESTRUCTIVE");
    assert.equal(report.requiresGovernedApproval, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Gate 1: Fallback invariant engine detects forbidden em dashes", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inv-test-"));
  try {
    fs.writeFileSync(path.join(tmpDir, "clean.md"), "This is a clean document with hyphens.");
    fs.writeFileSync(path.join(tmpDir, "dirty.md"), "This has an em dash \u2014 here.");

    const res = checkInvariantsFallback(tmpDir);
    assert.equal(res.success, false);
    assert.equal(res.violations.length, 1);
    assert.equal(res.violations[0].file, "dirty.md");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Rule 5: Cryptographic scorecard token generation is deterministic", () => {
  const mockScorecard = {
    targetDir: "/repos/app",
    timestamp: "2026-10-19T12:00:00.000Z",
    stages: { invariants: { status: "PASSED" } }
  };
  const token1 = generateApprovalToken(mockScorecard);
  const token2 = generateApprovalToken(mockScorecard);
  assert.equal(typeof token1, "string");
  assert.equal(token1.length, 64);
  assert.equal(token1, token2);
});

test("runPipeline blocks if --require-prior-art is passed and brief is missing", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb4g-pipeline-test-"));
  try {
    const result = runPipeline({
      dir: tmpDir,
      requirePriorArt: true,
      skipVisual: true,
      json: true
    });
    assert.equal(result.success, false);
    assert.equal(result.scorecard.stages.priorArt.status, "FAILED");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("runPipeline passes cleanly in an isolated clean-clone repository", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clean-clone-test-"));
  try {
    // Populate minimal clean files
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# Clean App\nNo forbidden punctuation.\n");
    fs.writeFileSync(path.join(tmpDir, "index.js"), "console.log('hello world');\n");

    const result = runPipeline({
      dir: tmpDir,
      requirePriorArt: false,
      skipVisual: true,
      json: true
    });

    assert.equal(result.success, true);
    assert.equal(result.scorecard.stages.invariants.status, "PASSED");
    assert.equal(result.scorecard.stages.visualAudit.status, "SKIPPED");
    assert.equal(result.scorecard.stages.broadcast.status, "PASSED");
    assert.equal(result.scorecard.stages.humanGate.status, "STAGED");
    assert.ok(result.scorecard.approvalToken.length > 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("executeCli --help exits with 0", () => {
  const exitCode = executeCli(["--help"]);
  assert.equal(exitCode, 0);
});
