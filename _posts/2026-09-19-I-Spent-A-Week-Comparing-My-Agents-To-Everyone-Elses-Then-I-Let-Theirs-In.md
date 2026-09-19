---
title: "I Spent A Week Comparing My Agents To Everyone Else's. Then I Let Theirs In."
image: "/assets/images/post/onecamp-remote-agents.jpg"
author: "Akash Hadagali"
date: 2026-09-19 10:00:00 +0530
description: "The new crop of AI coworkers can do things mine cannot, and I went looking for what. The answer was not a feature. It was that they accept an agent built anywhere, and I only accepted my own. So a OneCamp agent can now reason at somebody else's endpoint and still work under my workspace's rules, which cost me one adapter instead of a second agent loop. Then I read the protocol properly and found three bugs I had shipped."
tags: ["OneCamp", "AI Agents", "AG-UI", "Interop", "Governance", "Self-Hosted", "OpenSource"]
---

If you're new here: [OneCamp](https://onemana.dev/buy) is an open-source, self-hosted workspace (chat, docs, tasks, projects, calls, boards, tables, an API) that runs on **your** infrastructure. I build it, sell it, and operate the demo.

This summer a new shape of product arrived: the AI coworker that gets a computer of its own. A browser it drives, a shell it runs, logins it holds. I spent a week with them, including reading one of them line by line, because I wanted an honest answer to a question I had been avoiding.

**What can they do that mine cannot?**

## The honest list

Four things, and none of them are marketing.

**They own a machine.** My agents act through tools I wrote. Theirs open a browser, log in as you, and click. That is a genuinely larger surface, and I am not going to pretend otherwise.

**You can take the wheel.** When the agent gets stuck on a page, a person can drop into the same session, do the tricky bit by hand, and hand it back. Mine can stop and ask you a question. It cannot hand you the mouse.

**They answer with components, not paragraphs.** A table renders as a table. A chart renders as a chart.

**And they take any agent you have already built.** This is the one that mattered.

That last one works because of a protocol called [AG-UI](https://docs.ag-ui.com/concepts/events). An agent written with LangGraph, CrewAI, Mastra, Pydantic AI, Google's ADK or by hand all arrive the same way: one request carrying the conversation and the tools on offer, answered with a stream of events carrying text and tool calls back. [OpenBot](https://www.copilotkit.ai/blog/openbot-updates-v0.0.5), the open-source one I read, passed 3,500 GitHub stars in its first fortnight.

## What I had that they did not

I did this half of the list too, because a comparison where you only win is a comparison you did wrong.

Mine live **inside a workspace**. An agent's permissions are not configured, they are the live membership of the person it acts for. If you lose access to a channel this afternoon, its agent loses it this afternoon, with no policy to update.

Every action is **written to a hash-chained audit log before it happens**, and a write that fails refuses the action. There is a retention floor, an evidence pack, and an export where every row carries the hash of the row before it. There is a **local-only mode** where no content leaves your network. There is an **AI-free edition** for the buyers who want none of this. And it is one payment for unlimited users on your own server.

So: they had reach, I had a record.

## The move I did not make

The obvious response is to build the missing features. Give my agents a browser. Build take-the-wheel.

I did something smaller. **I let their agents in.**

Here is the thing about AG-UI that decided it. The remote agent publishes no tools of its own. Every tool comes from the caller. It is handed a list, it decides which one to call, and it ends its run to ask for it.

That is not a foreign shape. **That is exactly the shape of my own agent loop.** My runner hands a model a list of tools, the model asks for one, and the call goes through the allow-list, the scope check, the autonomy gate, the destructive-action backstop and the audit row before anything happens.

So the remote agent is not a new kind of thing in OneCamp. It is a **provider**, in the slot where a model goes.

## Which means the rules are not copied, they are unavoidable

This is the whole argument, so let me be concrete.

You point a OneCamp agent at an AG-UI endpoint. That agent's reasoning now happens on somebody else's machine, with somebody else's model, in somebody else's framework. Everything after the reasoning is mine: which tools it may call, which channels and projects it may touch, whether a write needs a human to approve it, whether a destructive action gets queued regardless of autonomy level, and the row in the audit log that gets written before the action rather than after.

There is no second code path to keep in sync, because there is no second code path.

Here is the run I used to check it, against a throwaway agent I wrote for the purpose. The agent is allowed `web_search` and nothing else. The remote asked to send a direct message.

```
step 1  browser_open   remote   result: opened example.com on my machine
        send_dm        local    skipped: tool not permitted for this agent
                                governance: blocked
step 2  "The workspace answered my send_dm with:
         skipped: tool not permitted for this agent"
```

Two things in there are worth more than the feature.

**The refusal went back to the remote as a tool result**, so it knew, corrected itself and said so. It did not silently fail and narrate a success.

**The `browser_open` line is marked `remote`.** That is work the agent did on its own computer. I did not run it, and I could not have refused it. It is in the transcript because leaving it out would make the record incomplete, and it is marked because pretending I governed it would be a lie. It is also excluded from the count of actions this workspace took, for the same reason.

The audit row for that run carries `remote_brain: agui:bots.example.com`. The host and nothing else: the path can carry a routing token and the secret never goes near a row that lives forever.

## Then I read the specification properly and found three bugs

I built this from the protocol's shape and one reference implementation. Afterwards I sat down with the actual event list, which is the correct order to do those two things in and not the order I did them in.

**The state was silently freezing.** AG-UI carries an agent's own scratchpad two ways: a whole snapshot, or a patch against the last one. The frameworks with shared-state features lean on patches. My client read snapshots and dropped patches.

The cause is the nicest bug I have hit this year. One field name, `delta`, carries two types. On a text event it is a string. On a state event it is a JSON Patch array. I had typed it as a string in Go, so a state patch failed to decode, and my code skipped events it could not decode, which is a sensible rule that here meant an agent's state froze at the first snapshot and it was handed back a document it never wrote for the rest of the run.

Nothing errored. Nothing logged. The type declaration was the bug.

**A remote that answers on the end-of-run event got silence.** The protocol lets a run carry its result on `RUN_FINISHED` instead of streaming it. My client returned an empty reply, which is precisely the failure the rest of that file exists to prevent.

**And I had three copies of an SSE reader.** The MCP client had grown its own, I wrote another, and only one of them handled multi-line frames correctly. That is now one function, and the MCP one stops at the reply it came for instead of draining the rest of the stream, which it had never had a test for in the first place.

## The one I should have built first

An admin pastes an endpoint and a secret, saves, and finds out whether it works from a failed run somebody notices later.

There is now a **Test connection** button next to the field. It runs the real client against the real endpoint with the real credential, so what it proves is what a run would do. It reports what came back: the remote's own reply, or `remote answered 401`, or, if you typed a cloud metadata address, that the address is blocked and why. An agent you have already saved is tested without retyping a secret the client never sees, because the server still has it.

While I was in there I fixed a quieter dishonesty. Every agent has a daily token limit. For a remote agent that limit did nothing, because the model spend happens on somebody else's account and this workspace cannot see it. The field now says so.

## What this is actually for

Two kinds of buyer, and they want opposite things.

The one who has already built an agent, in the framework their team knows, does not want to rebuild it in my builder. They want somewhere it can act that keeps a record.

The one who has not built anything wants agents that work out of the box, which is what the builder has always been for.

Before this, I was asking the first buyer to throw their work away. Now the pitch to them is one sentence: **bring the agent you built, and it works under your workspace's rules.**

## Still open

The list where I am honest, because a changelog with only wins is an advert.

**I cannot meter what the remote spends.** Its model calls happen on its account. The per-agent daily token cap does not apply, and saying so in the interface is honesty, not a solution. If I want a real ceiling on a remote agent it has to be counted in runs or calls rather than tokens, and I have not built that.

**No take-the-wheel.** A person still cannot drop into a remote agent's browser session mid-run, because it is not my browser session. What a person can do is interrupt, steer and stop the run, which I shipped earlier and which still applies.

**The remote's own work is recorded, not governed.** I say this plainly in the interface and in the transcript, and I would rather say it than quietly imply otherwise. If you need every action governed, give the agent no computer of its own and let it call only my tools. That is a real configuration, not a consolation prize.

**One reference implementation is not the ecosystem.** I have tested against a handful of endpoints and the protocol's own event list. The first bug report from somebody running a framework I have not tried will teach me something.

If you try it against your own agent and it breaks, tell me what it sent. That is the fastest way this gets better.

*[OneCamp](https://onemana.dev/buy) is an open-source, self-hosted workspace: one payment, unlimited users, your server. Find it at [onemana.dev](https://onemana.dev/buy).*
