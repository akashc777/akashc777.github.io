---
title: "We Opened OneCamp to Outside AI Agents, and Every Gate We Added Found a Bug"
image: "/assets/images/post/onecamp-mcp-gates.jpg"
author: "Akash Hadagali"
date: 2026-08-07 12:00:00 +0530
description: "Claude Desktop, Cursor and anything else speaking MCP can now reach a OneCamp workspace — through an authority rule that is an intersection with a real person's live permissions, never a union, re-evaluated per call. Gating all thirty tools turned into an audit I hadn't planned, because writing an authority rule beside one that already shipped is how you find out the shipped one was wrong. Four times it was: a doc author locked out of their own doc, an agent able to DM a ghost identity people are refused, an event loop that walked past the delegation gate, and a write that could never be retried."
tags: ["OneCamp", "MCP", "Go", "Security", "Governance", "AI", "Agents", "Self-Hosted", "OpenSource"]
---
This is the first of four posts about a week with no new features in it. The [previous one](/post/What-We-Fixed-So-You-Never-Notice-A-Search-Outage-A-Coding-Agent-And-31-Screens-That-Lied.html) was about unglamorous fixes; this week was about sixty commits across five repositories and nothing anybody can click.

If you're new here: [OneCamp](https://onemana.dev/buy) is an open-source, self-hosted workspace — chat, docs, tasks, projects, calls, boards, tables, an API — with AI teammates that live in it. The point is that it runs on **your** infrastructure, through **your** choice of model, so nothing leaves your network unless you send it there.

The main job was letting **agents outside** it reach in — Claude Desktop, Cursor, anything speaking MCP — without that becoming a hole in the product.

That turned into an audit I didn't plan. To gate a tool, you have to write down what authority it requires. Writing that down a second time, next to a path that already shipped, is how you find out the first one was wrong. It happened four times.

If you only read one section, make it [the bugs](#every-gate-found-a-bug-) — they're more instructive than the architecture.

---

## Why MCP Needs Governing 🔌

MCP is the protocol AI clients use to reach tools. It won fast — the SDK went from something like 100K downloads a month in late 2024 to around 97M by March 2026, quicker than Kubernetes reached comparable adoption, and a large majority of the Fortune 500 now run agents of some kind.

It is also, by reputation and by the numbers I found while researching this, badly secured in practice: a large share of public servers require no authentication at all, most keep credentials in plaintext, and 2026 has produced dozens of CVEs. The reason is structural rather than careless — **the protocol specifies no authorization** and leaves it to each server. The classic failure it invites is the *confused deputy*: a component with real privileges doing something on behalf of a caller who never had them.

That is exactly the failure OneCamp already refuses internally. The work was to make the same guarantee point outward.

## The Authority Model

An MCP call has no session. There is no logged-in user to ask about. So the credential has to carry the human: an API token row records who created it, and effective authority becomes

> `token.scopes` **∩** that human's **live** permission on **this object**

An intersection, never a union. Re-evaluated per call, never cached. A token cannot grant more than the person behind it currently has — so if they lose access to a channel, or are deactivated, everything issued in their name narrows the moment they do. Deactivating a person now attenuates every agent acting for them, and archiving then restoring a resource re-grants correctly. Both are pinned by tests, because "permissions follow the human" is worthless if it's only true at issue time.

I built the authorizer **before** any transport or any tool, which felt slow and wasn't. The authorizer is the product here. A transport with tools attached and no authority model is the thing all those CVEs are.

## Rolled Out One Tool at a Time

The governed path went in behind a single condition in the tool dispatcher, so the frontier moved tool by tool while everything else fell through unchanged. That was deliberate: a commit whose blast radius is *every MCP tool including the writes* is not a commit anyone can review, and its failure mode is refusals that look exactly like an outage.

Resource kinds landed one at a time — projects, tables, chats (DMs and group chats) — and then the distinction that matters more than any of them: **"may see" is not "may change."** That had been one question in too many places.

It ends at **30 of 30 tools governed**. The last two were interesting: `create_doc` and `set_reminder` take no container argument. They make something that belongs to the caller and sits in no parent, so there is genuinely no object for an authority rule to check, and the write rule refuses container-less writes *by design* — a write must name what it changes. That rule is right for the tools it was written for. Applied to these two it isn't a safety property, it's an accident of phrasing: there's no object because the object doesn't exist yet and will belong to the person asking. Rather than leave two tools permanently on the weaker path, the decision is taken explicitly and the weaker guarantee is made visible instead of quiet.

## Writes

Three properties, and none of them needed a new datastore:

- **Exactly once** — an idempotency key per write, claimed and settled.
- **Reviewed** — a write routes to an Approve/Deny card where a person actually looks, proven against the real pending-actions table rather than a mock.
- **Never impersonating** — the audit trail records the agent *and* the human whose authority it borrowed. No run exists with nobody behind it.

Plus budgets, because an agent with a valid credential and a loop is a billing incident: per-credential call budgets with **reads and writes counted apart**, a per-agent token cap, and embedding spend metered at a single chokepoint rather than at each of the places that happened to call it.

And an admin decides whether MCP is exposed at all, and what it can reach. Off by default is the only sane posture for a surface like this.

## Audit That Records Refusals

The legacy path recorded successful writes only. Which means a burst of **denied** calls — which is precisely what probing looks like — left no trace whatsoever. The governed path records the decision, including refusals, and the audit categories are served to the UI so agent activity is filterable rather than a wall of rows.

## One Honest Wrinkle

Mid-build, MCP shipped its largest revision since launch and the protocol core went **stateless**: the initialize handshake and session header are gone, per-request metadata carries protocol version and client identity, and a tool needing input mid-call now returns an "input required" result that the client re-sends with answers, instead of the server pushing a prompt. That invalidated part of my own design document, which had the transport handling a handshake that no longer exists. Better to find that while building than after.

---

## Every Gate Found a Bug 🐛

Each tool I governed required comparing my new rule against the permission check the shipped path had always applied. Four times out of thirty-odd, they disagreed — and the shipped one was wrong.

### A doc author locked out of their own doc

The existing gate for reading a doc allowed: not private, **or you created it**, or you're in the reading, editing or commenting list.

My reach rule checked the three lists. Nothing in the system guarantees that a doc's author is also a member of its own reading list. So the governed rule would have refused an author access to a private doc they wrote — a regression I'd have shipped, caught only because I put the two rules side by side.

### An agent could DM a ghost identity

Creating a DM through the HTTP controller has always enforced three things about the recipient: it resolves, it isn't soft-deleted, and it's refused if the identity is external unless it's also a bot.

The AI executor behind `send_dm` — the same executor the MCP surface reuses — checked the first two and omitted the third. So an agent could DM an attribution-only ghost identity that a person using the app is refused outright.

Invisible in review, because *both paths looked like they were checking the recipient*. The rule was written out fully in one place and partially repeated in the other. That's the shape of divergence that survives review indefinitely. It's now one function that all three callers ask, with two ratchets: one asserting every send path calls it, the other asserting nobody has re-added an inline copy beside it. A copy that sits next to the shared call is a copy that gets edited alone.

### An internal event that walked past the delegation gate

Agent-to-agent delegation is authorised centrally: hop budget, cycle detection, and — the part that matters — that the **originating person** could have addressed that surface themselves. One dispatch path consulted it.

The generic event loop ran *before* the type-specific branches and consulted none of it:

```go
for _, a := range evAgents { launchAgent(ctx, a, model.TriggerEvent, …) }
```

Trigger events were free text with no allowlist and nothing validating them on write. So an agent whose trigger event was set to `agent.message` would fire on **other agents' messages** — no hop budget, no cycle check, no permission check, and no human recorded as being behind the run. That defeats the one invariant the whole design rests on: no privilege laundering.

It couldn't loop forever, because such a run carries no lineage and the emit path returns early. One unauthorised hop is still one too many. It was only reachable by writing the trigger config through the API directly — the admin UI offers a fixed list that excludes it — so this was a narrow hole, but a hole with a clean shape.

### A write that could never be retried

The claim/settle path was raw SQL against a partial unique index. Go does not type-check SQL, so every statement compiled and read correctly. One of them was wrong in a way only *execution* reveals, which is why I ran them against a real Postgres instead of re-reading them.

A settled row keeps its idempotency key, and the unique index was on the key alone — not the key plus a status. So a row left `failed` by a transient error, or reclaimed as `failed` after a crash, **blocked its own retry forever**: the insert conflicts, the state truthfully reports nothing took effect, and the claim refuses with "retry". Every retry after that does the same thing. One transient failure made that exact call permanently unrepeatable.

The file stated the opposite property in a comment — "a failed write frees the key" — and there was a test asserting it. The test passed. It was asserting the comment rather than the behaviour.

The fix is a guarded `UPDATE` that moves a non-applied row back to executing for a fresh attempt, with the guard in the `WHERE` clause rather than in Go, so the check and the update are one atomic statement.

### "Requires confirmation" that confirmed nothing

Three tools promise confirmation in their own descriptions: send an email, create a calendar event, comment on GitHub. That promise was **a sentence in a prompt**, and a prompt enforces nothing.

Every other surface honoured the contract properly. The interactive assistant routes every write to an approval card. One autonomy level gathers writes into a plan; another queues each for approval. The public tool scope leaves these three off entirely and says why.

Only full autonomy did not — so an agent at full autonomy could email a customer, put an event on someone's calendar and notify the attendees, or comment publicly on GitHub under a real person's name, unattended. Its own comment claimed no autonomy level could silently cause irreversible damage on any connector.

The reason it missed them is narrow and worth knowing: the backstop asked whether a tool was destructive, and that flag is sourced from a *remote* MCP server's own hint. No built-in tool sets it. So the check was false for every tool OneCamp ships, and **the backstop only ever protected other people's tools.**

There was a mirror-image error too, in the other direction: the UI was labelling "send an email" a destructive action. Sending an email is irreversible, not destructive — it deletes nothing. Calling it destructive trains people to ignore the label, so that was corrected in both the app and the public mirror.

---

## What I'd Take From This

**Governance is an audit in disguise.** Every gate forced me to write an authority rule beside one that already shipped, and the comparison is what found the bugs. I would not have found any of them by reading the old code on its own — I'd read it before.

**Beware tests that assert comments.** The idempotency test passed for as long as the behaviour was broken, because it checked what the file *said* rather than what it did. It only fell over when I executed the SQL against a real database instead of reading it again.

**A prompt is not an enforcement mechanism.** Three tools said "requires confirmation" in their descriptions, and one autonomy level simply didn't. Text in a prompt is a suggestion to a model, not a property of a system.

---

## Still Open

The governed surface has never had a real client attached to it. Everything here is verified by tests I wrote against my own model of what a client sends, and that is exactly the kind of confidence that deserves suspicion. Pointing Claude Desktop or Cursor at a dev workspace is next, and I expect it to find something.

---

## What This Means If You Use OneCamp 🚀

**External agent access is off until you turn it on — Admin → AI Models → "External agent access (MCP)".** It sits directly beneath agent delegation, because they're the same kind of decision: who may cause an agent to act here. Delegation governs agents inside the workspace; this governs clients outside it. When you enable it, issue credentials bound to an agent identity rather than a person's general-purpose token, and set the read and write budgets separately.

**Check your autonomy settings if you run unattended agents.** Sending email, creating calendar events and commenting on GitHub now genuinely require confirmation at every autonomy level, including full. If you had an agent quietly doing any of those unattended, it will now ask.

**The four bugs above need nothing from you.** The doc-authority rule, the DM recipient check, the delegation gate and the retryable writes are simply in. If you'd been bitten by any of them you'd have had no way to tell, which is rather the point of writing them up.

---

The other posts from this week: [one context window for every model was quietly wrong](/post/One-Context-Window-For-Every-Model-Was-Quietly-Wrong.html), [the code was written, nothing called it](/post/The-Code-Was-Written-Nothing-Called-It.html), and [regex is not a sanitiser](/post/Regex-Is-Not-A-Sanitiser-And-Other-Things-I-Got-Wrong-About-Text.html).

*[OneCamp](https://onemana.dev/buy) is an open-source, self-hosted, AI-era workspace: chat, docs, tasks, projects, calls, boards, tables, a programmable API, and AI teammates that can see, calculate, run code, query your databases, read your documents, and open pull requests — on infrastructure you own, through the model you choose. As of this week, outside AI clients can reach it too. Find it at [onemana.dev](https://onemana.dev/buy).*
