---
name: safe-deploy
description: "Safely ship accumulated changes to a live product. Five release rules (backup first, guard irreversible migrations, deploy in order, trust real checks, humans press the irreversible buttons) plus a pre-release checker that verifies the backup, classifies SQL migrations by risk, requires a separate approval for each risk type, and produces a reproducible release fingerprint for CI. Use when deploying to production, shipping a backlog or a database migration, or releasing AI-built work."
license: MIT
metadata:
  author: We Build for Good
  version: "2.0.0"
---

# Safe Deploy: the Production Release Protocol

Shipping a big pile of changes to a live product is only scary when there is no system.

This is the system: five rules, in order, plus a checker that runs the parts a machine can check. It was extracted from a real release: a live product that had not been deployed for a month, with more than 100 commits, about 64,000 added lines, and 11 database migrations behind it. It shipped in a single session, and the backup was never needed.

---

## The Prime Directive

**The AI prepares and verifies everything; a human presses the irreversible buttons.**

The database backup, the production deploy, applying migrations, the production push: anything that leaves the machine or cannot be undone is a command a human runs.

The AI drafts the exact command, checks the prerequisites, watches the result, and confirms each checkpoint before moving on. Never run an irreversible step yourself, even when told to "just do it": prepare it, verify it, and hand it over.

---

## The checker (wb4g-pipeline)

Run it before every release. It never deploys anything.

```bash
# Typical release: check only migrations added since the last release tag
node bin/safe-deploy.mjs --dir /path/to/repo --since v1.3.0 --backup ./backups/prod-2026-10-20.sql.gz

# Approvals: each risk type needs its own flag, with a reason
node bin/safe-deploy.mjs --since v1.3.0 --backup ./prod.sql.gz \
  --approve-risk "Index built on a 1M-row staging copy in 4s" \
  --approve-data-mutation "Backfill runs in 500-row batches"

# Destructive SQL: needs a fully verified backup AND a restore rehearsal note
node bin/safe-deploy.mjs --since v1.3.0 --backup ./prod.sql.gz --allow-destructive \
  --restore-rehearsed "Restored into a scratch database; row counts match"

# In CI: confirm the release is exactly what was checked
node bin/safe-deploy.mjs --since v1.3.0 --no-backup-required --expect-digest <fingerprint> --strict --json
```

What it checks, in order (it stops at the first hard failure):

| Stage | What it does | Without the optional tool |
|---|---|---|
| 0. Prior-art brief | If `RESEARCH-BRIEF.md` exists (or `--require-prior-art`), checks it with the `skill-does-this-exist` tool | Checks only that the brief has a `## Verdict` section naming ADOPT, FORK-AND-EXTEND, or BUILD (`FALLBACK_PASSED`) |
| 1. Invariants | Runs `skill-system-invariant-engine` | `NOT_RUN` |
| 2. Visual audit | Runs `skill-visual-sensory-audit` when the repo has an HTML entry point or you pass `--url` | `NOT_RUN` |
| 3. Backup and migrations | Built in. See Rules 1 and 2 | Always runs |
| 4. Release packaging | Runs `skill-ship-to-broadcast` | `NOT_RUN` (no release packet is written) |
| 5. Fingerprint | SHA-256 of the commit, any uncommitted changes, the migration files, and every stage's status | Always runs |

The optional tools are found when the catalogue repos are cloned side by side, or when they are on your `PATH`. If a tool runs and fails, the release fails: there is no fallback for a real failure. If any stage did not fully run, the result is `PASSED_WITH_GAPS` and the gaps are listed. Add `--strict` to make gaps fail.

---

## The Five Safety Rules (in order)

### Rule 1: Take a photo first (backup)

If the release touches persistent data, take a fresh backup and prove it is usable before anything else moves.

What the checker verifies (`--backup <file>`):
* The file exists, is not empty, and is under 24 hours old (change with `--backup-max-age-hours`).
* Plain SQL dumps, gzipped or not, are read end to end in a stream (safe for multi-gigabyte files) and must end with the dump tool's completion marker (`pg_dump`, `mysqldump`, or sqlite `.dump`). A dump cut off part way fails.
* `pg_dump -Fc` custom archives are checked with `pg_restore --list` when it is installed (full assurance). Without `pg_restore`, only the header is checked and the result is marked `HEADER_ONLY`.
* If migrations are found and no backup is given, the release fails. `--no-backup-required` waives this only for releases with no destructive SQL.

What you still do yourself:
* Run the dump with strict error handling (`set -o pipefail`) so a failed dump cannot produce a file.
* Confirm the backup came from the production database, not a local one. The checker cannot tell which database a dump came from.
* Before destructive changes, restore the backup into a throwaway database and check it. The checker records your `--restore-rehearsed` note; it cannot do the restore for you.

### Rule 2: Guard the one door you cannot reopen (migration risk)

The checker splits each SQL file into statements, ignoring semicolons inside quotes, comments, and Postgres `$$` function bodies, and puts every statement into one of five categories. **Every category present needs its own approval**, so approving one kind of risk never approves another, even in the same file.

| Category | Examples | Needs |
|---|---|---|
| Safe additive | `CREATE TABLE`, `CREATE INDEX CONCURRENTLY`, `ADD COLUMN` with no default or a constant default (Postgres 11+), `ADD CONSTRAINT ... NOT VALID`, `COMMENT ON` | Nothing |
| Risky additive | `CREATE INDEX` without `CONCURRENTLY`, `ADD COLUMN` with a computed default such as `gen_random_uuid()`, `ADD COLUMN ... NOT NULL` without a default, foreign keys or checks without `NOT VALID` | `--approve-risk "<reason>"` |
| Data change | `UPDATE`, `INSERT`, `MERGE`, `COPY` | `--approve-data-mutation "<reason>"` |
| Unrecognised | Anything else: `GRANT`, `CREATE POLICY`, `CREATE FUNCTION`, `DO` blocks, `VACUUM`. Unknown SQL is never assumed safe. | `--approve-unclassified-sql "<reason>"` |
| Destructive | Any `DROP`, `TRUNCATE`, `DELETE`, column type changes, `SET NOT NULL`, and destructive SQL inside `DO` blocks | `--allow-destructive` plus a fully verified `--backup` plus `--restore-rehearsed "<note>"` |

Where it looks: `--sql <file-or-folder>` (searched recursively; a path that does not exist fails), otherwise `migrations/`, `db/migrations/`, `supabase/migrations/`, `prisma/migrations/`, `drizzle/`, and `src/db/migrations/`.

Use `--since <last-release-tag>` so only new and changed migration files are checked. Without it every migration file is checked, so an old `DROP` from months ago will block the release until you pass `--since`.

Limits: it reads `.sql` files only (migrations written in JavaScript or TypeScript are not checked), and the categories follow Postgres behaviour. Treat the categories as a prompt for review, not a guarantee.

### Rule 3: One step at a time, in order

* Run the project's own checks first (typecheck, lint, build, tests) and gate on their exit codes, not on piped output.
* Deploy the data and backend tier first. Make sure the API can serve both old and new clients, and that its readiness check (database, cache, workers) is healthy.
* Deploy the frontend second, and confirm it loads against the new backend.
* After the deploy, run smoke tests on the journeys that matter (sign-in, the main workflow, payments), then watch error rates and latency for 5 to 15 minutes. Decide your rollback trigger before you start.

### Rule 4: Trust the checklist, not the vibe

"It looks done" is not "it passed." An agent saying "tests are green" is only as trustworthy as the command it actually ran.

* Run the project's own verification command yourself. Never relay someone else's summary of it.
* Read warnings properly: an unpushed-commit warning before a push is expected; a test file the runner never picked up means tests were skipped. Fix it rather than ignoring it.
* Check the live product against real signals (readiness endpoint, HTTP status codes, real responses), never against what a conversation says.

### Rule 5: Keep human hands on the irreversible buttons

* The checker's fingerprint is reproducible: re-run it in CI with `--expect-digest <fingerprint>` and the job fails if the commit, uncommitted changes, migration files, or any stage's result differ from what was checked. It proves *what* was checked. It does not authorise anything.
* Authorisation belongs in your infrastructure, not in a script: keep production credentials out of the AI agent's environment, and require a human approver on the deploy job (for example a GitHub Environment with required reviewers).
* Preparation is delegated. Irreversibility is not.
