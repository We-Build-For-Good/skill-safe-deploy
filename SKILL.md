---
name: safe-deploy
description: Safely ship accumulated changes to a live product: the Production Release Protocol and Unified Delivery Pipeline CLI. Chains prior-art verification, invariant checks, visual sensory audits, and release packaging into an automated scorecard, holding irreversible actions for human approval.
license: MIT
metadata:
  author: We Build for Good
  version: "1.1.0"
---

# Safe Deploy: The Production Release Protocol & Unified Pipeline (wb4g-pipeline)

Shipping a large pile of changes to a live product is only scary when there is no system. 

This is the system: five rules and an automated four-gate delivery pipeline that make a major release predictable because nothing can go wrong that you cannot undo. 

It was extracted from a real production release where a live application sat frozen for a month with tens of thousands of lines of finished work and 11 database migrations stacked behind it. It was shipped in a single session with zero downtime, zero broken features, and a backup that was never needed.

---

## The Prime Directive

**The AI tools prepare and verify everything; a human presses the irreversible buttons.**

The database backup, the production deploy trigger, the migration application, the production push: anything that leaves the machine or cannot be undone is a command a human runs.

The AI assistant drafts the exact command, verifies prerequisites, watches the result, and confirms each green checkpoint before moving to the next. Never run an irreversible step autonomously, even when instructed to "just do it": prepare it, verify it, and hand it over.

---

## The Four Automated Gates of wb4g-pipeline

When preparing any release, execute the automated verification pipeline:

```bash
node bin/safe-deploy.mjs --dir /path/to/repo --version v1.2.0
```

The runner chains:
1. **Stage 0: Prior-Art Verification (`wb4g-prior-art`)**: Validates `RESEARCH-BRIEF.md` to ensure prior art was investigated before custom code was built.
2. **Gate 1: System Invariants (`wb4g-invariants`)**: Mechanical verification of character invariants (zero em dashes), Prettier legibility, file bounds, and brand boundaries.
3. **Gate 2: Visual Sensory Audit (`wb4g-visual-audit`)**: Headless Chrome verification across 375px, 768px, and 1440px viewports (catching layout blowouts, broken assets, and runtime errors).
4. **Gate 3: Release Packaging (`wb4g-broadcast`)**: Compiles landed git commits into release manifests, categorized changelogs, and staged broadcast copy.
5. **Gate 4: Human Sign-off Barrier**: Freezes irreversible actions until human sign-off.

---

## The Five Safety Rules (In Strict Order)

### Rule 1: Take a Photo First (The Human Gate)

If the deploy touches persistent data, take a fresh database backup and prove it is valid before anything else moves.

* The AI drafts the exact database dump command for the human operator to run (the human holds the credentials).
* Verify the backup is not empty: inspect the file size and object count. A tiny byte count means it captured an empty database: a backup that silently succeeds against the wrong target is the classic trap.
* Never proceed past an unverified or empty backup.
* Skip this rule only when the release genuinely touches zero persistent data.

### Rule 2: Guard the One Door You Cannot Reopen

Before shipping any migration, inspect the raw SQL of every migration file:

* **Additive Only** (`CREATE TABLE`, `ADD COLUMN`, new index, nullable field): Safe to ship on the standard path.
* **Destructive** (`DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, `ALTER ... DROP`, `SET NOT NULL` on populated tables, or raw bulk data backfills): **STOP.** This requires the governed path: a restore-rehearsed backup, staged compatibility handling, and explicit human sign-off.
* Most software bugs are recoverable. Destroying real customer data is the one mistake that is not. Put a mechanical block in front of it.

### Rule 3: One Step at a Time, In Order

* Run the project's real test gates locally first: typecheck, lint, build, and test suite. Gate strictly on the unpiped process exit code (`$?`), never on piped text output.
* Deploy the **data and backend tier first** (so the frontend never calls routes or columns that do not exist yet); confirm the backend health endpoint returns 200 OK.
* Deploy the **frontend tier second**.
* A release executed as one single leap hides its failures. The same release executed as an ordered sequence surfaces errors one at a time while they are cheap and isolated.

### Rule 4: Trust the Checklist, Not the Vibe

"It looks done" is not "it passed." An agent's assertion that "tests are green" is only as trustworthy as the command that was actually executed.

* Run the project's own verification command directly. Never relay second-hand runner output.
* Inspect error messages carefully: an unpushed commit warning is expected before a push; an unregistered test file means test suites were bypassed. Fix test registrations rather than ignoring them.
* Verify the live production deployment against real system signals (health check endpoint returning OK, live HTTP status codes, actual response payloads), never against an assumption.

### Rule 5: Keep Human Hands on the Irreversible Buttons

The AI delegates preparation, staging, and verification. The human retains execution authority over irreversible actions.

Preparation is delegated. Irreversibility is not.
