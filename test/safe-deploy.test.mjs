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

test("parseArgs parses all pipeline, safety, and isolated override options properly", () => {
  const args = [
    "--dir", "/tmp/demo-repo",
    "--version", "v1.4.0",
    "--require-prior-art",
    "--sql", "/tmp/migrations",
    "--backup", "/tmp/prod.sql.gz",
    "--allow-risky-migrations",
    "--approve-risk", "Locking reviewed on staging DB with 1M rows",
    "--approve-data-mutation", "Batched 500 records per loop",
    "--approve-unclassified-sql", "Reviewed PL/pgSQL procedural block",
    "--allow-destructive",
    "--no-backup-required",
    "--skip-visual",
    "--update-changelog",
    "--json"
  ];
  const parsed = parseArgs(args);
  assert.equal(parsed.dir, "/tmp/demo-repo");
  assert.equal(parsed.version, "v1.4.0");
  assert.equal(parsed.requirePriorArt, true);
  assert.equal(parsed.sql, "/tmp/migrations");
  assert.equal(parsed.backup, "/tmp/prod.sql.gz");
  assert.equal(parsed.allowRiskyMigrations, true);
  assert.equal(parsed.approveRisk, "Locking reviewed on staging DB with 1M rows");
  assert.equal(parsed.approveDataMutation, "Batched 500 records per loop");
  assert.equal(parsed.approveUnclassifiedSql, "Reviewed PL/pgSQL procedural block");
  assert.equal(parsed.allowDestructive, true);
  assert.equal(parsed.noBackupRequired, true);
  assert.equal(parsed.skipVisual, true);
  assert.equal(parsed.updateChangelog, true);
  assert.equal(parsed.json, true);
});

test("SQL Tokenizer: Preserves semicolons and comments inside string literals", () => {
  const rawSql = `
    INSERT INTO audit_log (details) VALUES ('semicolon; inside string -- not a comment');
    CREATE TABLE widgets (id int);
  `;
  const stmts = splitSqlStatements(rawSql);
  assert.equal(stmts.length, 2);
  assert.equal(stmts[0], "INSERT INTO audit_log (details) VALUES ('semicolon; inside string -- not a comment')");
  assert.equal(stmts[1], "CREATE TABLE widgets (id int)");
});

test("SQL Tokenizer: Strips literals during structural analysis to prevent false positives", () => {
  // String literal contains 'drop table', but statement is an INSERT
  const falseTriggerSql = "INSERT INTO events (payload) VALUES ('drop table users');";
  const analysis = analyzeMigrationSql(falseTriggerSql);
  assert.notEqual(analysis.classification, "DESTRUCTIVE");
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

test("Rule 2: Fail-closed SQL classifier isolates data mutation from unclassified SQL", () => {
  // DELETE FROM users (destructive data deletion)
  const deleteSql = "DELETE FROM users;";
  const deleteResult = analyzeMigrationSql(deleteSql);
  assert.equal(deleteResult.classification, "DESTRUCTIVE");
  assert.equal(deleteResult.canAutoDeploy, false);
  assert.equal(deleteResult.requiresGovernedApproval, true);

  // UPDATE accounts (data mutation risk)
  const updateSql = "UPDATE accounts SET is_active = true WHERE region = 'US';";
  const updateResult = analyzeMigrationSql(updateSql);
  assert.equal(updateResult.classification, "DATA_MUTATION_RISK");
  assert.equal(updateResult.canAutoDeploy, false);

  // Unrecognized SQL (MERGE INTO) defaults to REVIEW_REQUIRED
  const mergeSql = "MERGE INTO target USING source ON target.id = source.id WHEN MATCHED THEN UPDATE SET val = source.val;";
  const mergeResult = analyzeMigrationSql(mergeSql);
  assert.equal(mergeResult.classification, "REVIEW_REQUIRED");
  assert.equal(mergeResult.canAutoDeploy, false);
});

test("Decisive Demonstration: Complete CLI run against destructive fixture exits non-zero and CANNOT be overridden by ordinary risk flags", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "destructive-decisive-fixture-"));
  try {
    const migDir = path.join(tmpDir, "migrations");
    fs.mkdirSync(migDir);
    fs.writeFileSync(path.join(migDir, "001_destructive.sql"), "DROP TABLE customer_records;");

    // 1. Standard pipeline execution: MUST return success = false and status GOVERNED_APPROVAL_REQUIRED
    const res = runPipeline({
      dir: tmpDir,
      sql: migDir,
      noBackupRequired: true,
      skipVisual: true,
      json: true
    });
    assert.equal(res.success, false);
    assert.equal(res.scorecard.overallSuccess, false);
    assert.equal(res.scorecard.stages.migrations.status, "GOVERNED_APPROVAL_REQUIRED");

    // 2. Full CLI execution: MUST exit with non-zero exit code (1)
    const exitCodeStandard = executeCli(["--dir", tmpDir, "--sql", migDir, "--no-backup-required", "--skip-visual"]);
    assert.equal(exitCodeStandard, 1);

    // 3. Attempt to bypass using --allow-risky-migrations: MUST STILL FAIL with exit code 1
    const exitCodeBypass1 = executeCli(["--dir", tmpDir, "--sql", migDir, "--allow-risky-migrations", "--no-backup-required", "--skip-visual"]);
    assert.equal(exitCodeBypass1, 1);

    // 4. Attempt to bypass using --approve-risk: MUST STILL FAIL with exit code 1
    const exitCodeBypass2 = executeCli(["--dir", tmpDir, "--sql", migDir, "--approve-risk", "Attempted bypass", "--no-backup-required", "--skip-visual"]);
    assert.equal(exitCodeBypass2, 1);

    // 5. Explicit governed execution flag (--allow-destructive): Cleared on governed path
    const exitCodeGoverned = executeCli(["--dir", tmpDir, "--sql", migDir, "--allow-destructive", "--no-backup-required", "--skip-visual"]);
    assert.equal(exitCodeGoverned, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Isolation: Unclassified SQL cannot be bypassed by --allow-risky-migrations; requires --approve-unclassified-sql", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unclassified-fixture-"));
  try {
    const migDir = path.join(tmpDir, "migrations");
    fs.mkdirSync(migDir);
    fs.writeFileSync(path.join(migDir, "001_custom.sql"), "VACUUM FULL analytics;");

    // 1. Ordinary risk override flag (--allow-risky-migrations) MUST FAIL for unclassified SQL
    const resOrdinary = runPipeline({
      dir: tmpDir,
      sql: migDir,
      allowRiskyMigrations: true,
      noBackupRequired: true,
      skipVisual: true,
      json: true
    });
    assert.equal(resOrdinary.success, false);
    assert.equal(resOrdinary.scorecard.stages.migrations.status, "BLOCKED_ON_UNCLASSIFIED_SQL");

    // 2. Specific unclassified approval flag (--approve-unclassified-sql) SUCCEEDS
    const resExplicit = runPipeline({
      dir: tmpDir,
      sql: migDir,
      approveUnclassifiedSql: "Reviewed VACUUM maintenance command",
      noBackupRequired: true,
      skipVisual: true,
      json: true
    });
    assert.equal(resExplicit.success, true);
    assert.equal(resExplicit.scorecard.stages.migrations.status, "PASSED_WITH_UNCLASSIFIED_APPROVAL");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Isolation: Data mutation SQL cannot be bypassed by --allow-risky-migrations; requires --approve-data-mutation", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mutation-fixture-"));
  try {
    const migDir = path.join(tmpDir, "migrations");
    fs.mkdirSync(migDir);
    fs.writeFileSync(path.join(migDir, "001_update.sql"), "UPDATE users SET tier = 'pro' WHERE active = true;");

    // 1. Ordinary risk override flag (--allow-risky-migrations) MUST FAIL for data mutations
    const resOrdinary = runPipeline({
      dir: tmpDir,
      sql: migDir,
      allowRiskyMigrations: true,
      noBackupRequired: true,
      skipVisual: true,
      json: true
    });
    assert.equal(resOrdinary.success, false);
    assert.equal(resOrdinary.scorecard.stages.migrations.status, "BLOCKED_ON_DATA_MUTATION");

    // 2. Specific data mutation approval flag (--approve-data-mutation) SUCCEEDS
    const resExplicit = runPipeline({
      dir: tmpDir,
      sql: migDir,
      approveDataMutation: "Batched update verified",
      noBackupRequired: true,
      skipVisual: true,
      json: true
    });
    assert.equal(resExplicit.success, true);
    assert.equal(resExplicit.scorecard.stages.migrations.status, "PASSED_WITH_MUTATION_APPROVAL");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
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
