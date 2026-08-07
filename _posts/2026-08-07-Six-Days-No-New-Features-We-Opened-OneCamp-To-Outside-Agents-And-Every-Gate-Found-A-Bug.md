---
title: "Six Days, No New Features: We Opened OneCamp to Outside Agents, and Every Gate We Added Found a Bug"
image: "/assets/images/post/onecamp-security-resilience-hero.png"
author: "Akash Hadagali"
date: 2026-08-07 10:00:00 +0530
description: "Since the last post there have been about sixty commits across five repositories and not one new feature. The main job was exposing OneCamp to outside AI agents over MCP, safely — which meant writing an authority rule for all thirty tools. Writing each rule down a second time is what exposed the first one being wrong: a doc author locked out of their own doc, an agent able to DM a ghost identity people are refused, a write that could never be retried, and three tools whose promise of confirmation was a sentence in a prompt. Plus token limits that finally follow the model, and four mechanisms that were finished, tested, and unreachable."
tags: ["OneCamp", "Go", "NextJS", "MCP", "Security", "Governance", "Testing", "AI", "Agents", "Self-Hosted", "OpenSource"]
---
The [last post](/post/What-We-Fixed-So-You-Never-Notice-A-Search-Outage-A-Coding-Agent-And-31-Screens-That-Lied.html) was about unglamorous fixes. This one is more of the same, at larger scale: about sixty commits across five repositories in six days, and not a single new feature for anybody to click.

If you're new here: [OneCamp](https://onemana.dev/buy) is an open-source, self-hosted workspace — chat, docs, tasks, projects, calls, boards, tables, an API — with AI teammates that live in it. The whole point is that it runs on **your** infrastructure, through **your** choice of model, so nothing leaves your network unless you send it there.

Most of this week was one job. OneCamp's AI already worked inside the product; the task was letting **agents outside** it — Claude Desktop, Cursor, anything speaking MCP — reach into a workspace without that becoming a hole in it.

That turned into an audit I didn't plan. To gate a tool, you have to write down what authority it requires. Writing that down a second time, next to a path that already shipped, is how you find out the first one was wrong. It happened over and over.

If you only read one section, make it [Part 2](#part-2-every-gate-found-a-bug-) — the bugs are more instructive than the architecture.

---

## Part 1: A Governed MCP Server 🔌

MCP is the protocol AI clients use to reach tools. It won fast — the SDK went from something like 100K downloads a month in late 2024 to around 97M by March 2026, quicker than Kubernetes reached comparable adoption, and a large majority of the Fortune 500 now run agents of some kind.

It is also, by reputation and by the numbers I found while researching this, badly secured in practice: a large share of public servers require no authentication at all, most keep credentials in plaintext, and 2026 has produced dozens of CVEs. The reason is structural rather than careless — **the protocol specifies no authorization** and leaves it to each server. The classic failure it invites is the *confused deputy*: a component with real privileges doing something on behalf of a caller who never had them.

That is exactly the failure OneCamp already refuses internally. The work was to make the same guarantee point outward.

### The authority model

An MCP call has no session. There is no logged-in user to ask about. So the credential has to carry the human: an API token row records who created it, and effective authority becomes

> `token.scopes` **∩** that human's **live** permission on **this object**

An intersection, never a union. Re-evaluated per call, never cached. A token cannot grant more than the person behind it currently has — so if they lose access to a channel, or are deactivated, everything issued in their name narrows the moment they do. Deactivating a person now attenuates every agent acting for them, and archiving then restoring a resource re-grants correctly. Both are pinned by tests, because "permissions follow the human" is worthless if it's only true at issue time.

I built the authorizer **before** any transport or any tool, which felt slow and wasn't. The authorizer is the product here. A transport with tools attached and no authority model is the thing all those CVEs are.

### Rolled out one tool at a time

The governed path went in behind a single condition in the tool dispatcher, so the frontier moved tool by tool while everything else fell through unchanged. That was deliberate: a commit whose blast radius is *every MCP tool including the writes* is not a commit anyone can review, and its failure mode is refusals that look exactly like an outage.

Resource kinds landed one at a time — projects, tables, chats (DMs and group chats) — and then the distinction that matters more than any of them: **"may see" is not "may change."** They had been one question in too many places.

It ends at **30 of 30 tools governed**. The last two were interesting: `create_doc` and `set_reminder` take no container argument. They make something that belongs to the caller and sits in no parent, so there is genuinely no object for an authority rule to check, and the write rule refuses container-less writes *by design* — a write must name what it changes. That rule is right for the tools it was written for. Applied to these two it isn't a safety property, it's an accident of phrasing: there's no object because the object doesn't exist yet and will belong to the person asking. Rather than leave two tools permanently on the weaker path, the decision is taken explicitly and the weaker guarantee is made visible instead of quiet.

### Writes

Three properties, and none of them needed a new datastore:

- **Exactly once** — an idempotency key per write, claimed and settled.
- **Reviewed** — a write routes to an Approve/Deny card where a person actually looks, proven against the real pending-actions table rather than a mock.
- **Never impersonating** — the audit trail records the agent *and* the human whose authority it borrowed. No run exists with nobody behind it.

Plus budgets, because an agent with a valid credential and a loop is a billing incident: per-credential call budgets with **reads and writes counted apart**, a per-agent token cap, and embedding spend metered at a single chokepoint rather than at each of the places that happened to call it.

And an admin decides whether MCP is exposed at all, and what it can reach. Off by default is the only sane posture for a surface like this.

### Audit that records refusals

The legacy path recorded successful writes only. Which means a burst of **denied** calls — which is precisely what probing looks like — left no trace whatsoever. The governed path records the decision, including refusals, and the audit categories are served to the UI so agent activity is filterable rather than a wall of rows.

### One honest wrinkle

Mid-build, MCP shipped its largest revision since launch and the protocol core went **stateless**: the initialize handshake and session header are gone, per-request metadata carries protocol version and client identity, and a tool needing input mid-call now returns an "input required" result that the client re-sends with answers, instead of the server pushing a prompt. That invalidated part of my own design document, which had the transport handling a handshake that no longer exists. Better to find that while building than after.

---

## Part 2: Every Gate Found a Bug 🐛

This is the part I'd want to read. Each tool I governed required comparing my new rule against the permission check the shipped path had always applied. Four times out of thirty-odd, they disagreed — and the shipped one was wrong.

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

## Part 3: Token Limits That Follow the Model 🎚️

OneCamp is model-agnostic on purpose: an admin allows a set of models, and a member, a channel, or an agent can each pick a different one.

There was exactly **one** context window setting, and every budget read it regardless of which model actually answered.

That's wrong in both directions, and silently:

- A channel pinned to a 128k model, under a workspace configured at 8192, threw away context that would have fitted comfortably.
- On a local model it was worse than wasteful. The context size is applied when the client is constructed, so the model was **genuinely run small** — not trimmed, run small.
- An 8k model under a 128k workspace gets prompts it cannot accept, which cloud providers answer with a flat HTTP 400.

Limits now live on the allowlist row, per model, with zero meaning "inherit the workspace default". There's an admin form and a **Detect** button that asks the provider what the model's limits actually are — for every source that will answer. Discovery *suggests*, never applies: a gateway's answer can be stale or describe a different deployment of the same name, and silently changing an effective window under someone is worse than making them press a button.

Two related fixes came out of the same work. The output ceiling was stated but not enforced on the way out, so it now caps what is actually **sent**, in the client rather than at twenty-five call sites that would each have to remember. And when a prompt does overflow, the recovery prefers the limit the provider **states in its own error text** over halving blindly — halving cannot converge sensibly on a sixteen-fold misconfiguration.

Then the part people actually see: when an answer was built from a shortened prompt, it now says so. Quietly, as a footnote, on **every** AI surface — the assistant, search answers, the doc editor — not just the one place I'd wired it first. I surveyed by hand and found eight silent sites; a ratchet that fails the build for any un-notified trim found fifteen.

---

## Part 4: Four Mechanisms That Were Written and Never Called 🔍

A recurring shape, and the one I'd least expected to find four times: code that is finished, correct, documented, unit-tested — and unreachable.

- A **context-overflow rescue** that recomputed a smaller target. Written, tested, never called.
- A **GitHub bot-login resolver**: cached for 30 minutes, retried three times with backoff, cache invalidated in two separate places on token change. Never called, so the cache never held anything and both invalidations were no-ops.
- A **single-request ZIP reader** for Slack imports, unreachable because the function producing its input discarded that input with `_`.
- A **display-name builder** feeding a field nothing downstream read.

This class is nasty because nothing looks wrong. The code is good, it passes tests that call it directly, and it reviews well. There's just no edge from the running program to it — and a mechanism that is never invoked is indistinguishable in production from one you never wrote.

Two of them were hiding real bugs.

### Our own comment could restart the agent

When someone comments on a PR an agent opened, that agent picks its work back up. The guard skipped comments where the sender type was `Bot`, which covers GitHub Apps.

It does not cover how OneCamp comments. Our tool posts through the connected person's OAuth token, so a comment *we wrote* arrives as sender type `User` and walks straight through. An agent holding that tool could comment, be woken by its own comment, comment again — spending tokens and posting publicly on someone else's repository each lap.

The missing piece was the login of the token we post as. That was the unwired resolver above. The comment's author was already being parsed out of the payload and already sent downstream; only the guard ignored it.

### A forwarded message went to the wrong conversation

This one bothered me most. Forwarding lets you pick several destinations at once. The code accumulated parallel slices — DM nodes, grouping IDs, participant lists — and paired them **by index**.

The node slice grew for both group chats and DMs. The grouping-ID and participant slices grew only for DMs. Destination order is whatever order you clicked.

So forwarding to a group chat **and** a DM was enough: index 0 of the nodes was the group chat, index 0 of the others described the DM. The group's message was published to the DM's live topic and indexed under the DM's grouping ID and participant list — in front of people never in that group — while the real DM forward was skipped by a length guard and never indexed at all.

The live-delivery path read the right value and then threw it away:

```go
grpId := dgraphDm.GroupingId   // correct, set when the node was built
if i < len(groupingUUIDs) {
    grpId = groupingUUIDs[i]   // ...and here is the bug
}
```

The node knew which conversation it belonged to the whole time. The positional lookup wasn't a redundant safety net; it *was* the defect. Pairing is now by chat UUID, in a pure function testable without a database or a broker.

The dead helper that led me there was genuinely superseded. But asking *why* it existed found the field it would have fed — collected on every forward, passed through a call, read by nothing.

### Making it a build failure

Finding four instances of one pattern by reading code is luck. There's now a check that builds a call graph per package and walks it: roots are everything enterable from outside — exported functions, any method, `init`, `main`, package-level initialisers — and an unexported function is alive only if a root reaches it. Anything else fails the build with a file and line. Deliberate exceptions need a marker in the function's own doc comment stating *why*, where a reviewer sees it.

Its first version counted references, and had a flaw worth naming: **a cluster of dead functions hides itself**, because a dead helper calling a second dead helper gives the second one a reference. That wasn't hypothetical — one dead helper kept its own dead callee invisible exactly that way. The walk has no such blind spot.

It covers the whole module and reports nothing, which I'd rather say plainly than dress up. The value is that the blind spot is gone before the next one is written.

### The sweep afterwards

Knowing the forwarded-message class was real, I looked for every place a loop bounded by one slice indexes a second. Nine sites; six write both at the same index in one statement and can't drift. Three were bulk Postgres writers taking parallel lists from a caller, and they didn't agree with each other. One had the length check. One had none, across two independent pairings. And one had this:

```go
if len(toUUIDs) == 0 || len(toUUIDs) != len(grpIDs) {
    return nil
}
```

That treats "nothing to do" and "you handed me inconsistent data" as the same outcome. If a caller's lists ever drifted, every DM notification in the batch was skipped — no error, nothing logged, notifications simply never arriving and no trace to explain why. Note the direction nobody guards, either: a slice that's too *long* doesn't panic, it drops rows silently, because the loop stops at the shorter one.

The best argument for adding the missing checks wasn't my judgement — it was that one of the three already had one. The invariant was already recognised here. Two writers just never said it out loud.

---

## Part 5: Text, Media, and Other People's Browsers 🧹

A batch of things that had nothing to do with agents.

**Truncating text was splitting characters.** Slicing a Go string counts bytes, so cutting at a fixed offset severs any multi-byte character straddling the boundary and produces invalid UTF-8 — which then travels into API responses, the graph database and the search index, where it's either rejected or rendered as a replacement glyph. Every accented, emoji or non-Latin string hits it, which is to say all user text.

The guard was wrong in a more embarrassing way: `if len(text) > 800` also measures bytes, so 800 characters of Japanese is roughly 2400 bytes, the branch fires, and an ellipsis gets appended to text that **was never actually shortened** — telling the reader something was cut when nothing was. One helper now counts characters for both the limit and the guard, and appends the suffix only when something really went.

**No media can reach the search index.** A beta search node was OOM-killed a while back by a single update whose document body held a base64 image. The editor bug was fixed then; this closed the paths that could still get media into an index. Two mattered: the bulk path bypassed the guard entirely while carrying most of the write volume, and the AI embeddings index wrote raw HTML — so embedding vectors were being computed **from base64**, degrading semantic search and spending the whole text budget on payload. Media is now stripped before embedding rather than after.

**Two stored-XSS holes on the marketing site.** The markdown renderer stripped `<script>` tags and `on*=` attributes with regexes and handed the result to `dangerouslySetInnerHTML`. A comment called it defence in depth. It defended against almost nothing — all of these got through, each falling outside the exact shapes the patterns looked for:

```
<img src=x onerror=alert(1)>        unquoted attribute value
<script src="//evil/x.js">          no closing tag, nothing to match
<svg onload=alert(1)>               unquoted, and <svg> was never stripped
[click](javascript:alert(1))        a URL scheme, not a tag or attribute
<iframe srcdoc="&lt;script&gt;…">   entity-encoded, invisible to the regex
```

Both paths execute on the frontend origin, which is where the admin token lives. Either one could have stolen an admin session.

**And an uploaded SVG could run script.** SVG is on the upload allowlist, and media was served inline with that declared type. An SVG is a document, not just a picture: it can carry `<script>` and event handlers, which run when the URL is opened directly. Loading it through an `<img>` tag cannot execute script; *navigating* to it can. The `nosniff` header doesn't help, because the declared type genuinely is SVG — there's nothing to sniff. A restrictive CSP is the fix: block script, fetch and subresource loads outright, and sandbox away the origin the document would otherwise inherit.

Rounding out the housekeeping: the server now refuses to boot on schema drift rather than running against a database it doesn't match, dead links got repointed, a Node version floor is declared where the tooling needs one, and the public mirror finally has the MIT licence its badge had been promising.

---

## What I'd Take From Six Days of This

**Governance is an audit in disguise.** Every gate I added forced me to write an authority rule beside one that already shipped, and the comparison is what found the bugs. Four out of thirty-odd disagreed. I would not have found any of them by reading the old code on its own — I'd read it before.

**Beware tests that assert comments.** The idempotency test passed for as long as the behaviour was broken, because it checked what the file *said* rather than what it did. That one only fell over when I executed the SQL against a real database instead of reading it again.

**A prompt is not an enforcement mechanism.** Three tools said "requires confirmation" in their descriptions, and one autonomy level simply didn't. Text in a prompt is a suggestion to a model, not a property of a system.

**A test that has never failed is not evidence.** Every fix here got the same treatment: put the bug back, watch the new test go red for the right reason, restore, and diff to confirm the restore was byte-identical. It earned its keep — once, a test I was confident about passed against the reverted bug, which meant my edit had never applied. Without that step I'd have shipped a fix alongside a test that proved nothing.

**"Needs integration tests" is often an excuse.** The unwired ZIP reader carried a note, written by me, saying switching it on deserved a real export end to end. But what could actually break was offset arithmetic and whether two things got closed — nothing to do with the storage backend. Behind a one-method interface it's now verified against real archives built in memory, compared byte-for-byte with the standard library, with an off-by-one caught in 30 milliseconds on a laptop.

---

## Still Open

The governed MCP surface has never had a real client attached to it. Everything above is verified by tests I wrote against my own model of what a client sends, and that is exactly the kind of confidence that deserves suspicion. Pointing Claude Desktop or Cursor at a dev workspace is the next thing, and I expect it to find something.

---

## What This Means If You Use OneCamp 🚀

**Most of it needs nothing from you.** The doc-authority fix, the DM recipient rule, the delegation gate, the retryable writes, the UTF-8 truncation, the search-index guarantee and the forwarded-message fix are all simply in. If you'd been bitten by any of them, you'd have had no way to tell — which is rather the point of writing them up.

**Set per-model token limits — Admin → AI → Allowed models.** If you allow models with different context windows, give each row its own limit, or leave it at zero to inherit the workspace default. There's a **Detect** button that asks the provider. This matters most if you run local models: the context size is applied when the client is built, so a wrong number doesn't just trim your prompt, it runs the model small.

**External agent access is off until you turn it on — Admin → MCP.** An admin decides whether MCP is exposed at all and what it can reach. When you do enable it, issue credentials bound to an agent identity rather than a person's general-purpose token, and set the read and write budgets separately.

**Check your autonomy settings if you run unattended agents.** Sending email, creating calendar events and commenting on GitHub now genuinely require confirmation at every autonomy level, including full. If you had an agent quietly doing any of those unattended, it will now ask.

**Self-hosters: the server refuses to boot on schema drift.** That's deliberate. If it stops on an upgrade, run your migrations rather than working around it — booting against a database you don't match is how data gets written into the wrong shape.

**If you run the marketing/blog stack, take the media and rendering fixes.** The stored-XSS and inline-SVG issues both execute on the origin where an admin session lives.

---

*[OneCamp](https://onemana.dev/buy) is an open-source, self-hosted, AI-era workspace: chat, docs, tasks, projects, calls, boards, tables, a programmable API, and AI teammates that can see, calculate, run code, query your databases, read your documents, and open pull requests — on infrastructure you own, through the model you choose. As of this week, outside AI clients can reach it too, through an authority rule that is an intersection with a real person's live permissions and never a union. Find it at [onemana.dev](https://onemana.dev/buy).*

*All of it runs on your own infrastructure, with your own models. Which is the reason it has to be right: there's no operations team of mine sitting between a bug and your workspace.*
