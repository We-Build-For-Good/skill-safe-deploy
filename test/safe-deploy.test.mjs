import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import {
  parseArgs,
  runPipeline,
  executeCli,
  verifyBackup,
  splitSqlStatements,
  analyzeMigrationSql,
  inspectMigrationDirectory,
  checkInvariantsFallback,
  generateIntegrityDigest
} from "../bin/safe-deploy.mjs";

test("parseArgs parses all pipeline, safety, and risk override options properly", () => {
  const args = [
    "--dir", "/tmp/demo-repo",
    "--version", "v1.3.0",
    "--require-prior-art",
    "--sql", "/tmp/migrations",
    "--backup", "/tmp/prod.sql.gz",
    "--allow-risky-migrations",
    "--approve-risk", "Locking reviewed on staging DB with 1M rows",
    "--no-backup-required",
    "--skip-visual",
    "--update-changelog",
    "--json"
  ];
  const parsed = parseArgs(args);
  assert.equal(parsed.dir, "/tmp/demo-repo");
  assert.equal(parsed.version, "v1.3.0");
  assert.equal(parsed.requirePriorArt, true);
  assert.equal(parsed.sql, "/tmp/migrations");
  assert.equal(parsed.backup, "/tmp/prod.sql.gz");
  assert.equal(parsed.allowRiskyMigrations, true);
  assert.equal(parsed.approveRisk, "Locking reviewed on staging DB with 1M rows");
  assert.equal(parsed.noBackupRequired, true);
  assert.equal(parsed.skipVisual, true);
  assert.equal(parsed.updateChangelog, true);
  assert.equal(parsed.json, true);
});

test("Rule 1: Backup verification catches missing, empty, corrupt header, and truncated gzip archives", () => {
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

    // 3. File below minimum byte threshold
    const tinyFile = path.join(tmpDir, "tiny.sql");
    fs.writeFileSync(tinyFile, "hello");
    const tiny = verifyBackup(tinyFile, { minBytes: 100 });
    assert.equal(tiny.valid, false);
    assert.match(tiny.reason, /below minimum/i);

    // 4. Corrupt gzip magic bytes
    const corruptMagic = path.join(tmpDir, "corrupt-magic.sql.gz");
    fs.writeFileSync(corruptMagic, Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00]));
    const magicResult = verifyBackup(corruptMagic, { minBytes: 2 });
    assert.equal(magicResult.valid, false);
    assert.match(magicResult.reason, /magic bytes/i);

    // 5. Truncated gzip payload with valid magic bytes
    const truncatedGz = path.join(tmpDir, "truncated.sql.gz");
    // Valid gzip header (10 bytes) followed by broken payload
    fs.writeFileSync(truncatedGz, Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0xff, 0xff]));
    const truncResult = verifyBackup(truncatedGz, { minBytes: 10 });
    assert.equal(truncResult.valid, false);
    assert.match(truncResult.reason, /truncated|corrupted/i);

    // 6. Valid gzip archive (fully decompresses cleanly)
    const validGz = path.join(tmpDir, "valid.sql.gz");
    const rawSql = Buffer.from("-- PostgreSQL Dump\nCREATE TABLE users (id serial primary key);\n" + "x".repeat(1500));
    const gzipped = zlib.gzipSync(rawSql);
    fs.writeFileSync(validGz, gzipped);
    const gzPass = verifyBackup(validGz, { minBytes: 50 });
    assert.equal(gzPass.valid, true);
    assert.match(gzPass.reason, /verified/i);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Rule 2: Fail-closed SQL classifier catches DELETE, UPDATE, and data backfills", () => {
  // DELETE FROM users (data destruction)
  const deleteSql = "DELETE FROM users;";
  const deleteResult = analyzeMigrationSql(deleteSql);
  assert.equal(deleteResult.classification, "DESTRUCTIVE");
  assert.equal(deleteResult.canAutoDeploy, false);
  assert.equal(deleteResult.requiresGovernedApproval, true);

  // UPDATE accounts (unbatched data mutation)
  const updateSql = "UPDATE accounts SET is_active = true WHERE region = 'US';";
  const updateResult = analyzeMigrationSql(updateSql);
  assert.equal(updateResult.classification, "DATA_MUTATION_RISK");
  assert.equal(updateResult.canAutoDeploy, false);

  // INSERT INTO ... SELECT (bulk unbatched backfill)
  const backfillSql = "INSERT INTO customer_archives SELECT * FROM customers WHERE closed = true;";
  const backfillResult = analyzeMigrationSql(backfillSql);
  assert.equal(backfillResult.classification, "DATA_MUTATION_RISK");
  assert.equal(backfillResult.canAutoDeploy, false);
});

test("Rule 2: Fail-closed SQL classifier rejects unrecognized SQL to REVIEW_REQUIRED", () => {
  // Unrecognized SQL: MERGE INTO
  const mergeSql = "MERGE INTO target USING source ON target.id = source.id WHEN MATCHED THEN UPDATE SET val = source.val;";
  const mergeResult = analyzeMigrationSql(mergeSql);
  assert.equal(mergeResult.classification, "REVIEW_REQUIRED");
  assert.equal(mergeResult.canAutoDeploy, false);
  assert.match(mergeResult.issues[0], /Unrecognized or unclassified/i);

  // Unrecognized SQL: VACUUM FULL
  const vacuumSql = "VACUUM FULL orders;";
  const vacuumResult = analyzeMigrationSql(vacuumSql);
  assert.equal(vacuumResult.classification, "REVIEW_REQUIRED");
  assert.equal(vacuumResult.canAutoDeploy, false);
});

test("Rule 2: Handles comments, quoted identifiers, and multiple statements", () => {
  const complexSql = `
    -- Setup migration
    /* Multi-line
       documentation comment */
    CREATE TABLE "orders_v2" (id serial primary key, amount decimal);
    -- Now delete old data
    DELETE FROM "legacy_orders" WHERE archived = true;
  `;
  const complexResult = analyzeMigrationSql(complexSql);
  assert.equal(complexResult.classification, "DESTRUCTIVE");
  assert.equal(complexResult.canAutoDeploy, false);
  assert.equal(complexResult.requiresGovernedApproval, true);
});

test("Rule 2: Risky additive operations require explicit risk override", () => {
  const riskyIndex = "CREATE INDEX idx_orders_user ON orders(user_id);";
  const indexResult = analyzeMigrationSql(riskyIndex);
  assert.equal(indexResult.classification, "RISKY_ADDITIVE");
  assert.equal(indexResult.canAutoDeploy, false);
  assert.match(indexResult.issues[0], /CONCURRENTLY/i);
});

test("Rule 2: Safe additive migrations are cleanly approved", () => {
  const safeSql = `
    CREATE TABLE IF NOT EXISTS audit_events (id uuid primary key, created_at timestamp);
    CREATE INDEX CONCURRENTLY idx_audit_time ON audit_events(created_at);
    ALTER TABLE users ADD COLUMN nickname text;
  `;
  const safeResult = analyzeMigrationSql(safeSql);
  assert.equal(safeResult.classification, "SAFE_ADDITIVE");
  assert.equal(safeResult.canAutoDeploy, true);
  assert.equal(safeResult.issues.length, 0);
});

test("Pipeline Enforcement: Migrations present without backup BLOCKS by default", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-nobackup-"));
  try {
    const migDir = path.join(tmpDir, "migrations");
    fs.mkdirSync(migDir);
    fs.writeFileSync(path.join(migDir, "001_safe.sql"), "CREATE TABLE widgets (id int);");

    const result = runPipeline({
      dir: tmpDir,
      sql: migDir,
      skipVisual: true,
      json: true
    });

    assert.equal(result.success, false);
    assert.equal(result.scorecard.stages.migrations.status, "FAILED");
    assert.match(result.scorecard.stages.migrations.details, /no --backup artifact/i);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Pipeline Enforcement: Risky additive migration BLOCKS unless explicitly overridden", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-risky-"));
  try {
    const migDir = path.join(tmpDir, "migrations");
    fs.mkdirSync(migDir);
    fs.writeFileSync(path.join(migDir, "001_risky.sql"), "CREATE INDEX idx_test ON users(email);");

    // 1. Without risk override: MUST FAIL
    const blocked = runPipeline({
      dir: tmpDir,
      sql: migDir,
      noBackupRequired: true,
      skipVisual: true,
      json: true
    });
    assert.equal(blocked.success, false);
    assert.equal(blocked.scorecard.stages.migrations.status, "BLOCKED_ON_RISK_REVIEW");

    // 2. With explicit risk override: MUST PASS with PASSED_WITH_RISK_OVERRIDE
    const passed = runPipeline({
      dir: tmpDir,
      sql: migDir,
      allowRiskyMigrations: true,
      approveRisk: "Staging table locking reviewed",
      noBackupRequired: true,
      skipVisual: true,
      json: true
    });
    assert.equal(passed.success, true);
    assert.equal(passed.scorecard.stages.migrations.status, "PASSED_WITH_RISK_OVERRIDE");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Rule 5: Cryptographic Integrity Digest binds migration content and commit", () => {
  const mockScorecard = {
    targetDir: "/repos/app",
    timestamp: "2026-10-19T12:00:00.000Z",
    stages: { invariants: { status: "PASSED" } }
  };
  const digest1 = generateIntegrityDigest(mockScorecard, "hashA", "commit123");
  const digest2 = generateIntegrityDigest(mockScorecard, "hashA", "commit123");
  const digest3 = generateIntegrityDigest(mockScorecard, "hashB", "commit123");

  assert.equal(digest1, digest2);
  assert.notEqual(digest1, digest3);
  assert.equal(digest1.length, 64);
});

test("Fallback transparency: Standalone clean clone reports FALLBACK_PASSED honestly", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clean-clone-"));
  try {
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# Clean App\nClean hyphens.\n");
    const result = runPipeline({
      dir: tmpDir,
      skipVisual: true,
      json: true
    });

    assert.equal(result.success, true);
    assert.ok(["PASSED", "FALLBACK_PASSED"].includes(result.scorecard.stages.invariants.status));
    assert.equal(result.scorecard.stages.broadcast.status, "STANDALONE_STAGED");
    assert.ok(result.scorecard.integrityDigest.length > 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("executeCli --help exits with 0", () => {
  const exitCode = executeCli(["--help"]);
  assert.equal(exitCode, 0);
});
