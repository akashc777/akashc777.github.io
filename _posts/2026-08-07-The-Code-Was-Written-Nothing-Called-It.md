---
title: "The Code Was Written. Nothing Called It."
image: "/assets/images/post/onecamp-security-resilience-hero.png"
author: "Akash Hadagali"
date: 2026-08-07 10:00:00 +0530
description: "Instead of shipping a feature this week, I went looking for gaps in what OneCamp had already shipped. The same defect turned up four times: a mechanism that was finished, correct, unit-tested, documented, and unreachable. Two of those were hiding real bugs, including one where forwarding a message to a group chat and a DM at once delivered the group's message into the DM. Here's the pattern, the two bugs, the test that now fails the build when it recurs, and why I stopped trusting a test that has never been seen to fail."
tags: ["OneCamp", "Go", "Testing", "CodeQuality", "StaticAnalysis", "DeadCode", "Debugging", "Self-Hosted"]
---
Most of these posts are about something new: agents in your channels, a coding agent that opens pull requests, a whiteboard, tables. This one isn't. This week I went the other way and audited what was already there, because "shipped" and "working" are not the same word.

I expected to find rough edges. What I actually found was the same defect four times, wearing different clothes.

---

## The Shape 🔍

A mechanism, finished and correct, with no caller.

Not half-written. Not TODO-shaped. Complete, sensible, documented code that nothing in the program reaches:

- A **context-overflow rescue** that recomputed a smaller target when a prompt exceeded a model's window. Written. Unit-tested. Never called.
- A **GitHub bot-login resolver** that fetched the login for the connected OAuth token, cached it for 30 minutes, retried three times with backoff, and had its cache invalidated in two separate places when the token changed. Never called. The cache therefore never held anything, and both invalidations were no-ops.
- A **single-request ZIP entry reader** for Slack imports, correct in every detail, unreachable because the function that produced its input threw that input away with `_`.
- A **display-name builder** for group chats, which fed a field that nothing downstream ever read.

This class of bug is unpleasant precisely because nothing looks wrong. The code is good. It passes its tests, because its tests call it directly. It reviews well. There simply is no edge from the running program to it, and a compiler will not tell you: Go is perfectly happy with an unexported function nobody calls.

The reason it matters is that a mechanism which is never invoked is indistinguishable, in production, from one you never wrote. And you don't know which of the two you have.

---

## Two of Them Were Hiding Real Bugs 🐛

### 1. Our own comment could restart the agent

When someone comments on a pull request an agent opened, a webhook fires and the agent picks its work back up. That's the feature: you review, you comment, it responds.

The guard on that path skipped comments where `sender.type == "Bot"`, with a comment saying a bot's comment must never self-drive the agent. Correct intent. It covers GitHub Apps.

It does not cover how OneCamp itself comments. The `github_comment` tool posts through the connected person's OAuth token — on the user's behalf — so a comment *OneCamp wrote* arrives from GitHub as `sender.type: "User"` and sails past the check.

Which means an agent holding that tool could comment on the PR, be woken by its own comment, comment again, and keep going. Every lap spends tokens and posts publicly on someone else's repository.

The fix needed exactly one thing: the login of the token we post as, to compare against the comment's author. That resolver was the second item on the list above — written, cached, retried, invalidated in two places, called by nobody. The author's login was already being parsed out of the webhook payload, and already being sent downstream to listeners. Only the guard ignored it.

```go
func prCommentMayDriveAgent(senderType, commenterLogin, botLogin string) bool {
    if strings.EqualFold(strings.TrimSpace(senderType), "Bot") {
        return false // a bot/app comment must never self-drive the agent
    }
    botLogin = strings.TrimSpace(botLogin)
    if botLogin != "" && strings.EqualFold(strings.TrimSpace(commenterLogin), botLogin) {
        return false // our own comment, posted through the user's token
    }
    return true
}
```

An empty `botLogin` deliberately does not block. Failing to reach GitHub for a login is not a reason to silence every human comment on every PR.

### 2. A forwarded message went to the wrong conversation

This is the one that bothered me.

Forwarding a message in OneCamp lets you pick several destinations at once: some channels, some group chats, some DMs. The code walked your chosen destinations and accumulated parallel slices — one of DM nodes, one of grouping IDs, one of participant lists — then two consumers paired them up **by slice index**: one publishes over MQTT for live delivery, the other indexes into OpenSearch for search.

The DM node slice grew for *both* group chats and 1:1 DMs. The grouping-ID and participant slices grew *only* for 1:1 DMs. And the destination order is whatever order you clicked.

So forwarding one message to a group chat **and** a DM was enough. Index 0 of the node slice was the group chat; index 0 of the grouping-ID and participant slices described the DM. The group's message got published to the DM's topic and indexed under the DM's grouping ID and participant list — in front of people who were never in that group. Meanwhile the actual DM forward was skipped entirely by a `i >= len(...)` guard and never indexed at all.

The MQTT path is the part I keep thinking about. It read the correct value, and then overwrote it:

```go
grpId := dgraphDm.GroupingId   // correct, set when the node was built
if i < len(groupingUUIDs) {
    grpId = groupingUUIDs[i]   // ...and here is the bug
}
```

The node knew which conversation it belonged to the whole time. The positional lookup wasn't a redundant safety net; it *was* the defect.

The fix is to pair by identity — chat UUID — instead of by position, in a small pure function that can be tested without Dgraph, MinIO or a broker:

```go
participants, isOneToOne := participantsByChatUUID[chat.Uuid]
if !isOneToOne {
    continue // group-chat forward: indexed elsewhere
}
```

And the dead helper that led me here? It really was superseded — group-chat naming is handled correctly elsewhere. But asking *why* it existed led to the field it would have fed, `chatToNames`, which was being collected on every forward, passed through a function call, and read by absolutely nothing.

If there's one portable lesson: **parallel arrays that grow under different conditions are a bug waiting for a schedule.** They look fine for as long as every destination type happens to be present, or absent, together.

### The sweep afterwards

Finding one instance of a defect class by accident is not the same as knowing whether there are others, so I went looking for every place a loop bounded by one slice's length indexes a second slice. Nine sites. Six of them write both slices at the same index in a single statement, so they cannot drift. Three were bulk Postgres writers taking parallel lists from a caller — and they didn't agree with each other. One had the length check. One had none, on two independent pairings. And one had this:

```go
if len(toUUIDs) == 0 || len(toUUIDs) != len(grpIDs) {
    return nil
}
```

That treats "nothing to do" and "you handed me inconsistent data" as the same outcome. If a caller's two lists ever drifted, every DM notification in the batch was skipped — no error returned, nothing logged, notifications simply never arriving and no trace to explain why. The empty case really is a no-op; a mismatch is now an error.

Worth noting the direction nobody guards: a slice that's too *long* doesn't panic, it silently drops rows, because the loop stops at the shorter one. Only the short case fails loudly.

The strongest argument for adding the missing checks wasn't my judgement — it was that one of the three already had one. The invariant was already recognised in this codebase. Two writers just never said it out loud. They now share a single helper, so the rule reads the same everywhere and the error names which inputs disagreed and by how much, which is what you want when the drift happened in code somewhere else.

No live caller violates any of them today. The sweep found no second instance of data actually being mispaired.

---

## Making It a Build Failure ✅

Finding four instances of one pattern by reading code is luck. I'd rather it be arithmetic.

So there's now a test that builds a call graph for every package in the module and walks it. The roots are everything reachable from outside: exported functions, any method (a method can be reached through an interface), `init`, `main`, and every package-level `var`/`const` initialiser, which runs whether anything calls it or not. An unexported function is alive only if some root reaches it through a chain of calls. Anything else fails the build with a file and line.

There is an escape hatch, and it's deliberately awkward: a marker in the function's own doc comment saying *why* it's unreachable. Registration hooks and reflection are real. "I couldn't be bothered" has to be typed out next to the code, where a reviewer sees it.

The first version of this check counted references rather than walking them, and it had a flaw I want to name because it's easy to fall into: **a cluster of dead functions hides itself.** A dead helper calling a second dead helper gives the second one a reference, so only the first gets reported. That wasn't hypothetical — a dead `sanitizeFileName` kept its own `sanitizeString` invisible exactly that way. A reachability walk has no such blind spot: neither member of a mutually-recursive pair is reachable from a root, so both are reported.

It scans the whole module now, and it reports nothing. That's worth saying plainly rather than dressing up: the upgrade found no new dead code today. Its value is that the blind spot is closed before the next one gets written.

---

## I Stopped Trusting Tests That Have Never Failed 🧪

Here's the habit that changed how I work this week.

**A test that finds nothing is indistinguishable from a test that does nothing.** A green checkmark is evidence about the test only if you've seen the test go red for the right reason.

So every fix got the same treatment: put the bug back, confirm the new test fails, restore, and confirm the restored file is byte-identical to what it was before. Not once did I skip it, and it earned its keep — once, a test I was confident in passed against the reverted bug, which meant my edit hadn't applied at all. I'd have shipped a fix with a test that proved nothing.

Reverting the forwarded-message fix produces exactly the defect described above:

```
indexed the wrong chat: got "chat-in-the-group", want the DM's chat "chat-in-the-dm"
chat "chat-a" paired with grouping id "dm-b", want "dm-a"
```

And for the dead-code checker, whose whole job is to find nothing, I planted a probe: two unexported functions calling only each other, reachable from nowhere. The walk named both. The old reference-counting version had passed them.

---

## The "Needs Integration Tests" Excuse 🧵

The unwired ZIP reader had a note on it explaining that switching it on deserved a real Slack export end to end. I'd written that note. It was wrong, and it's a good example of a comfortable excuse.

Slack exports are read straight out of object storage over HTTP range requests, so nothing has to be staged to disk — a 10 GB export works the same as a 10 MB one. The optimisation fetches an entry's compressed bytes in **one** ranged request instead of letting `archive/zip` pull them through `ReadAt` in ~32 KB pieces. Daily message files are both the most numerous entries in an export and the largest, so that's thousands of HTTP requests collapsing into a handful.

But look at what could actually break: an entry's data offset, its compressed length, the inclusive end of a range, and whether the decompressor *and* the body underneath both get closed. None of that is about the storage backend.

So I put the ranged fetch behind a one-method interface, built real ZIP archives in memory, served ranges out of them, and compared byte-for-byte against what `archive/zip` itself produces — Deflate, Store, empty, and large entries. Then asserted the properties that matter: exactly one request per entry, at exactly `[DataOffset, DataOffset+CompressedSize)`, not a byte more, because one byte more reads into the next entry's local header.

Changing the fetch length to `compSize+1` fails five assertions, including corrupted content on stored entries. That's the off-by-one this design is most exposed to, caught on a laptop in 30 milliseconds.

Two honest footnotes. This doesn't test MinIO's own range semantics — but those are exercised on every import already, because reading the archive's central directory *is* a ranged request; if they were broken, nothing would import. And one of my own test cases was initially useless: I used a Deflate entry with an empty body to cover the "zero compressed bytes" branch, and deflating an empty string still produces a few bytes, so that branch was never reached. A stored empty entry reaches it.

Also worth noting what the reader is wired into: only the daily message files. Manifests like `users.json` are under a megabyte, and a second code path there would buy nothing. The zip-bomb limits that wrap every entry read are untouched.

---

## What This Still Doesn't Catch ⚠️

Reachability is computed *within* a package. That's the right scope for unexported functions, since nothing outside can name them. But the roots are trusted: an exported function that is itself never called anywhere keeps everything beneath it alive.

So a pass means no unexported function is orphaned. It does not mean every exported one is used. Finding those needs a cross-package graph over exported names, and that's the next thing.

---

## The Takeaway

Features are the visible part of a product. This week was about the parts that were already marked done — and the uncomfortable discovery that "done", "tested", and "running" are three separate claims that need three separate kinds of evidence.

The two bugs that mattered were both found the same way: by refusing to delete a piece of dead code until I understood why someone wrote it. One turned out to be the missing half of a live security guard. The other pointed at a message being delivered to the wrong conversation. Neither would have been found by deleting them on sight, which is exactly what a tidy-up pass does.

OneCamp is self-hosted, so all of this runs on your infrastructure with your models. Which is also why it has to be right: there's no operations team of mine standing between a bug and your workspace.
