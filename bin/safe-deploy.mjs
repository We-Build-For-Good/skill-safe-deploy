#!/usr/bin/env node

/**
 * We Build for Good: Unified Studio Delivery Pipeline (wb4g-pipeline)
 * 
 * Chains the four core gates of the autonomous studio:
 * - Stage 0: Prior-Art Verification (wb4g-prior-art)
 * - Gate 1: System Invariants Engine (wb4g-invariants)
 * - Gate 2: Visual Sensory Audit Engine (wb4g-visual-audit)
 * - Gate 3: Release & Broadcast Packaging (wb4g-broadcast)
 * - Gate 4: Human Sign-Off Barrier
 * 
 * Invariant: ZERO em dashes in all output and logic.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Locate sibling tools in wb4g-skills
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

function runTool(toolConfig, args, cwd) {
  try {
    let output;
    if (toolConfig.type === "node") {
      output = execFileSync(process.execPath, [toolConfig.path, ...args], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      });
    } else {
      output = execFileSync(toolConfig.command, args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      });
    }
    return { success: true, exitCode: 0, output };
  } catch (err) {
    return {
      success: false,
      exitCode: err.status || 1,
      output: err.stdout ? err.stdout.toString() : "",
      error: err.stderr ? err.stderr.toString() : err.message
    };
  }
}

function printHelp() {
  console.log(`
We Build for Good: Unified Studio Delivery Pipeline (wb4g-pipeline)

Chains the studio verification and release gates into a single deterministic pass.

Usage:
  wb4g-pipeline [options]
  node safe-deploy.mjs [options]

Options:
  --dir <path>             Target repository root (default: current working directory)
  --version <tag>          Release version tag (e.g. v1.2.0)
  --require-prior-art      Enforce mandatory RESEARCH-BRIEF.md existence and verification
  --skip-visual            Skip visual sensory audit (for backend-only or non-UI repos)
  --html <file>            Specific HTML file for visual audit (default: auto-detect)
  --url <address>          Live URL target for visual sensory audit
  --update-changelog       Prepend new release section to CHANGELOG.md in repo root
  --json                   Output summary scorecard as JSON
  --help, -h              Display documentation
`);
}

export function parseArgs(args) {
  const options = {
    dir: process.cwd(),
    version: "",
    requirePriorArt: false,
    skipVisual: false,
    html: "",
    url: "",
    updateChangelog: false,
    json: false,
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--dir" && i + 1 < args.length) {
      options.dir = path.resolve(process.cwd(), args[++i]);
    } else if (arg === "--version" && i + 1 < args.length) {
      options.version = args[++i];
    } else if (arg === "--require-prior-art") {
      options.requirePriorArt = true;
    } else if (arg === "--skip-visual") {
      options.skipVisual = true;
    } else if (arg === "--html" && i + 1 < args.length) {
      options.html = args[++i];
    } else if (arg === "--url" && i + 1 < args.length) {
      options.url = args[++i];
    } else if (arg === "--update-changelog") {
      options.updateChangelog = true;
    } else if (arg === "--json") {
      options.json = true;
    }
  }

  return options;
}

export function runPipeline(options) {
  const targetDir = options.dir;
  const scorecard = {
    targetDir,
    timestamp: new Date().toISOString(),
    overallSuccess: false,
    stages: {
      priorArt: { name: "Prior-Art Research", status: "SKIPPED", details: "" },
      invariants: { name: "System Invariants (Gate 1)", status: "PENDING", details: "" },
      visualAudit: { name: "Visual Sensory Audit (Gate 2)", status: "PENDING", details: "" },
      broadcast: { name: "Release Packaging (Gate 3)", status: "PENDING", details: "" },
      humanGate: { name: "Human Sign-off Boundary (Rule 5)", status: "STAGED", details: "Irreversible actions blocked pending founder approval" }
    }
  };

  if (!options.json) {
    console.log("===========================================================");
    console.log(" We Build for Good: Unified Studio Delivery Pipeline");
    console.log(` Target Directory : ${targetDir}`);
    console.log(` Version Tag      : ${options.version || "auto-detect"}`);
    console.log(` Mode             : Strict Verification and Release Staging`);
    console.log("===========================================================\n");
  }

  // Stage 0: Prior-Art Verification
  const briefPath = path.join(targetDir, "RESEARCH-BRIEF.md");
  const briefExists = fs.existsSync(briefPath);

  if (options.requirePriorArt || briefExists) {
    if (!briefExists) {
      scorecard.stages.priorArt.status = "FAILED";
      scorecard.stages.priorArt.details = "RESEARCH-BRIEF.md missing while --require-prior-art is active.";
      if (!options.json) {
        console.error("[Stage 0: Prior-Art Research] FAILED: RESEARCH-BRIEF.md not found in target repository.");
      }
      return { success: false, scorecard };
    }

    const priorArtRun = runTool(TOOLS.priorArt, ["verify", briefPath], targetDir);
    if (!priorArtRun.success) {
      scorecard.stages.priorArt.status = "FAILED";
      scorecard.stages.priorArt.details = priorArtRun.error || priorArtRun.output;
      if (!options.json) {
        console.error("[Stage 0: Prior-Art Research] FAILED verification.");
        console.error(priorArtRun.output || priorArtRun.error);
      }
      return { success: false, scorecard };
    }

    scorecard.stages.priorArt.status = "PASSED";
    scorecard.stages.priorArt.details = "Verified prior art research brief clean.";
    if (!options.json) {
      console.log("[Stage 0: Prior-Art Research] PASSED (RESEARCH-BRIEF.md verified clean).");
    }
  } else {
    scorecard.stages.priorArt.status = "SKIPPED";
    scorecard.stages.priorArt.details = "No RESEARCH-BRIEF.md found and --require-prior-art not set (maintenance mode).";
    if (!options.json) {
      console.log("[Stage 0: Prior-Art Research] SKIPPED (Maintenance mode: existing codebase).");
    }
  }

  // Gate 1: System Invariants Engine
  if (!options.json) {
    console.log("\n[Gate 1: System Invariants] Running wb4g-invariants...");
  }
  const invariantRun = runTool(TOOLS.invariants, ["--dir", targetDir], targetDir);
  if (!invariantRun.success) {
    scorecard.stages.invariants.status = "FAILED";
    scorecard.stages.invariants.details = invariantRun.output || invariantRun.error;
    if (!options.json) {
      console.error("[Gate 1: System Invariants] FAILED:");
      console.error(invariantRun.output || invariantRun.error);
    }
    return { success: false, scorecard };
  }
  scorecard.stages.invariants.status = "PASSED";
  scorecard.stages.invariants.details = "All character, legibility, and brand invariants satisfied.";
  if (!options.json) {
    console.log("[Gate 1: System Invariants] PASSED (Zero em dashes, formatting, file bounds verified).");
  }

  // Gate 2: Visual Sensory Audit Gate
  let hasUiFiles = false;
  if (options.url) {
    hasUiFiles = true;
  } else if (!options.skipVisual) {
    const candidateFiles = ["index.html", "landing.html", "dist/index.html"];
    for (const f of candidateFiles) {
      if (fs.existsSync(path.join(targetDir, f))) {
        hasUiFiles = true;
        break;
      }
    }
  }

  if (options.skipVisual || !hasUiFiles) {
    scorecard.stages.visualAudit.status = "SKIPPED";
    scorecard.stages.visualAudit.details = options.skipVisual ? "Explicitly skipped via --skip-visual." : "No entrypoint HTML files detected in target directory.";
    if (!options.json) {
      console.log("\n[Gate 2: Visual Sensory Audit] SKIPPED (" + scorecard.stages.visualAudit.details + ")");
    }
  } else {
    if (!options.json) {
      console.log("\n[Gate 2: Visual Sensory Audit] Running headless Chrome across 3 viewports (375px, 768px, 1440px)...");
    }
    const auditArgs = ["--dir", targetDir];
    if (options.html) {
      auditArgs.push("--file", options.html);
    }
    if (options.url) {
      auditArgs.push(options.url);
    }
    const visualRun = runTool(TOOLS.visualAudit, auditArgs, targetDir);
    if (!visualRun.success) {
      scorecard.stages.visualAudit.status = "FAILED";
      scorecard.stages.visualAudit.details = visualRun.output || visualRun.error;
      if (!options.json) {
        console.error("[Gate 2: Visual Sensory Audit] FAILED:");
        console.error(visualRun.output || visualRun.error);
      }
      return { success: false, scorecard };
    }
    scorecard.stages.visualAudit.status = "PASSED";
    scorecard.stages.visualAudit.details = "Zero horizontal blowouts, zero broken assets, zero runtime exceptions.";
    if (!options.json) {
      console.log("[Gate 2: Visual Sensory Audit] PASSED (Layout, responsive bounds, and runtime console clean).");
    }
  }

  // Gate 3: Release Packaging & Broadcast Generator
  if (!options.json) {
    console.log("\n[Gate 3: Release Packaging] Compiling commits and staging broadcast packet...");
  }
  const broadcastArgs = ["--dir", targetDir];
  if (options.version) {
    broadcastArgs.push("--version", options.version);
  }
  if (options.updateChangelog) {
    broadcastArgs.push("--update-changelog");
  }
  const broadcastRun = runTool(TOOLS.broadcast, broadcastArgs, targetDir);
  if (!broadcastRun.success) {
    scorecard.stages.broadcast.status = "FAILED";
    scorecard.stages.broadcast.details = broadcastRun.output || broadcastRun.error;
    if (!options.json) {
      console.error("[Gate 3: Release Packaging] FAILED:");
      console.error(broadcastRun.output || broadcastRun.error);
    }
    return { success: false, scorecard };
  }
  scorecard.stages.broadcast.status = "PASSED";
  scorecard.stages.broadcast.details = "Release manifest, categorized changelog, and multi-channel drafts staged.";
  if (!options.json) {
    console.log("[Gate 3: Release Packaging] PASSED (Manifest and broadcast packet staged with PENDING_HUMAN_APPROVAL).");
  }

  // Gate 4: Rule 5 Human Barrier
  scorecard.overallSuccess = true;

  if (options.json) {
    console.log(JSON.stringify(scorecard, null, 2));
  } else {
    console.log("\n===========================================================");
    console.log(" STUDIO DELIVERY PIPELINE SCORECARD : ALL GATES PASSED");
    console.log("===========================================================");
    console.log(` Stage 0 : Prior-Art Research      : ${scorecard.stages.priorArt.status}`);
    console.log(` Gate 1  : System Invariants Engine : ${scorecard.stages.invariants.status}`);
    console.log(` Gate 2  : Visual Sensory Audit     : ${scorecard.stages.visualAudit.status}`);
    console.log(` Gate 3  : Release & Broadcast Pack : ${scorecard.stages.broadcast.status}`);
    console.log(` Gate 4  : Human Sign-Off Boundary : ${scorecard.stages.humanGate.status}`);
    console.log("===========================================================");
    console.log("\nRULE 5 ENFORCEMENT: All changes are verified and staged locally.");
    console.log("Autonomous agent execution has completed.");
    console.log("Production push and external broadcasting require human authorization.");
  }

  return { success: true, scorecard };
}

export function executeCli(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    printHelp();
    return 0;
  }
  const result = runPipeline(options);
  return result.success ? 0 : 1;
}

// Direct invocation check (handles symlinks properly)
if (process.argv[1]) {
  try {
    const isMain = import.meta.url === pathToFileURL(process.argv[1]).href ||
      import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
    if (isMain) {
      const exitCode = executeCli();
      process.exit(exitCode);
    }
  } catch {
    // If realpath fails, fallback to direct compare
    if (import.meta.url === `file://${process.argv[1]}`) {
      const exitCode = executeCli();
      process.exit(exitCode);
    }
  }
}
