# Safe Deploy: Unified Studio Delivery Pipeline (wb4g-pipeline)

> **An open-source AI engineering protocol and delivery engine from [We Build for Good](https://webuildforgood.com)**  
> *Let AI do the preparation and multi-gate verification. Keep human hands on the irreversible buttons.*

---

## Overview

`safe-deploy` (`wb4g-pipeline`) is the unified delivery and release verification pipeline for software engineers, product leads, and autonomous AI agents (Antigravity, Claude Code, Cursor, Codex).

It chains the four deterministic verification gates of our autonomous studio into a single execution pass:
1. **Stage 0: Prior-Art Verification (`wb4g-prior-art`)**: Verifies evidence-backed research and build decisions before shipping.
2. **Gate 1: System Invariants Engine (`wb4g-invariants`)**: Enforces character invariants (zero em dashes), Prettier legibility, brand boundaries, and file bounds.
3. **Gate 2: Visual Sensory Audit (`wb4g-visual-audit`)**: Drives headless Chrome across 375px, 768px, and 1440px viewports to detect layout blowouts, broken media, touch collisions, and console errors.
4. **Gate 3: Release & Broadcast Packaging (`wb4g-broadcast`)**: Compiles git commits into manifests, changelogs, and staged customer announcement drafts.
5. **Gate 4: Human Sign-Off Barrier (Rule 5)**: Mechanically holds irreversible production deployments and broadcast transmissions until human approval is given.

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

# Run pipeline for a backend repository (skipping visual browser audit)
node bin/safe-deploy.mjs --skip-visual

# Output structured scorecard JSON for CI/CD integration
node bin/safe-deploy.mjs --json
```

---

## The Five Safety Rules

1. **Take a Photo First**: If the release touches persistent data, take a fresh database backup and prove it is non-empty before touching code.
2. **Guard the One Door You Cannot Reopen**: Inspect raw migration SQL. Additive changes are safe; destructive DDL (`DROP`, `TRUNCATE`, `ALTER ... DROP`) triggers an immediate halt and requires human sign-off.
3. **One Step at a Time, In Order**: Data and backend tier first; confirm health check 200 OK; frontend tier second.
4. **Trust the Checklist, Not the Vibe**: Gate strictly on unpiped process exit codes (`$?`). Verify the live URL against real HTTP status checks, not conversational assertions.
5. **Human on Irreversible Buttons**: The AI drafts the exact terminal command. The human executes it.

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

```bash
node --test test/*.test.mjs
```

---

## License

MIT License. Developed and maintained by [We Build for Good](https://webuildforgood.com).
