---
title: "AI Nudges in OneCamp: A Workspace That Remembers What You Promised"
image: "/assets/images/post/onecamp-nudges-improved.jpg"
author: "Akash Hadagali"
date: 2026-06-10 11:00:00 +0530
description: "Most software waits for you to remember. OneCamp's AI Nudges flip that — a quiet engine that notices the commitment you made in a Tuesday call, sees it's overdue, and taps you on the shoulder. Here's how I built it, why it stays out of your way, and the privacy line I refused to cross."
tags: ["OneCamp", "Go", "AI", "Productivity", "Nudges", "Architecture", "Self-Hosted", "PostgreSQL", "MQTT", "OpenSource"]
---

Here's a thing that happens to all of us.

You're in a call on Tuesday. Someone asks if the onboarding doc will be ready, and you say "yeah, I'll have it done by Thursday." Everyone nods. The call ends. Thursday comes and goes. Nobody wrote it down, including you, and the doc quietly doesn't exist until someone asks about it the following week — usually in front of the people you least wanted to disappoint.

The promise wasn't the problem. The *forgetting* was. And no tool helped, because every tool you use waits for you to remember to type the thing in.

That's the gap AI Nudges fill in OneCamp. The workspace already listens (with permission) and extracts the commitments people make in conversations. Nudges are the part that does something about it: a quiet engine that notices "you committed to X, it's past due, and you're the one on the hook," and gives you a gentle tap before it becomes a problem.

This post is how it works, why I made it deliberately calm, and the one design decision I'm most opinionated about.

---

## Push, Not Pull 🔔

Almost everything an AI assistant does is *pull*: you ask, it answers. "What did we decide yesterday?" "Summarize this thread." Useful — but it only helps when you already remember to ask.

Nudges are *push*. Nothing is asked. A periodic sweep looks at the state of your workspace and surfaces a short, actionable reminder to the person responsible. In the code, the comment I left for future-me says it plainly:

> The memory layer and connectors answer questions when ASKED. Nudges flip that to PUSH... This is the single feature that makes the product feel alive rather than inert.

Two rules ship today, and they map to the two ways promises actually rot:

- **Overdue commitments** — you said you'd do something, it had a due date, that date has passed.
- **Stale open questions** — a question got raised in a discussion and nobody's touched it in a week.

When the engine finds one of these for you, a nudge appears on the bell in your top nav, with a one-line reminder and a link straight to the thing.

---

## How the Engine Actually Runs ⚙️

The whole thing is a background loop in Go. It wakes up about 12 minutes after the server boots (so it isn't fighting the other AI workers for resources on startup), then runs every 30 minutes after that. And the very first thing it does on every tick is check whether it should even exist:

```go
if !settings.enabled || !settings.nudgesEnabled {
    return // feature off — silent no-op
}
```

If an admin never turned nudges on, the engine costs you nothing. That "pay nothing until you opt in" principle runs through the whole feature.

When it does run, it pulls every actionable item across the whole workspace in **one** batched query, groups them by who owns them, and evaluates the rules per person. A few things I cared about getting right:

- **No duplicate nagging.** Every potential nudge has a stable `dedup_key`. Re-running the sweep refreshes the existing nudge instead of stacking five copies of "you're late on the doc."
- **It cleans up after itself.** The moment you resolve a commitment — or dismiss it, or delete it — its nudge disappears. You don't get reminded about something you already handled.
- **It won't nag you about something you just dismissed.** If you wave a nudge away, that signal is suppressed for a few days. Persistence is good; pestering is not.
- **It runs once, even with multiple servers.** A per-window Redis lock makes the sweep idempotent, so overlapping ticks or a multi-instance deployment don't double-fire.

And critically: a nudge never blocks on the AI model. The reminder text comes from a deterministic template by default. There's an *optional* mode where a local LLM rephrases it into something friendlier, but that path is wrapped in a circuit breaker — if the model is slow or down, you get the template and the nudge still ships. The feature degrades to "still works," never to "hangs."

---

## The Line I Refused to Cross 🔒

Here's the design decision I'll defend hardest.

A commitment in OneCamp belongs to a place — a channel, a project, a DM. The person it's assigned to was a member of that place when the commitment was captured. But people leave channels. They change teams. They get removed from projects.

So before the engine pushes a nudge, it re-checks that the owner is *still* in the conversation that the commitment came from:

```go
// Before pushing a nudge we re-verify the owner is STILL in the
// item's channel/project/DM scope. Otherwise a nudge (with the item's
// content) would follow a user out of a conversation they've left,
// leaking it.
```

This matters more than it sounds. Without that check, a reminder — which quotes the original content — could chase someone into a channel they no longer belong to, leaking a snippet of a conversation they're not supposed to see anymore. The nudge engine fails *closed*: if it can't positively confirm you're still in scope, you don't get the nudge. Privacy wins over the reminder, every time.

It even self-heals. If it confirms an owner has genuinely left a conversation for good, it clears the ownership link so future sweeps don't waste time re-checking a ghost.

---

## Delivery: Two Paths, One Truth 📡

When a new nudge is created, it's delivered two ways at once:

1. **A saved row** in Postgres, so the bell shows it the next time you load OneCamp — even if you were offline when it fired.
2. **A live MQTT push** to your personal activity topic, so if you're already looking at the app, the badge ticks up in real time without a refresh.

The bell hydrates once from the database, then listens for live events. Open it and it re-fetches, so the list is always authoritative — covering the case where you dismissed something in another tab.

Notably, nudges deliberately **don't** email you. The daily memory digest already owns your inbox. Nudges are the in-app, real-time layer. Stacking another email channel on top would just train you to ignore both.

---

## The One Thing I Got Wrong (and Fixed) 🐛

Early on, clicking a nudge marked it as "acted" and made it vanish. Felt clean. It was actually wrong.

The problem: *viewing a reminder is not the same as handling the thing it reminds you about.* You'd click the nudge to see what it was about, it would disappear, and the commitment would still be sitting there overdue — leaving you with an empty bell and a false sense that you'd dealt with it.

So I changed the model. Now, clicking a nudge only *opens* it — it deep-links you to the exact item, scrolls to it, and highlights it. The nudge stays in the bell until you either resolve the underlying thing or explicitly dismiss it. That's the correct notification model: the reminder lives as long as the reason for it does.

---

## Where to Find It 🗺️

If your admin has enabled AI and nudges, you'll see a bell in the top navigation. A badge means something needs your attention; click it for the list. Each nudge has a one-liner and a "View" link that takes you straight to the commitment or question — not a generic list, the actual item.

Everything that powers it — the commitments it watches, the questions it tracks — comes from OneCamp's workspace memory layer, which runs on *your* server. The extraction happens on your Ollama instance or your own API key. The nudges are stored in your Postgres. Nothing about "what you promised and haven't done yet" is sitting in a SaaS vendor's analytics pipeline. For a feature this personal, that's not a footnote — it's the whole point.

---

## Is It Actually Useful? My Honest Take 🤔

I'll be straight: the usefulness of nudges is only as good as the commitments they're built on. If the AI extracts a commitment without an owner or without a due date, it can't nudge anyone — the reminder needs a *who* and a *when*. The concept, though — software that remembers your spoken promises so you don't have to — is one of the few genuinely new things a workspace can do once it owns chat, calls, and memory in one system. A chat-only tool structurally can't, because the promise was made in a call it never heard.

It's the difference between a tool you operate and a teammate who's paying attention. I'd rather build the second one.

OneCamp is available as a self-hosted lifetime purchase at [onemana.dev](https://onemana.dev/onecamp-product) — one payment, unlimited users, your server.

---

*Previous posts: [OneCamp Connectors: Gmail, Calendar, GitHub](/post/OneCamp-Connectors-Give-Your-AI-Access-to-Gmail-Calendar-GitHub.html) · [Slash Command App Platform](/post/How-I-Built-a-Slash-Command-App-Platform-for-OneCamp.html) · [AI-Agnostic Workspace with Active Memory Layering](/post/How-I-Built-an-AI-Agnostic-Workspace-with-Active-Memory-Layering.html) · [Building the Anti-SaaS Workspace](/post/I-Built-OneCamp-The-Anti-SaaS.html)*

*[Follow on Twitter](https://twitter.com/akashc777) for more updates.*
