# Changelog

## 2.0.0 (2026-10-20)

Fixes from an independent review. Every item below has a regression test that failed on 1.4.0.

### Safety fixes
- **Approvals are now truly separate.** 1.4.0 gave each migration file a single label, so a later statement could hide an earlier one (unrecognised SQL followed by `CREATE INDEX` was approved by `--allow-risky-migrations`; approving unrecognised SQL also approved an `UPDATE` in the same file). Every risk category present now needs its own approval.
- **`--allow-destructive` requires a fully verified backup and `--restore-rehearsed`.** 1.4.0 accepted `--allow-destructive --no-backup-required`.
- **No more silent passes:** migrations in subfolders (Prisma layout) are found; a `--sql` path that does not exist fails; a sibling tool that runs and fails now fails the release instead of being replaced by a weaker fallback check.
- **Backup checks are real:** dumps must end with the dump tool's completion marker (truncated dumps failed to be caught before), backups older than 24 hours are rejected, unknown formats are rejected, `pg_dump -Fc` archives are checked with `pg_restore --list`, and files are streamed so large backups work.
- **Postgres `$$` bodies are parsed:** function bodies no longer trigger false DESTRUCTIVE results, and destructive SQL inside `DO` blocks is now caught.

### Behaviour changes
- `--since <ref>` checks only migrations changed since your last release. Without it, every migration is checked (so an old `DROP` blocks until you pass `--since`).
- The built-in em dash scan is removed. It enforced one team's writing style on every user's repository. Style rules belong in the invariant engine, which you opt into.
- Missing optional tools report `NOT_RUN` and the result is `PASSED_WITH_GAPS`; `--strict` turns gaps into failures.
- Constant column defaults are safe additive (Postgres 11+); computed defaults are risky.
- Unknown flags and missing values exit with code 2 instead of being ignored; `--flag=value` works.
- `--json` prints the scorecard on failure too, with `failedStage`.
- Migration statuses: `PASSED_WITH_RISK_OVERRIDE`, `PASSED_WITH_MUTATION_APPROVAL`, `PASSED_WITH_UNCLASSIFIED_APPROVAL`, and `PASSED_WITH_GOVERNED_APPROVAL` are replaced by `PASSED_WITH_APPROVALS` with an `approvals` record.

### Honesty fixes
- The fingerprint no longer includes a timestamp, so CI can reproduce it, and it now covers uncommitted changes. New `--expect-digest` makes it enforceable.
- Removed printed claims the tool cannot check (for example that the agent has no production credentials) and the "ALL GATES PASSED" banner when gates were skipped.
