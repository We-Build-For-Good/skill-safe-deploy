# Safe Deploy: Unified Studio Delivery Pipeline (wb4g-pipeline)

> **An open-source AI engineering protocol and delivery engine from [We Build for Good](https://webuildforgood.com)**  
> *Let AI do the preparation and multi-gate verification. Keep human hands on the irreversible buttons.*

---

## Overview

`safe-deploy` (`wb4g-pipeline`) is the unified delivery and release verification pipeline for software engineers, product leads, and autonomous AI agents (Antigravity, Claude Code, Cursor, Codex).

It chains deterministic verification gates of our autonomous studio into a single execution pass:
1. **Stage 0: Prior-Art Verification (`wb4g-prior-art`)**: Verifies evidence-backed research and build decisions before shipping.
2. **Gate 1: System Invariants Engine (`wb4g-invariants`)**: Enforces character invariants (zero em dashes), Prettier legibility, brand boundaries, and file bounds.
3. **Gate 2: Visual Sensory Audit (`wb4g-visual-audit`)**: Drives headless Chrome across 375px, 768px, and 1440px viewports to detect layout blowouts, broken media, touch collisions, and console errors.
4. **Gate 3: Migration Risk & Data Safety Gate**: Static analysis of SQL migrations against the Three-Tier Database Risk Matrix, and backup header/byte assurance.
5. **Gate 4: Release & Broadcast Packaging (`wb4g-broadcast`)**: Compiles git commits into manifests, changelogs, and staged customer announcement drafts.
6. **Gate 5: Enforceable Human Sign-Off Barrier (Rule 5)**: Mechanically holds irreversible production deployments and broadcast transmissions until human approval is given with an immutable SHA-256 scorecard token.

---

## CLI Usage

Install locally or run via node:

```bash
# Run the full unified delivery pipeline against the current repository
node bin/safe-deploy.mjs

# Run pipeline with explicit version tag and changelog update
node bin/safe-deploy.mjs --version v1.2.0 --update-changelog

# Run pipeline enforcing prior-art brief existence
node bin/safe-deploy.mjs --require-prior-art

# Run pipeline with SQL migration inspection and backup artifact verification
node bin/safe-deploy.mjs --sql ./migrations --backup /path/to/backup.sql.gz

# Run pipeline for a backend repository (skipping visual browser audit)
node bin/safe-deploy.mjs --skip-visual

# Output structured scorecard JSON for CI/CD integration
node bin/safe-deploy.mjs --json
```

---

## The Five Safety Rules

1. **Take a Photo First (Backup Assurance Levels)**:
   - Level 1: Strict exit code and pipefail validation (`set -o pipefail`).
   - Level 2: Target verification (correct host and DB) and non-empty file format check (SQL headers, gzip magic bytes).
   - Level 3: Restoration rehearsal on a disposable target for risky schema changes.
2. **Guard the One Door You Cannot Reopen (Three-Tier Risk Matrix)**:
   - Additive does not mean safe.
   - Tier 1 (Safe Additive): `CREATE TABLE`, `CREATE INDEX CONCURRENTLY`, nullable columns without locks.
   - Tier 2 (Risky Additive): `CREATE INDEX` without `CONCURRENTLY`, non-null defaults on older engines, unbatched backfills.
   - Tier 3 (Destructive): `DROP`, `TRUNCATE`, `ALTER COLUMN TYPE`, `SET NOT NULL` on populated tables. Blocks standard path; requires governed approval.
3. **One Step at a Time, In Order (Phased Rollout & Post-Deploy Verification)**:
   - Deploy backend/data tier first; verify deep readiness (DB, Redis, workers).
   - Deploy frontend tier second.
   - Run post-deploy synthetic smoke tests on critical user journeys.
   - Observe a 5 to 15 minute error-rate and latency monitoring window before closing release.
4. **Trust the Checklist, Not the Vibe**: Gate strictly on unpiped process exit codes (`$?`). Verify live systems against real signals, not conversational assertions.
5. **Enforceable Human Boundary**: The AI drafts the exact terminal command and generates an immutable SHA-256 scorecard. The agent execution environment possesses zero production credentials. Production execution is held exclusively for human authorization.

---

## Installation

### As CLI Tool
```bash
git clone https://github.com/We-Build-For-Good/skill-safe-deploy.git
cd skill-safe-deploy
npm test
npm link
```

### For Antigravity / Gemini
```bash
mkdir -p ~/.gemini/config/skills/safe-deploy
cp -r . ~/.gemini/config/skills/safe-deploy/
```

### For Claude Code
```bash
git clone https://github.com/We-Build-For-Good/skill-safe-deploy.git ~/.claude/skills/safe-deploy
```

---

## Automated Test Suite

Runs standalone in any clean clone with zero external dependencies:

```bash
node --test test/*.test.mjs
```

---

## License

MIT License. Developed and maintained by [We Build for Good](https://webuildforgood.com).
