import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseArgs, runPipeline, executeCli } from "../bin/safe-deploy.mjs";

test("parseArgs parses pipeline options properly", () => {
  const args = [
    "--dir", "/tmp/demo-repo",
    "--version", "v1.5.0",
    "--require-prior-art",
    "--skip-visual",
    "--update-changelog",
    "--json"
  ];
  const parsed = parseArgs(args);
  assert.equal(parsed.dir, "/tmp/demo-repo");
  assert.equal(parsed.version, "v1.5.0");
  assert.equal(parsed.requirePriorArt, true);
  assert.equal(parsed.skipVisual, true);
  assert.equal(parsed.updateChangelog, true);
  assert.equal(parsed.json, true);
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

test("runPipeline passes cleanly in maintenance mode on a valid git repository", () => {
  // Point to skill-system-invariant-engine which is already a clean valid git repo with no em dashes
  const invariantEngineDir = path.resolve(process.cwd(), "../skill-system-invariant-engine");
  const result = runPipeline({
    dir: invariantEngineDir,
    requirePriorArt: false,
    skipVisual: true,
    json: true
  });

  assert.equal(result.success, true);
  assert.equal(result.scorecard.stages.invariants.status, "PASSED");
  assert.equal(result.scorecard.stages.visualAudit.status, "SKIPPED");
  assert.equal(result.scorecard.stages.broadcast.status, "PASSED");
  assert.equal(result.scorecard.stages.humanGate.status, "STAGED");
});

test("executeCli --help exits with 0", () => {
  const exitCode = executeCli(["--help"]);
  assert.equal(exitCode, 0);
});
