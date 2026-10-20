# Safe Deploy (wb4g-pipeline)

> **An open-source release protocol and pre-release checker from [We Build for Good](https://webuildforgood.com).**
> *Let AI do the preparation and the checking. Keep human hands on the irreversible buttons.*

---

## What it is

Two things in one repo:

1. **`SKILL.md`**: five release rules for people and AI coding agents (Claude Code, Cursor, Codex, Gemini). Read this first; it is the part that matters most.
2. **`bin/safe-deploy.mjs`**: a zero-dependency Node.js checker that runs the parts of those rules a machine can check. It never deploys anything.

## What the checker actually checks

* **Backups.** The file exists, is recent, and was written completely: plain and gzipped SQL dumps are streamed end to end and must finish with the dump tool's completion marker; `pg_dump -Fc` archives are checked with `pg_restore --list` when available.
* **SQL migrations.** Every statement is sorted into safe additive, risky additive, data change, unrecognised, or destructive. Each category present needs its own approval flag with a reason. Unknown SQL is never assumed safe. Destructive SQL also needs a fully verified backup and a note confirming you rehearsed restoring it.
* **Only what changed.** `--since <last-release-tag>` limits the migration check to files added or changed since your last release.
* **A reproducible fingerprint.** A SHA-256 of the commit, uncommitted changes, migration files, and each check's result. Re-run in CI with `--expect-digest` to confirm you are deploying exactly what was checked.
* **Optional extra checks**, run only when the sibling tools are installed: prior-art brief, invariants, visual audit, release packaging. When a tool is missing the stage says `NOT_RUN` and the result says `PASSED_WITH_GAPS`; it never claims a pass it did not earn.

What it does **not** do: deploy, apply migrations, restore your backup, check which database a backup came from, or read migrations written in JavaScript or TypeScript. Those stay with you (see `SKILL.md`).

---

## Usage

```bash
# Check a release: new migrations since the last tag, with a fresh backup
node bin/safe-deploy.mjs --since v1.3.0 --backup ./backups/prod.sql.gz

# Approve each risk type separately, with a reason
node bin/safe-deploy.mjs --since v1.3.0 --backup ./prod.sql.gz \
  --approve-risk "Index built on a staging copy in 4s" \
  --approve-data-mutation "Backfill batched in 500-row chunks" \
  --approve-unclassified-sql "Reviewed the new RLS policy"

# Destructive SQL (DROP, TRUNCATE, DELETE, type changes)
node bin/safe-deploy.mjs --since v1.3.0 --backup ./prod.sql.gz --allow-destructive \
  --restore-rehearsed "Restored into a scratch database; row counts match"

# A release with no database changes
node bin/safe-deploy.mjs --no-backup-required --skip-visual

# CI: fail on any gap, fail if the release differs from what was checked, print JSON
node bin/safe-deploy.mjs --since v1.3.0 --no-backup-required --strict --expect-digest <sha256> --json

# All options
node bin/safe-deploy.mjs --help
```

Exit codes: `0` passed, `1` a check failed, `2` bad command-line options. With `--json` the scorecard is printed on failure as well as on success.

---

## Installation

### As a CLI
```bash
git clone https://github.com/We-Build-For-Good/skill-safe-deploy.git
cd skill-safe-deploy
npm test
npm link   # installs wb4g-pipeline and wb4g-safe-deploy
```

### As a skill for Claude Code
```bash
git clone https://github.com/We-Build-For-Good/skill-safe-deploy.git ~/.claude/skills/safe-deploy
```

### As a skill for Gemini / Antigravity
```bash
git clone https://github.com/We-Build-For-Good/skill-safe-deploy.git ~/.gemini/config/skills/safe-deploy
```

---

## Tests

Zero dependencies; runs in any clean clone:

```bash
npm test
```

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT. Developed and maintained by [We Build for Good](https://webuildforgood.com).
