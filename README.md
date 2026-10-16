# Safe Deploy: The Production Release Protocol

> **An open-source AI engineering protocol from [We Build for Good](https://webuildforgood.com)**  
> *Let AI do the preparation. Keep releases boring.*

---

## Overview

`safe-deploy` is an operational protocol for AI coding assistants (Claude Code, Cursor, Antigravity, OpenAI Codex). 

It governs how an AI agent prepares, verifies, and executes software releases to production environments.

The protocol is designed around a single principle: **AI agents prepare and verify everything; human operators press the irreversible buttons.**

---

## Why This Exists

Letting an autonomous coding agent touch a live production application is one of the highest-risk moments in modern software development. Without strict procedural guardrails, agents can:
* Trigger migrations that drop production columns or lock critical tables.
* Ship frontend code before backend APIs have been updated.
* Trust piped command outputs that mask failure exit codes.
* Deploy unverified code without a restorable database backup.

`safe-deploy` turns a stressful release into a predictable, five-step verified sequence where nothing can go wrong that you cannot immediately undo.

---

## The Five Safety Rules

1. **Take a Photo First**: If the release touches persistent data, take a fresh database backup and prove it is non-empty before touching code.
2. **Guard the One Door You Cannot Reopen**: Inspect raw migration SQL. Additive changes are safe; destructive DDL (`DROP`, `TRUNCATE`, `ALTER ... DROP`) triggers an immediate halt and requires human sign-off.
3. **One Step at a Time, In Order**: Data and backend tier first; confirm health check 200 OK; frontend tier second.
4. **Trust the Checklist, Not the Vibe**: Gate strictly on unpiped process exit codes (`$?`). Verify the live URL against real HTTP status checks, not conversational assertions.
5. **Human on Irreversible Buttons**: The AI drafts the exact terminal command. The human executes it.

---

## Installation

### For Claude Code
Clone or copy this folder into your skills directory:
```bash
git clone https://github.com/We-Build-For-Good/skill-safe-deploy.git ~/.claude/skills/safe-deploy
```

### For Cursor
Add this skill to your workspace skills directory:
```bash
mkdir -p .cursor/skills
git clone https://github.com/We-Build-For-Good/skill-safe-deploy.git .cursor/skills/safe-deploy
```

### For Antigravity / Open Agent Skills
```bash
mkdir -p .agents/skills
git clone https://github.com/We-Build-For-Good/skill-safe-deploy.git .agents/skills/safe-deploy
```

---

## Usage

Once installed, invoke the skill whenever you are preparing a release:
* *"Prepare a safe deploy for the main branch."*
* *"Ship this release to production."*
* *"We have database migrations to run: follow safe-deploy."*

The AI assistant will immediately establish ground truth, classify migrations, draft backup commands, and guide you through the verified release gates.

---

## License

MIT License. Developed and maintained by [We Build for Good](https://webuildforgood.com).
