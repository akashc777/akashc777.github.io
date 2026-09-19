---
title: "Every Agent Row Said Who It Acted For. None Said Whether Anyone Was Watching."
image: "/assets/images/post/onecamp-nobody-watching.jpg"
author: "Akash Hadagali"
date: 2026-09-19 12:00:00 +0530
description: "My audit log could always tell you whose authority an agent acted on. It could not tell you whether that person was in the room. That is the question an auditor actually asks, and it had no field, so I added one and immediately found two places writing rows that still said nothing. Also in this fortnight: agents that answer with a chart because of a comment I wrote that was wrong, and a warning my own demo was showing on every single answer."
tags: ["OneCamp", "AI Governance", "Audit", "EU AI Act", "AI Agents", "Self-Hosted", "OpenSource"]
---

If you're new here: [OneCamp](https://onemana.dev/buy) is an open-source, self-hosted workspace (chat, docs, tasks, projects, calls, boards, tables, an API) that runs on **your** infrastructure. I build it, sell it, and operate the demo.

Two weeks ago I wrote that [AI governance is mostly boring plumbing](/post/AI-Governance-Is-Mostly-Boring-Plumbing.html). This fortnight was three more pieces of it, and one of them I only found because somebody pasted my own product's warning at me.

## The field that was missing

Every agent action in OneCamp is written to a hash-chained log before it runs. The row names the agent, the tool, the decision, the reason for a refusal, and the human principal it acted for.

That last one is the answer to "on whose authority". It is not the answer to "was anybody there".

An agent run somebody asked for has a person watching who will notice a wrong tool call within seconds. A run a timer fired at 3am, or one another agent handed on, does not. Those are different risks, and they were the same row.

The information was not entirely absent. The raw trigger source was buried in one row's metadata, in the runner's own vocabulary (`manual`, `mention`, `task_assignment`, `ambient`), on one row per run. So the question "what ran in this workspace while nobody was looking" had no field to ask of, only a string to interpret, on only some of the rows.

## Five answers, three of which mean nobody was there

Every agent and system row now carries an **initiator**:

- **person**: somebody was in the room. A message, a mention, a task assigned by hand, a button.
- **schedule**: a timer fired it, as its owner, with nobody there.
- **event**: something happened in the workspace and the agent reacted. Nobody asked.
- **handoff**: another agent asked for this, on a person's behalf.
- **eval**: the evaluation harness, against a fixture, never on anyone's behalf.

The middle three are the unattended ones. The audit log has a **Nobody watching** filter that shows only those, and every agent row states its initiator inline. Members see the same word in their own AI activity feed, read from the same row, because the person an agent acts for is entitled to the same answer an auditor gets.

It lives in the row's metadata rather than in a new column, and that was deliberate. Metadata is inside the row hash, so it is exactly as tamper-evident as a column would be, and it reaches the export, the evidence pack and the receipts through paths they already read. A new column would have meant a new term in the hash and a new sentence in the verification steps an auditor follows by hand.

## Then I checked it live and found two liars

I shipped it, deployed to the demo, and ran the governance drill to watch a real refusal get recorded.

The rows came back with no initiator at all.

The drill writes its rows as the agent, because an agent is what acted. It sets no context, so my code did the correct thing and wrote nothing rather than guessing "person". Which is right, and also meant the one agent action in the product that is **never** unattended, an admin pressing a button to rehearse a refusal, was invisible to the filter that finds unattended work.

Looking for its siblings found a second: inbound calls over MCP, where external tooling acts on a member's authority. Those are recorded as handoffs now, and not because it was convenient. The package already decides that an inbound call starts at hop one rather than zero, on the reasoning that some agent, somewhere, decided to make it. If that is true for the delegation budget it is true for the initiator, and whether a person was watching that other agent is not something this side can see. Handoff is the honest answer, and it puts the row under "nobody watching" where somebody auditing external tooling will find it.

**The lesson I keep relearning:** a new field is only as good as its worst writer, and you find the worst writer by running the thing and reading the row, not by reading the code that writes it.

One more: the monthly evidence receipt, the job that fingerprints each completed month's evidence pack, now records itself as scheduled work and writes its own row into the log it certifies. A receipt a timer took and a receipt a person exported are the same actor kind and different facts.

Nothing is backfilled. Rows written before this release have no initiator and are shown without one, because inventing an answer for a row in a tamper-evident log is the one thing that log exists to make impossible.

## Agents can answer with a chart, because a comment I wrote was wrong

Smaller, and it makes me wince.

The assistant panel has been able to draw a chart for a while. An agent writes a fenced block holding a compact spec, and the renderer draws it.

The autonomous agents were never told they could. There was a comment in my own code explaining why: their replies post into channels as rich text, which does not render markdown code fences, so advertising it would produce a chart nothing draws.

That comment was wrong when I wrote it, or became wrong shortly after. The message renderer already turned a closed chart block into an inline chart. The coworker used it. Channel posts used it. What did not use it were the three tools an agent actually posts with, which went through a second, older text-to-HTML function that knew nothing about charts.

So an agent asked for a weekly report wrote the numbers out in a sentence, and I had a comment explaining that this was correct.

There is now one function that splits a reply into charts and prose, and every surface that turns model text into HTML goes through it: channel posts, direct messages, group chats, comments, documents, and the run result in the builder, which used to print the chart's source at the person checking their agent's work. An agent is offered charts only when it has a tool or a knowledge source to get numbers from, which is the same rule the panel applies, for the same reason: the first line of that prompt is that it must never invent data to fill a chart.

**Where a wrong comment is worse than no comment:** nobody re-checks a decision that comes with a reason. I did not re-check this one for months.

## The warning my demo was showing on every answer

This one arrived today, from a reader pasting a line my own product had produced:

> This answer was produced without GitHub, which is configured but unreachable. An admin can reconnect it in Admin settings.

Everything about that sentence is true. Here is the chain behind it, which I like, followed by the two things around it that I do not.

The demo has a GitHub connector configured over MCP. Its stored token is encrypted with a workspace key. That key changed at some point over the summer, so the token can no longer be decrypted. My code refuses to hand back a secret it cannot read, so the server contributes no tools rather than advertising forty-four tools that every call would then refuse. The registry publishes the connector as unreachable, and the next answer says so instead of quietly being worse.

That is the behaviour I want. A silently degraded answer is worse than a refused one, because it spends the credibility of every answer that did work.

**But it was being said on every answer.** Ask for a haiku, get a warning about GitHub. Ask what is on your calendar, get a warning about GitHub. A warning that appears on every answer is one nobody reads by the time it means something, and this had been on the public demo for months, which means it had been training visitors to ignore it for months.

Each unreachable connector now carries the subjects it would have covered. Those come from the names of the tools it last successfully reported, which is the only record left of what it was for once the credential dies, plus the vocabulary already curated in my tool router for built-in tools of the same name. That last source is the one that matters, because **nobody types "GitHub" to ask what pull requests are open.**

Live, after the fix:

```
"write a haiku about the sea"      -> no notice
"what PRs are open in the repo"    -> "produced without GitHub..."
"is GitHub connected"              -> "produced without GitHub..."
```

A path that does not record what was asked still names everything, and so does a connector whose subjects cannot be worked out. Silence is the one answer this must never give by default.

**And the admin sent to fix it found nothing there.** The sentence says an admin can reconnect it in Admin settings. When the admin got there, the server showed as enabled, with its full tool list, looking healthy in every visible respect except the one that mattered. Worse, the secret field offered the usual courtesy: *leave blank to keep the stored value*. Keeping a value that cannot be decrypted is the one thing that field must not offer, because the fix then looks like a save and changes nothing.

The server list now marks that server and says why. The field asks for the secret again.

My backend knew all of this. The API returned it, in a field called `auth_secret_unreadable` that the frontend never read. **That gap, where the server knows and the screen does not, is the most boring bug class I ship and the hardest one to notice, because every test on both sides passes.**

## Seeing all three of these on your own install

### The initiator, in about two minutes

Go to **Admin, AI and Agents** and find the **Governance drill**. Press it. It makes an agent attempt something the person it acts for is not allowed to do, watches it get refused, and shows you the rows.

Now go to **Admin, Settings, Audit log**. The drill's two rows are there, each reading `person, ...` because you pressed the button.

Press **Nobody watching**. They vanish, which is the correct answer: somebody was watching. What remains is everything that ran on its own.

To put something in that list deliberately, open **Settings, Agents**, edit any agent, set its trigger to **On a schedule** with a short interval, and come back after it fires. Its row reads `schedule, nobody watching`. If you have external tooling calling in over MCP, its decisions are there too, as `handoff`.

Members do not need the admin screen for the part that concerns them: **Activity, then the AI tab** shows the same word on their own agents' runs, read from the same row.

One thing to expect: rows written before this release have no initiator and show none. Nothing was backfilled.

### The charts

Any agent that has at least one tool or one knowledge source is now told it may draw. Ask one something whose answer is a handful of numbers, in a channel, a direct message or **Run test** in the builder:

> How many tasks were completed each day this week? Show it as a chart.

The chart renders inline in the message. If the agent has no tools and no knowledge it is not told about charts at all, because the first rule in that prompt is that it must never invent data to fill one, and an agent with nothing to read can only invent.

### The connector warning

If you have MCP connectors, go to **Admin, AI and Agents, AI Models** and look at the server list. A connector whose secret can no longer be decrypted now carries a **Secret unreadable** badge and a line saying why. Open it and the secret field asks for the value again rather than offering to keep the broken one.

To see the relevance behaviour, ask the assistant two questions with a connector broken: one about what it does, one about anything else. Only the first mentions it.

And if you want to know whether you have this problem right now without reading logs: that server list is the answer, and it takes one look.

## Still open

**The non-streaming ask endpoint has no notice at all.** The streaming one, which is what the app uses, reports everything described above. Its older sibling attaches no sink, so an answer there can be built from a shortened prompt and never say so. Nothing in my frontend calls it any more: there is an import of its hook sitting in one component that never destructures it, which is exactly the shape of how an endpoint rots. It is still a public endpoint, and API-token callers still reach it.

**Nothing in the product tells you a connector broke until you ask a question.** The detection happens when the registry rebuilds, on a background job belonging to nobody. There is no alert, no email, no badge on the admin rail. In my case the gap between the key changing and a human noticing was measured in months, and closing it is next.

**I still cannot name why a key changed.** The error is an authentication failure on the ciphertext, which tells you the key is different and nothing about when or by whom. A startup probe that checked a known value and shouted would have caught this in June.

And, as ever: I never claim OneCamp makes you compliant with anything. It produces records. What those records are worth is between you and your auditor.

The other post from this fortnight: [I spent a week comparing my agents to everyone else's, then I let theirs in](/post/I-Spent-A-Week-Comparing-My-Agents-To-Everyone-Elses-Then-I-Let-Theirs-In.html).

*[OneCamp](https://onemana.dev/buy) is an open-source, self-hosted workspace: one payment, unlimited users, your server. Find it at [onemana.dev](https://onemana.dev/buy).*
