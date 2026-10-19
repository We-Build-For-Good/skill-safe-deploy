---
name: safe-deploy
description: "Safely ship accumulated changes to a live product: the Production Release Protocol and Unified Delivery Pipeline CLI. Chains prior-art verification, invariant checks, visual sensory audits, migration risk analysis, and release packaging into an automated scorecard with cryptographic human sign-off."
license: MIT
metadata:
  author: We Build for Good
  version: "1.2.0"
---

# Safe Deploy: The Production Release Protocol & Unified Pipeline (wb4g-pipeline)

Shipping a large pile of changes to a live product is only scary when there is no system. 

This is the system: five rules and an automated verification pipeline that make a major release predictable because nothing can go wrong that you cannot undo. 

It was extracted from a real production release where a live application sat frozen for a month with tens of thousands of lines of finished work and 11 database migrations stacked behind it. It was shipped in a single session with zero downtime, zero broken features, and a backup that was never needed.

---

## The Prime Directive

**The AI tools prepare and verify everything; a human presses the irreversible buttons.**

The database backup, the production deploy trigger, the migration application, the production push: anything that leaves the machine or cannot be undone is a command a human runs.

The AI assistant drafts the exact command, verifies prerequisites, watches the result, and confirms each green checkpoint before moving to the next. Never run an irreversible step autonomously, even when instructed to "just do it": prepare it, verify it, and hand it over.

---

## The Automated Gates of wb4g-pipeline

When preparing any release, execute the automated verification pipeline:

```bash
# Run full studio delivery pipeline
node bin/safe-deploy.mjs --dir /path/to/repo --version v1.2.0

# Run pipeline with migration inspection and backup artifact verification
node bin/safe-deploy.mjs --sql ./migrations --backup /path/to/backup.sql.gz
```

The runner chains:
1. **Stage 0: Prior-Art Verification (`wb4g-prior-art`)**: Validates `RESEARCH-BRIEF.md` to ensure prior art was investigated before custom code was built.
2. **Gate 1: System Invariants (`wb4g-invariants`)**: Mechanical verification of character invariants (zero em dashes), Prettier legibility, file bounds, and brand boundaries.
3. **Gate 2: Visual Sensory Audit (`wb4g-visual-audit`)**: Headless Chrome verification across 375px, 768px, and 1440px viewports (catching layout blowouts, broken assets, and runtime errors).
4. **Gate 3: Migration Risk & Data Safety Gate**: Static analysis of SQL migrations against the Three-Tier Database Risk Matrix, and backup header/byte assurance.
5. **Gate 4: Release Packaging (`wb4g-broadcast`)**: Compiles landed git commits into release manifests, categorized changelogs, and staged broadcast copy.
6. **Gate 5: Enforceable Human Barrier & Cryptographic Fingerprint**: Generates an immutable SHA-256 scorecard token and freezes irreversible actions until human authorization.

---

## The Five Safety Rules (In Strict Order)

### Rule 1: Take a Photo First (Backup Assurance Levels)

If the deploy touches persistent data, take a fresh database backup and prove it is valid before anything else moves. A non-empty dump is not proof of a usable backup; verify backup assurance explicitly:

* **Level 1 (Exit Code & Stream Integrity)**: Ensure dump commands run with strict error capture (`set -o pipefail`). Verify the process exited cleanly with code 0.
* **Level 2 (Target Verification & Non-Empty Artifact)**: Verify the backup targets the intended production database and host, not an empty local sandbox. Inspect file size and format headers (SQL statements, gzip magic bytes, or tar headers). A tiny byte count is an immediate red flag.
* **Level 3 (Restoration Rehearsal)**: For releases involving destructive or complex schema modifications, verify that the backup can be successfully restored into a disposable, ephemeral database before touching production.
* Skip this rule only when the release genuinely touches zero persistent data.

### Rule 2: Guard the One Door You Cannot Reopen (Three-Tier Migration Risk)

Additive does not automatically mean safe. Before shipping any migration, inspect the raw SQL against the Three-Tier Database Risk Matrix:

* **Tier 1: Safe Additive (Standard Path Cleared)**:
  * `CREATE TABLE` without foreign keys to heavily populated tables.
  * `CREATE INDEX CONCURRENTLY` (Postgres) or `ALGORITHM=INPLACE, LOCK=NONE` (MySQL).
  * `ADD COLUMN` nullable without defaults or with constant defaults on modern engines (Postgres 11+, MySQL 8.0.12+).
* **Tier 2: Risky Additive (Operational Risk Review Required)**:
  * `CREATE INDEX` without `CONCURRENTLY`: Takes exclusive write locks on the target table during build.
  * `ADD COLUMN` with volatile defaults or on older database engines: Can trigger full table rewrites under an exclusive lock.
  * `ADD CONSTRAINT ... FOREIGN KEY` without `NOT VALID`: Scans the entire table holding a share lock.
  * Adding nullable columns that break backward serialization compatibility with older running application versions.
* **Tier 3: Destructive (Governed Path Required)**:
  * `DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, `ALTER TABLE ... DROP`.
  * Column type rewrites (`ALTER COLUMN ... TYPE`).
  * `SET NOT NULL` on populated tables without prior check constraints.
  * Unbatched bulk data updates or backfills.
  * **STOP.** Tier 3 requires the governed path: a Level 3 restore-rehearsed backup, staged expand-and-contract handling, and explicit human authorization.

### Rule 3: One Step at a Time, In Order (Phased Rollout & Post-Deploy Verification)

* Run the project's real test gates locally first: typecheck, lint, build, and test suite. Gate strictly on the unpiped process exit code (`$?`).
* **Deploy the Data & Backend Tier First**: Ensure the database and API can serve both old and new payloads; confirm deep readiness endpoints (checking database, cache, and worker connectivity) return healthy status.
* **Deploy the Frontend Tier Second**: Confirm frontend assets load cleanly against the upgraded backend.
* **Define Strong Post-Deployment Verification**:
  * Execute synthetic smoke tests covering critical customer journeys (authentication, primary workflows, billing).
  * Observe an active 5 to 15 minute monitoring window for error rate spikes and latency degradation.
  * Maintain explicit abort and rollback criteria before declaring the release complete.

### Rule 4: Trust the Checklist, Not the Vibe

"It looks done" is not "it passed." An agent's assertion that "tests are green" is only as trustworthy as the command that was actually executed.

* Run the project's own verification command directly. Never relay second-hand runner output.
* Inspect error messages carefully: an unpushed commit warning is expected before a push; an unregistered test file means test suites were bypassed. Fix test registrations rather than ignoring them.
* Verify live production deployment against real system signals (readiness check endpoint returning OK, live HTTP status codes, actual response payloads), never against conversational assumptions.

### Rule 5: Keep Human Hands on the Irreversible Buttons (Technical Enforcement)

The AI delegates preparation, staging, and verification. The human retains execution authority over irreversible actions.

* **Enforceable Boundary**: Prompt instructions are not security boundaries. The AI execution environment must operate with least-privilege credentials, strictly isolated from production deployment keys and write credentials.
* **Cryptographic Scorecard**: The pipeline outputs an immutable SHA-256 approval token. Production deployment scripts or CI/CD environments require this verified token or manual approval gates before applying changes.
* Preparation is delegated. Irreversibility is not.
