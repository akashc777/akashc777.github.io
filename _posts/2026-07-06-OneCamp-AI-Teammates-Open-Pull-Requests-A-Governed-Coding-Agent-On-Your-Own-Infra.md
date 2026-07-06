---
title: "OneCamp AI Teammates Open Pull Requests: A Coding Agent That Ships on Your Own Infra, Not Someone Else's Cloud"
image: "/assets/images/post/onecamp-ai-code-pr.jpg"
author: "Akash Hadagali"
date: 2026-07-06 10:00:00 +0530
description: "This week OneCamp's agents learned to write code and open a pull request, the same way you'd hand the job to a teammate: @mention one, describe the change, and it clones the repo, edits, builds, tests, and opens a PR for a human to review. The interesting part isn't that it can, everyone's agent can now. It's where it runs: on infrastructure you own, through the model you choose, inside a network-locked sandbox, with the same approvals, budgets, audit trail, and a reliability scorecard that learns from whether your PRs actually merged. Here's how it works, and an honest read on where it stands next to Spotify's Honk and Anthropic's Claude Code."
tags: ["OneCamp", "Go", "NextJS", "AI", "Agents", "CodePR", "GitHub", "Sandbox", "Governance", "Self-Hosted", "OpenSource"]
---

For the last few weeks these posts have followed one thread: turning OneCamp's AI from a chatbot that answers into a teammate that does the work. It got a place in the room (agents live in your channels and DMs), then governance you can audit (approvals, budgets, a tamper-evident log, an eval harness), then senses and skills (it can see an image, reason over your tables, run code in a sandbox, follow a PR through CI).

There was always one job left that separates "assistant" from "engineer on the team": **actually writing the code and opening the pull request.**

This week it does. You @mention an agent, tell it what you want, and it goes off, clones the repo, makes the change, builds it, runs the tests, and opens a PR with a human's name on the review. Then it comes back to the thread and tells you what it did and whether the checks passed.

That capability, on its own, is no longer rare. Anthropic's Claude does it. Spotify's internal agent does it thousands of times a month. So the honest question isn't "can OneCamp do it too" (it can). It's **where and how it does it**, and that's the whole story of this post.

---

## What It Feels Like to Use 💬

The interaction is deliberately boring, in the good way. It looks exactly like assigning work to a person:

> **You:** @Builder can you add a `--dry-run` flag to the import CLI so it prints what it *would* do without writing anything?
>
> **Builder:** On it. Cloning `acme/backend`, working on a branch off `main`…
>
> **Builder:** Opened **PR #482 — Add `--dry-run` to import CLI**. Touched 3 files, added a test, `go build` and `go test ./cli/...` both pass. It's a draft for your review, I didn't merge anything.

No terminal. No new tool to learn. The agent replies **in the thread** where you asked, the same way it does for every other kind of work, and the pull request shows up on GitHub for a human to read, approve, and merge. The agent never merges its own code. It writes; you decide what ships.

Under that calm surface, a run goes through real stages: clone (shallow and sparse, so a huge repo doesn't mean a huge download) → understand the relevant files → make guarded, whole-file edits → **detect the build system and actually build and test** → push a branch (never a force-push, never to `main`) → open the PR. If the build breaks, it sees the failure and tries to fix it, rather than cheerfully opening a PR that doesn't compile. And if it genuinely can't get there, it says so in the thread instead of opening junk.

---

## The Part That Actually Matters: Where the Code Runs 🔒

Here's the thing about letting an AI write code: for it to work, the agent has to *execute* things, clone your private repo, run your build, run your tests. That means model-written code is running somewhere, touching your source. The only question that matters is **whose machine that happens on.**

With the popular cloud options, the answer is "someone else's." Your repo gets cloned into a vendor's managed environment, your code runs there, and you trust their boundary. For a lot of teams that's fine. For a bank, a hospital, a defense contractor, or anyone under data-residency rules, it's a non-starter, the exact reason they can't use half the AI tooling their competitors can.

OneCamp's coding agent runs in a sandbox **you** host, and I spent most of this week on that boundary because it's the whole point:

- **It runs in an isolated runner sidecar**, not in the app process, over a narrow HTTP contract. Model-written code never executes anywhere near your server's privileges.
- **The runner has no direct route to the internet.** It sits on an internal-only network. Its git traffic is forced through a **default-deny egress proxy** that only allows the git host you allowlisted, so even if the code it's running tries to phone home, exfiltrate your source, or pull a malicious dependency from a random host, there's nowhere for the packet to go. I verify that with a containment smoke check that has to pass before the feature can be turned on: the git host is reachable, *everything else is refused*, and there's no direct internet at all.
- **Credentials are never written to disk.** The git token is passed per-command and never persisted into the repo's `.git/config`, so a checked-out working tree can't leak it.
- **It's off by default, behind two deliberate gates.** An operator has to deploy the coding profile (an infrastructure decision) *and* an admin has to enable it with a runner URL and token (a policy decision). Neither alone flips it on. That's not friction for its own sake, it's the difference between "a capability exists in the codebase" and "this capability is live in your workspace," and those should never be the same switch.

Because it's self-hosted, "the AI wrote some code" doesn't mean your proprietary source took a trip to a third party. The powerful version and the contained version are the same version.

---

## It Doesn't Start From Zero: Context Fusion 🧠

A generic coding agent reads the repo and guesses at your conventions. OneCamp's agent starts with something a cloud tool structurally can't have: **the context of the conversation that spawned it, and your workspace's own memory.**

When you @mention it to fix a bug, it pulls in, all permission-scoped, so it only ever sees what *you* could see:

- **The originating thread.** The back-and-forth where you described the problem is part of what it reads, not just the one-line instruction.
- **Workspace memory.** The decisions and glossary your team has accumulated in OneCamp, "we don't use ORMs here," "auth always goes through the middleware," become steering for the change, so it writes code that looks like *your* code.
- **The agent's own scoped memory.** Standing instructions you've given that agent carry through.

The agent that writes your PR already knows why you asked, what your team decided last month, and how you like things done. That's context a GitHub-side or Slack-side bot doesn't get, because that context lives in your workspace, and your workspace is the thing OneCamp *is*.

---

## Governance, Because It's Writing Code Now 🔐

Everything the earlier governance work bought us applies here, and it matters more when the output is a pull request:

- **The same approval, budget, and audit machinery.** A coding run is metered against the agent, user, channel, and workspace token budgets you already set, whichever cap is tightest wins, so a runaway loop can't quietly run up a bill. Every run is attributed and lands in the tamper-evident audit log.
- **A reliability scorecard that *learns*.** This is the piece I'm most interested in. OneCamp records the outcome of each PR the agent opened, via GitHub's webhook, it knows whether the PR was **merged or closed unmerged**. That's not vanity metrics; it's a feedback signal. The scorecard shows you the agent's real merge rate and recent runs, and the agent distills what worked into learned steering for next time. An agent that opens PRs nobody merges is a measurable problem, not a vibe.
- **Model-agnostic, all the way down.** The coding agent routes through whatever model your workspace is configured for, a frontier cloud model when you want maximum quality, or a local model when the code can't leave the building. The runner asks OneCamp's own LLM proxy, which is model-neutral and metered. You're never locked to one vendor's model to get one vendor's coding feature.

---

## An Honest Comparison: Honk, Claude Code, and OneCamp ⚖️

You asked how OneCamp stacks up against Spotify's Honk and Anthropic's Claude, so here's the straight version, not the marketing one.

**Spotify's Honk** is genuinely impressive and I won't pretend otherwise. It's their internal background coding agent, built on [Claude Code and the Claude Agent SDK on top of their Fleet Management platform](https://www.engineering.atspotify.com/2025/11/context-engineering-background-coding-agents-part-2), and by their own numbers it merges on the order of [1,000 pull requests every 10 days](https://confidence.spotify.com/blog/when-ai-writes-the-code) across thousands of repos. That's a staggering track record. Two things to be clear-eyed about, though: it's the product of [15 years of internal infrastructure](https://www.ninetwothree.co/blog/honk-spotify-ai-infrastructure) most companies don't have, and **you can't buy it**, it's Spotify-internal, purpose-built for large-scale migrations across their own fleet.

**Anthropic's Claude** (tag `@claude` on a GitHub PR or in Slack) is the productized, buyable version: [mention it and it reads the context, proposes changes, pushes commits, and replies in-thread](https://claude.com/blog/claude-code-and-slack), with a link to open a PR. It's excellent, and it's the raw-quality bar to beat. Its trade is the one every cloud agent makes: your code runs in Anthropic-managed cloud infrastructure, and you're using Anthropic's model to do it.

**Where OneCamp honestly stands:**

- **On mechanics, we're at parity.** @mention → clone → edit → build → test → PR, in-thread status, human-reviewed merge. The loop is the same shape as the others.
- **On proven raw code quality and track record, the cloud tools are ahead, and I'm not going to claim otherwise.** Honk has thousands of merged PRs; Claude is a frontier lab's flagship. OneCamp's agent is new, and merge-rate proof is something you *earn* with real PRs, not something you assert in a blog post. That's exactly why I built the scorecard and the learning loop first, so quality is *measured*, not promised.
- **On sovereignty, governance, and model choice, OneCamp is genuinely ahead, and for a lot of teams that's the only column that decides it.** Nobody else runs a `@mention → verified PR` agent *entirely on your own hardware*, through *your choice of model* (including a fully local one), inside a *network-locked sandbox*, with *per-agent/channel/workspace budgets*, a *verifiable audit log*, and an *outcome-based reliability scorecard*. If your code legally cannot leave your building, the frontier cloud agents aren't an option at any quality, and OneCamp is.

So: is OneCamp "better than" Honk and Claude Code? Not at raw code quality today, and I'd rather tell you that than sell you a number I can't back. But for the team that needs the coding agent to run where the data lives, on the model they trust, with governance they can audit, OneCamp isn't just competitive, it's one of the only answers. It's **the governed, self-hosted coding agent.** That's the lane, and it's a lane the cloud tools structurally can't enter.

---

## How To Use It 🚀

**Deploy the runner (operator).** Bring up the coding profile alongside your stack, then run the containment smoke check, it must pass (git host reachable, everything else blocked, no direct internet) before you go further. The playbook is in `CODING.md`.

**Enable it (admin).** In **Admin → AI → Code pull requests**, enter the runner URL and token and save; the enable toggle unlocks once a runner is configured. Hit **Test runner** to confirm the round-trip works.

**Give an agent the skill.** Add the `code_pr` capability to an engineering agent in the builder, keep it in *Require approval* mode to start.

**Use it like a teammate.** @mention the agent in a channel and describe the change in plain language. It replies in-thread with progress, opens a **draft PR** for review, and reports whether the build and tests passed. You review and merge, it never does.

**Watch the scorecard.** From the reliability panel, track the agent's real merge rate and recent runs. Start with one low-stakes, well-tested repo and a strong model; widen the blast radius only once the numbers earn it.

---

*OneCamp is an open-source, self-hosted, AI-era workspace: chat, docs, tasks, projects, calls, boards, tables, a programmable API, and AI teammates that can now see, calculate, run code, and open pull requests, all on infrastructure you own, through the model you choose.*
