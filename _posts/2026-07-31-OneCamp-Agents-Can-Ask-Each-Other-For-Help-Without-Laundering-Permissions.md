---
title: "Agents That Can Ask Each Other For Help — Without Laundering Permissions"
image: "/assets/images/post/onecamp-agent-delegation.jpg"
author: "Akash Hadagali"
date: 2026-07-31 16:00:00 +0530
description: "Your specialist agents couldn't talk to each other. Not by oversight — by a deliberate mute that stopped one agent replying to itself forever. This release replaces that blanket mute with a budget, so an agent can pull in the right specialist for part of a job. The interesting part is the constraint: every hop carries the person who started the chain, so a chain with no human at its root is refused. Also in here: why I decided not to implement A2A, and deleted the half I'd already built."
tags: ["OneCamp", "Go", "NextJS", "AI", "Agents", "Delegation", "Governance", "A2A", "Self-Hosted", "OpenSource"]
---
If you've built more than one agent in OneCamp, you've probably hit this and assumed it was a bug.

You have a research agent and a writing agent. You ask the writer to draft something and it needs the researcher's help. Nothing happens. The mention lands in the channel, looks completely normal, and the other agent never responds.

That wasn't a bug. It was a wall I put up on purpose, and this release replaces it with something better.

---

## Why Agents Were Muted In The First Place 🔇

When an agent posts a message, that write deliberately emits no "new message" event. The mention dispatcher runs off that event. No event, no dispatch — so an agent's message can never trigger another agent.

That mute exists for a good reason. Without it, the first agent that mentions itself in its own reply runs forever, and the first pair of agents that mention each other ping-pong until something falls over or your model bill arrives.

The problem is that a blanket mute is a very blunt instrument. It stops the runaway loop *and* it stops every legitimate case of one specialist asking another for help. It solved the failure mode by removing the capability.

So the mute is gone, and what replaces it is a **budget**.

---

## Delegation With a Ceiling 📊

An agent can now mention another agent and get a response. What keeps that from becoming a runaway is a set of limits, not a prohibition:

- **A depth limit** — a chain can only go so many hops deep.
- **A per-chain budget** — total agent work in one delegation chain is capped.
- **Cycle detection by identity** — this is the important one. Limiting depth alone isn't enough, because two agents mentioning each other back and forth would burn the entire budget before the depth limit noticed anything was wrong. OneCamp tracks *which agents* are already in the chain, so a loop is refused the moment it closes rather than after it has spent everything.

The result is that "ask the specialist" works, and "spiral forever" doesn't.

---

## The Constraint I Care About Most 🔐

Here's the part I think is genuinely different, and it's a governance property rather than a capability.

**Every hop carries the person who started the chain.**

When you ask the writing agent for a draft, and it asks the research agent for help, and that agent queries a database — the database query runs with **your** permissions. Not the writing agent's. Not some accumulated union of every agent in the chain. Yours.

And a chain with **no human at its root is refused outright.**

That closes a hole I want to name plainly, because it's the thing that goes wrong in multi-agent systems and it isn't obvious until you look for it. Call it **privilege laundering**. Agent A can reach system X. Agent B can reach system Y. If A can ask B for things, then A effectively reaches Y — and nobody ever granted that. Chain a few agents together and you've assembled a set of permissions no human in your workspace actually has, without a single permission being changed.

Carrying the originating person through every hop means an agent action always traces back to somebody who **could have taken it themselves**. Delegation moves work around. It never manufactures access.

The practical version: the agent work row now shows **who asked**. When you find a delegated run in a channel, you can see the human accountable for it, not just which robot did it.

---

## Admins Decide, Not Environment Variables ⚙️

Agent collaboration is off until you turn it on, and you turn it on in the product — **Admin → AI → Agents**, with a real UI for the policy, including the depth and budget limits.

It used to be an environment variable, which meant enabling it required a deploy and understanding it required reading a config file. The environment variable still exists, but it's been demoted to a kill switch: something you reach for when you need collaboration off *now* and don't want to wait for a UI round trip.

That ordering matters to me. Governance controls that live only in env vars are governance controls that nobody can audit and only one person can change.

---

## What I Decided *Not* To Build: A2A 🚫

While building delegation I also built most of an A2A implementation — Google's Agent2Agent protocol, the emerging standard for agents from different vendors discovering and working with each other. Agent Cards describing what each OneCamp agent can do, an admin preview to inspect a card before publishing it.

Then I deleted it. Not shelved behind a flag — removed, with the reasoning written down in the repo.

Two reasons, and both come from what OneCamp actually is.

**Publishing capability cards is a disclosure surface.** An Agent Card describes your agents, their skills, and by implication your internal structure. For a product whose entire proposition is "your data stays on infrastructure you own," standing up an endpoint that broadcasts a description of your internal tooling runs against the grain of the thing people chose it for.

**Inbound A2A work has no principal.** Everything above rests on one invariant: every action traces to a person who could have taken it themselves. An external agent arriving over A2A has no OneCamp member identity. To let it do anything I'd have to either invent a synthetic principal — which is exactly the privilege laundering I just spent a release closing — or refuse it, at which point the protocol does nothing.

And there's a less philosophical reason: the interoperability need is **already served**. OneCamp has scoped API tokens and an MCP endpoint. An external system can already work with your workspace, authenticated as a real principal with real permissions and a real audit trail. A2A would have added a second door with weaker guarantees.

I'm noting this partly because I think "what we chose not to ship, and why" is more useful than another feature list. Keeping a half-built protocol around as dead code is also its own risk — it looks finished enough that someone wires it up later, two lines from being exposed.

---

## How To Use It 🚀

**Turn on collaboration (admin).** **Admin → AI → Agents → collaboration policy**. Start with a shallow depth limit and a small budget; widen once you've watched a few chains run.

**Build for it.** Give each agent a narrow job and a clear description. Delegation works best when the agent being asked is obviously the right one to ask — same as with people.

**Watch what happens.** Delegated runs appear in the channel like any other agent work, with **who asked** on the row. Every run remains stoppable and steerable from the thread.

**Kill it fast if you need to.** The environment kill switch turns collaboration off without waiting for a UI change to propagate.

---

*OneCamp is an open-source, self-hosted, AI-era workspace: chat, docs, tasks, projects, calls, boards, tables, a programmable API, and AI teammates that can see, calculate, run code, query your databases, read your documents, open pull requests, and now ask each other for help — with every action still traceable to a person who could have taken it themselves.*
