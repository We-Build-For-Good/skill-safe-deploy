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
  generateIntegrityDigest
} from "../bin/safe-deploy.mjs";
import { execFileSync } from "node:child_process";

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
    const rawSql = Buffer.from("-- PostgreSQL database dump\nCREATE TABLE users (id serial primary key);\n" + "-- x\n".repeat(400) + "--\n-- PostgreSQL database dump complete\n--\n");
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

  // Unrecognized SQL (GRANT) defaults to REVIEW_REQUIRED
  const grantResult = analyzeMigrationSql("GRANT ALL ON profiles TO anon;");
  assert.equal(grantResult.classification, "REVIEW_REQUIRED");
  assert.equal(grantResult.canAutoDeploy, false);
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

    // 5. --allow-destructive without a verified backup: MUST STILL FAIL (regression: v1.4.0 passed this)
    const exitCodeNoBackup = executeCli(["--dir", tmpDir, "--sql", migDir, "--allow-destructive", "--no-backup-required", "--skip-visual"]);
    assert.equal(exitCodeNoBackup, 1);

    // 6. Governed path: verified backup + restore rehearsal note
    const backup = path.join(tmpDir, "prod.sql");
    fs.writeFileSync(backup, "-- PostgreSQL database dump\n" + "-- x\n".repeat(400) + "-- PostgreSQL database dump complete\n");
    const exitCodeGoverned = executeCli(["--dir", tmpDir, "--sql", migDir, "--allow-destructive", "--backup", backup, "--restore-rehearsed", "Restored into scratch DB, row counts match", "--skip-visual"]);
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
    assert.equal(resExplicit.scorecard.stages.migrations.status, "PASSED_WITH_APPROVALS");
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
    assert.equal(resExplicit.scorecard.stages.migrations.status, "PASSED_WITH_APPROVALS");
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
    assert.equal(passed.scorecard.stages.migrations.status, "PASSED_WITH_APPROVALS");
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
  const digest1 = generateIntegrityDigest(mockScorecard, "hashA", "commit123", "clean");
  const digest2 = generateIntegrityDigest({ ...mockScorecard, timestamp: "2026-10-20T09:00:00.000Z" }, "hashA", "commit123", "clean");
  const digest3 = generateIntegrityDigest(mockScorecard, "hashB", "commit123", "clean");
  const digest4 = generateIntegrityDigest(mockScorecard, "hashA", "commit123", "dirty-tree-hash");

  assert.equal(digest1, digest2, "fingerprint must not depend on the run time, so CI can reproduce it");
  assert.notEqual(digest1, digest3);
  assert.notEqual(digest1, digest4, "uncommitted changes must change the fingerprint");
  assert.equal(digest1.length, 64);
});

test("Honest status: tools that are not installed report NOT_RUN, never PASSED", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clean-clone-"));
  try {
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# Clean App\nClean hyphens.\n");
    const result = runPipeline({
      dir: tmpDir,
      skipVisual: true,
      json: true
    });

    assert.equal(result.success, true);
    assert.ok(["PASSED", "NOT_RUN"].includes(result.scorecard.stages.invariants.status));
    assert.ok(["PASSED", "NOT_RUN"].includes(result.scorecard.stages.broadcast.status));
    if (result.scorecard.stages.broadcast.status === "NOT_RUN") {
      assert.equal(result.scorecard.result, "PASSED_WITH_GAPS");
    }
    assert.ok(result.scorecard.integrityDigest.length > 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("executeCli --help exits with 0", () => {
  const exitCode = executeCli(["--help"]);
  assert.equal(exitCode, 0);
});

// ---------------------------------------------------------------------------
// Regression tests for the 2026-10-20 catalogue review. Each one failed on v1.4.0.
// ---------------------------------------------------------------------------

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sd-regression-"));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

function quiet(fn) {
  const log = console.log;
  const err = console.error;
  let out = "";
  console.log = (...a) => { out += a.join(" ") + "\n"; };
  console.error = () => {};
  try {
    return { value: fn(), out };
  } finally {
    console.log = log;
    console.error = err;
  }
}

const base = { noBackupRequired: true, skipVisual: true, json: true };
const run = (dir, extra = {}) => quiet(() => runPipeline({ dir, ...base, ...extra })).value;

test("Isolation: unclassified SQL followed by CREATE INDEX is not approved by --allow-risky-migrations", () => {
  const dir = fixture({ "migrations/001.sql": "GRANT ALL ON t TO anon; CREATE INDEX i ON t(x);" });
  try {
    const r = run(dir, { allowRiskyMigrations: true });
    assert.equal(r.success, false);
    assert.equal(r.scorecard.stages.migrations.status, "BLOCKED_ON_UNCLASSIFIED_SQL");
    assert.deepEqual(analyzeMigrationSql("GRANT ALL ON t TO anon; CREATE INDEX i ON t(x);").categories, ["RISKY_ADDITIVE", "REVIEW_REQUIRED"]);
    assert.equal(run(dir, { allowRiskyMigrations: true, approveUnclassifiedSql: "grant reviewed" }).success, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Isolation: approving unclassified SQL does not approve an UPDATE in the same file", () => {
  const dir = fixture({ "migrations/001.sql": "UPDATE t SET a = 1; GRANT ALL ON t TO anon;" });
  try {
    const r = run(dir, { approveUnclassifiedSql: "grant reviewed" });
    assert.equal(r.success, false);
    assert.equal(r.scorecard.stages.migrations.status, "BLOCKED_ON_DATA_MUTATION");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Isolation: approvals across separate files are also independent", () => {
  const dir = fixture({ "migrations/001.sql": "UPDATE t SET a = 1;", "migrations/002.sql": "VACUUM FULL t;" });
  try {
    assert.equal(run(dir, { approveDataMutation: "batched" }).success, false);
    assert.equal(run(dir, { approveDataMutation: "batched", approveUnclassifiedSql: "vacuum ok" }).success, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Fail-closed: migrations in subfolders (Prisma layout) are found", () => {
  const dir = fixture({ "prisma/migrations/20240101_x/migration.sql": "DROP TABLE users;" });
  try {
    const r = run(dir);
    assert.equal(r.success, false);
    assert.equal(r.scorecard.stages.migrations.status, "GOVERNED_APPROVAL_REQUIRED");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Fail-closed: a --sql path that does not exist fails instead of passing", () => {
  const dir = fixture({ "README.md": "hi" });
  try {
    const r = run(dir, { sql: path.join(dir, "nope") });
    assert.equal(r.success, false);
    assert.match(r.scorecard.stages.migrations.details, /does not exist/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--since only checks migrations changed since the ref, so an old DROP does not block forever", () => {
  const dir = fixture({ "migrations/001_old.sql": "DROP TABLE legacy;" });
  try {
    const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
    git("init", "-q");
    git("-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "old");
    git("tag", "v1");
    fs.writeFileSync(path.join(dir, "migrations/002_new.sql"), "CREATE TABLE widgets (id int);");

    assert.equal(run(dir).success, false, "without --since every file is checked (fail-closed default)");
    const r = run(dir, { since: "v1" });
    assert.equal(r.success, true);
    assert.equal(r.scorecard.stages.migrations.status, "PASSED");
    assert.equal(run(dir, { since: "no-such-ref" }).success, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Classifier: Supabase function bodies do not trigger DESTRUCTIVE, DO blocks do", () => {
  const fn = "CREATE FUNCTION f() RETURNS void AS $$ BEGIN DELETE FROM sessions WHERE x < now(); END; $$ LANGUAGE plpgsql;";
  assert.deepEqual(splitSqlStatements(fn).length, 1);
  assert.equal(analyzeMigrationSql(fn).classification, "REVIEW_REQUIRED");
  const doBlock = "DO $$ BEGIN DROP TABLE users; END $$;";
  assert.equal(analyzeMigrationSql(doBlock).classification, "DESTRUCTIVE");
});

test("Classifier: column additions follow Postgres 11+ rules", () => {
  const cls = (sql) => analyzeMigrationSql(sql).classification;
  assert.equal(cls("ALTER TABLE t ADD COLUMN n integer DEFAULT 0;"), "SAFE_ADDITIVE");
  assert.equal(cls("ALTER TABLE t ADD COLUMN s text DEFAULT 'x' NOT NULL;"), "SAFE_ADDITIVE");
  assert.equal(cls("ALTER TABLE t ADD COLUMN n numeric(10,2);"), "SAFE_ADDITIVE");
  assert.equal(cls("ALTER TABLE t ADD COLUMN ts timestamp with time zone;"), "SAFE_ADDITIVE");
  assert.equal(cls("ALTER TABLE t ADD COLUMN id uuid DEFAULT gen_random_uuid();"), "RISKY_ADDITIVE");
  assert.equal(cls("ALTER TABLE t ADD COLUMN n int NOT NULL;"), "RISKY_ADDITIVE");
  assert.equal(cls("ALTER TABLE t ADD COLUMN a int, DROP COLUMN b;"), "DESTRUCTIVE");
  assert.equal(cls("ALTER TABLE IF EXISTS t DROP email;"), "DESTRUCTIVE");
  assert.equal(cls("ALTER TABLE t ALTER COLUMN c SET DATA TYPE bigint;"), "DESTRUCTIVE");
  assert.equal(cls("ALTER TABLE t ALTER COLUMN c DROP DEFAULT;"), "SAFE_ADDITIVE");
  assert.equal(cls("DROP POLICY p ON t;"), "DESTRUCTIVE");
  assert.equal(cls("INSERT INTO t (a, b) SELECT a, b FROM s;"), "DATA_MUTATION_RISK");
});

test("Backup: truncated dumps, unknown formats, and stale backups are rejected", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sd-backup-"));
  try {
    const trunc = path.join(dir, "trunc.sql");
    fs.writeFileSync(trunc, "-- PostgreSQL database dump\n" + "INSERT INTO t VALUES (1);\n".repeat(100) + "INSERT INTO t VAL");
    assert.equal(verifyBackup(trunc).valid, false);

    const junk = path.join(dir, "old.dump");
    fs.writeFileSync(junk, Buffer.alloc(2000, 7));
    assert.equal(verifyBackup(junk).valid, false);

    const good = path.join(dir, "good.sql");
    fs.writeFileSync(good, "-- PostgreSQL database dump\n" + "-- x\n".repeat(400) + "-- PostgreSQL database dump complete\n");
    assert.equal(verifyBackup(good).valid, true);
    assert.equal(verifyBackup(good).assurance, "FULL");
    const twoDaysAgo = new Date(Date.now() - 48 * 3_600_000);
    fs.utimesSync(good, twoDaysAgo, twoDaysAgo);
    assert.equal(verifyBackup(good).valid, false);
    assert.equal(verifyBackup(good, { maxAgeHours: 0 }).valid, true);

    const gzTrunc = path.join(dir, "trunc.sql.gz");
    const gz = zlib.gzipSync(fs.readFileSync(good));
    fs.writeFileSync(gzTrunc, gz.subarray(0, gz.length - 20));
    assert.equal(verifyBackup(gzTrunc, { minBytes: 10 }).valid, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Em dashes in a user's repo do not fail the deploy unless they run the invariant engine", () => {
  const dir = fixture({ "README.md": "Hello — world" });
  try {
    const r = run(dir);
    // If the invariant engine is co-located it may enforce its own rules; standalone, the gate is NOT_RUN.
    if (r.scorecard.stages.invariants.status === "NOT_RUN") assert.equal(r.success, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--json prints the scorecard on failure too", () => {
  const dir = fixture({ "migrations/001.sql": "DROP TABLE users;" });
  try {
    const { value, out } = quiet(() => runPipeline({ dir, ...base }));
    assert.equal(value.success, false);
    const parsed = JSON.parse(out);
    assert.equal(parsed.failedStage, "migrations");
    assert.equal(parsed.overallSuccess, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--expect-digest fails when the release differs from what was verified", () => {
  const dir = fixture({ "migrations/001.sql": "CREATE TABLE a (id int);" });
  try {
    const first = run(dir);
    assert.equal(first.success, true);
    assert.equal(run(dir, { expectDigest: first.scorecard.integrityDigest }).success, true);
    fs.writeFileSync(path.join(dir, "migrations/001.sql"), "CREATE TABLE b (id int);");
    assert.equal(run(dir, { expectDigest: first.scorecard.integrityDigest }).success, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: unknown flags, missing values, and --flag=value", () => {
  assert.deepEqual(parseArgs(["--approve-destructive"]).errors, ["Unknown option: --approve-destructive"]);
  assert.equal(parseArgs(["--approve-risk"]).errors.length, 1);
  assert.equal(parseArgs(["--sql=./migrations"]).sql, path.resolve("./migrations"));
  assert.equal(quiet(() => executeCli(["--approve-destructive"])).value, 2);
});
