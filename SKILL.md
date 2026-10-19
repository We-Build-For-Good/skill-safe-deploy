---
name: safe-deploy
description: "Safely ship accumulated changes to a live product: the Production Release Protocol and Unified Delivery Pipeline CLI. Chains prior-art verification, invariant checks, visual sensory audits, fail-closed migration risk analysis with isolated override boundaries, and release packaging into an automated scorecard with cryptographic integrity digests."
license: MIT
metadata:
  author: We Build for Good
  version: "1.4.0"
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
node bin/safe-deploy.mjs --dir /path/to/repo --version v1.4.0

# Run pipeline with migration inspection and backup artifact verification
node bin/safe-deploy.mjs --sql ./migrations --backup /path/to/backup.sql.gz

# Run pipeline acknowledging Tier 2 risky additive migrations
node bin/safe-deploy.mjs --sql ./migrations --backup /path/to/backup.sql.gz --approve-risk "Locking verified on 1M row staging DB"

# Run pipeline acknowledging unbatched data mutations / backfills
node bin/safe-deploy.mjs --sql ./migrations --backup /path/to/backup.sql.gz --approve-data-mutation "Batched in 500 row chunks"

# Run pipeline acknowledging unrecognized / custom procedural SQL
node bin/safe-deploy.mjs --sql ./migrations --backup /path/to/backup.sql.gz --approve-unclassified-sql "Reviewed PL/pgSQL function"
```

The runner chains:
1. **Stage 0: Prior-Art Verification (`wb4g-prior-art`)**: Validates `RESEARCH-BRIEF.md` to ensure prior art was investigated before custom code was built.
2. **Gate 1: System Invariants (`wb4g-invariants`)**: Mechanical verification of character invariants (zero em dashes), Prettier legibility, file bounds, and brand boundaries. Reports `PASSED` or `FALLBACK_PASSED` transparently based on environment capabilities.
3. **Gate 2: Visual Sensory Audit (`wb4g-visual-audit`)**: Headless Chrome verification across 375px, 768px, and 1440px viewports (catching layout blowouts, broken assets, and runtime errors).
4. **Gate 3: Fail-Closed Migration Risk & Data Safety Gate**: Static analysis of SQL migrations using a character-state tokenizer. Enforces mandatory backup verification whenever migrations are detected, and decompresses gzip archives to verify payload integrity. Enforces isolated override boundaries per risk category. Destructive migrations cannot be overridden by ordinary risk flags.
5. **Gate 4: Release Packaging (`wb4g-broadcast`)**: Compiles landed git commits into release manifests, categorized changelogs, and staged broadcast copy. Reports `PASSED` or `STANDALONE_STAGED` transparently.
6. **Gate 5: Integrity Digest & Infrastructure Authorization Boundary**: Binds git commit SHA, migration file content hashes, and gate results into an immutable SHA-256 integrity digest. Freezes irreversible actions for external infrastructure authorization.

---

## The Five Safety Rules (In Strict Order)

### Rule 1: Take a Photo First (Backup Assurance & Mandatory Gate)

If the deploy touches persistent data, take a fresh database backup and prove it is valid before anything else moves. When SQL migrations are detected, backup verification is mandatory by default:

* **Level 1 (Stream Integrity & Archive Decompression)**: Ensure dump commands run with strict error capture (`set -o pipefail`). For gzip archives, verify full archive integrity via payload decompression to catch premature truncation or CRC corruption after the header.
* **Level 2 (Target Verification & Non-Empty Artifact)**: Verify the backup targets the intended production database and host, not an empty local sandbox. Inspect file size and format headers (SQL statements, gzip magic bytes, or tar headers). A tiny byte count is an immediate red flag.
* **Level 3 (Restoration Rehearsal)**: For releases involving destructive schema modifications, verify that the backup can be successfully restored into a disposable, ephemeral database before touching production.
* Skip this rule only when the release genuinely touches zero persistent data (waived explicitly via `--no-backup-required`).

### Rule 2: Guard the One Door You Cannot Reopen (Isolated Risk Boundaries)

Additive does not automatically mean safe, and unclassified SQL cannot be assumed benign. The engine tokenizes SQL statements respecting quotes and comments, and partitions safety into strict isolated boundaries:

* **Tier 1: Safe Additive (Standard Path Cleared)**:
  * `CREATE TABLE` without foreign keys to heavily populated tables.
  * `CREATE INDEX CONCURRENTLY` (Postgres) or `ALGORITHM=INPLACE, LOCK=NONE` (MySQL).
  * `ADD COLUMN` nullable without defaults or with constant defaults on modern engines.
* **Tier 2: Risky Additive (Enforced Risk Review Gate)**:
  * `CREATE INDEX` without `CONCURRENTLY`: Takes exclusive write locks on the target table during build.
  * `ADD COLUMN` with volatile defaults: Can trigger full table rewrites under an exclusive lock.
  * **ENFORCEMENT**: Blocks autonomous rollout with exit code 1. Permitted only with explicit operator acknowledgment: `--allow-risky-migrations` or `--approve-risk "<justification>"`.
* **Data Mutation Risk (Enforced Mutation Gate)**:
  * `UPDATE ... SET` or `INSERT INTO ... SELECT`: Data mutations and bulk unbatched backfills.
  * **ENFORCEMENT**: Blocks autonomous rollout with exit code 1. Cannot be bypassed by `--allow-risky-migrations`. Requires explicit `--approve-data-mutation "<justification>"`.
* **Unclassified SQL (Fail-Closed Review Gate)**:
  * Any statement not matching an explicit safe whitelist (e.g. `MERGE INTO`, `VACUUM FULL`, procedural blocks) defaults to `REVIEW_REQUIRED`.
  * **ENFORCEMENT**: Blocks autonomous rollout with exit code 1. Cannot be bypassed by ordinary risk flags. Requires explicit `--approve-unclassified-sql "<justification>"`.
* **Tier 3: Destructive (Governed Path Required)**:
  * `DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, `ALTER TABLE ... DROP`.
  * Column type rewrites (`ALTER COLUMN ... TYPE`).
  * `DELETE FROM` (unbatched data deletion).
  * `SET NOT NULL` on populated tables without prior check constraints.
  * **CRITICAL ENFORCEMENT**: Destructive migrations unconditionally exit with non-zero status (`GOVERNED_APPROVAL_REQUIRED`). They CANNOT be overridden by `--allow-risky-migrations` or `--approve-risk`. Permitted only on the governed path with `--allow-destructive` and a Level 3 restore-rehearsed backup.

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

* **Integrity vs Authorization**: The pipeline computes an immutable SHA-256 `integrityDigest` that binds the exact git commit SHA, migration file contents, and verification gate results. This fingerprint proves artifact integrity; it is not an authorization grant.
* **Infrastructure Authorization**: The AI agent operates with least-privilege credentials, strictly isolated from production deployment keys and write credentials. Actual authorization must be enforced via external infrastructure boundaries (e.g. GitHub Environment Protection Rules with required human approvers or manual CI/CD deploy jobs).
* Preparation is delegated. Irreversibility is not.
