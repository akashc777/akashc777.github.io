---
title: "The Code Was Written. Nothing Called It."
image: "/assets/images/post/onecamp-security-resilience-hero.png"
author: "Akash Hadagali"
date: 2026-08-07 10:00:00 +0530
description: "Four times in one week I found the same thing: a mechanism that was finished, correct, documented, unit-tested — and unreachable. Two of them were hiding real bugs, including one where forwarding a message to a group chat and a DM at once delivered the group's message into the DM, in front of people who were never in that group. Here's the pattern, the bugs, the check that now fails the build when it recurs, and why I stopped trusting any test I hadn't watched fail."
tags: ["OneCamp", "Go", "Testing", "CodeQuality", "StaticAnalysis", "DeadCode", "Debugging", "Security", "Self-Hosted"]
---
One of four posts about a week with no new features in it. The others were about [opening OneCamp to outside AI agents](/post/We-Opened-OneCamp-To-Outside-AI-Agents-And-Every-Gate-Found-A-Bug.html), [token limits that follow the model](/post/One-Context-Window-For-Every-Model-Was-Quietly-Wrong.html), and [text, media and browser-facing security](/post/Regex-Is-Not-A-Sanitiser-And-Other-Things-I-Got-Wrong-About-Text.html). This one is the most portable, because the pattern isn't specific to anything I'm building.

If you're new here: [OneCamp](https://onemana.dev/buy) is an open-source, self-hosted workspace with AI teammates, running on your own infrastructure through your own choice of model.

---

## Four Mechanisms That Were Written and Never Called 🔍

Code that is finished, correct, documented, unit-tested — and unreachable:

- A **context-overflow rescue** that recomputed a smaller target. Written, tested, never called.
- A **GitHub bot-login resolver**: cached for 30 minutes, retried three times with backoff, cache invalidated in two separate places on token change. Never called, so the cache never held anything and both invalidations were no-ops.
- A **single-request ZIP reader** for Slack imports, unreachable because the function producing its input discarded that input with `_`.
- A **display-name builder** feeding a field nothing downstream read.

This class is nasty because nothing looks wrong. The code is good. It passes tests, because its tests call it directly. It reviews well. There's just no edge from the running program to it — and Go won't tell you, because an unexported function nobody calls compiles perfectly happily.

The reason it matters: a mechanism that is never invoked is indistinguishable in production from one you never wrote. And you don't know which of the two you have.

Two of them were hiding real bugs.

---

## Our Own Comment Could Restart the Agent

When someone comments on a pull request an agent opened, a webhook fires and the agent picks its work back up. That's the feature: you review, you comment, it responds.

The guard on that path skipped comments where the sender type was `Bot`, with a comment saying a bot's comment must never self-drive the agent. Correct intent. It covers GitHub Apps.

It does not cover how OneCamp itself comments. The commenting tool posts through the connected person's OAuth token — on the user's behalf — so a comment *OneCamp wrote* arrives from GitHub as sender type `User` and sails past the check.

Which means an agent holding that tool could comment on the PR, be woken by its own comment, comment again, and keep going. Every lap spends tokens and posts publicly on someone else's repository.

The fix needed exactly one thing: the login of the token we post as, to compare against the comment's author. That was the unwired resolver above — written, cached, retried, invalidated in two places, called by nobody. The author's login was already being parsed out of the webhook payload and already sent downstream to listeners. Only the guard ignored it.

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

---

## A Forwarded Message Went to the Wrong Conversation

This is the one that bothered me.

Forwarding a message lets you pick several destinations at once: some channels, some group chats, some DMs. The code walked your chosen destinations and accumulated parallel slices — one of DM nodes, one of grouping IDs, one of participant lists — then two consumers paired them up **by slice index**: one publishes over MQTT for live delivery, the other indexes into search.

The DM node slice grew for *both* group chats and 1:1 DMs. The grouping-ID and participant slices grew *only* for DMs. And the destination order is whatever order you clicked.

So forwarding one message to a group chat **and** a DM was enough. Index 0 of the node slice was the group chat; index 0 of the grouping-ID and participant slices described the DM. The group's message got published to the DM's topic and indexed under the DM's grouping ID and participant list — in front of people who were never in that group. Meanwhile the actual DM forward was skipped entirely by an `i >= len(...)` guard and never indexed at all.

The live-delivery path is the part I keep thinking about. It read the correct value, and then overwrote it:

```go
grpId := dgraphDm.GroupingId   // correct, set when the node was built
if i < len(groupingUUIDs) {
    grpId = groupingUUIDs[i]   // ...and here is the bug
}
```

The node knew which conversation it belonged to the whole time. The positional lookup wasn't a redundant safety net; it *was* the defect.

The fix is to pair by identity — chat UUID — in a small pure function that can be tested without a database or a broker:

```go
participants, isOneToOne := participantsByChatUUID[chat.Uuid]
if !isOneToOne {
    continue // group-chat forward: indexed elsewhere
}
```

And the dead helper that led me here? It really was superseded — group-chat naming is handled correctly elsewhere. But asking *why* it existed led to the field it would have fed, which was being collected on every forward, passed through a function call, and read by absolutely nothing.

If there's one portable lesson: **parallel arrays that grow under different conditions are a bug waiting for a schedule.** They look fine for as long as every destination type happens to be present, or absent, together.

---

## Making It a Build Failure ✅

Finding four instances of one pattern by reading code is luck. I'd rather it be arithmetic.

So there's now a test that builds a call graph for every package in the module and walks it. The roots are everything reachable from outside: exported functions, any method (a method can be reached through an interface), `init`, `main`, and every package-level initialiser, which runs whether anything calls it or not. An unexported function is alive only if some root reaches it through a chain of calls. Anything else fails the build with a file and line.

There is an escape hatch, and it's deliberately awkward: a marker in the function's own doc comment saying *why* it's unreachable. Registration hooks and reflection are real. "I couldn't be bothered" has to be typed out next to the code, where a reviewer sees it.

The first version counted references rather than walking them, and it had a flaw worth naming: **a cluster of dead functions hides itself.** A dead helper calling a second dead helper gives the second one a reference, so only the first gets reported. That wasn't hypothetical — a dead `sanitizeFileName` kept its own `sanitizeString` invisible exactly that way. A reachability walk has no such blind spot: neither member of a mutually-recursive pair is reachable from a root, so both are reported.

It scans the whole module now, and it reports nothing. That's worth saying plainly rather than dressing up: the upgrade found no new dead code. Its value is that the blind spot is closed before the next one gets written.

One limitation remains, and it's in the file rather than in my head: reachability is computed *within* a package, which is the right scope for unexported functions since nothing outside can name them — but the roots are trusted. An exported function that is itself never called anywhere keeps everything beneath it alive. Catching those needs a cross-package graph over exported names.

---

## The Sweep Afterwards

Knowing the forwarded-message class was real, I looked for every place a loop bounded by one slice indexes a second. Nine sites. Six write both slices at the same index in a single statement, so they can't drift. Three were bulk Postgres writers taking parallel lists from a caller — and they didn't agree with each other. One had the length check. One had none, across two independent pairings. And one had this:

```go
if len(toUUIDs) == 0 || len(toUUIDs) != len(grpIDs) {
    return nil
}
```

That treats "nothing to do" and "you handed me inconsistent data" as the same outcome. If a caller's two lists ever drifted, every DM notification in the batch was skipped — no error returned, nothing logged, notifications simply never arriving and no trace to explain why.

Worth noting the direction nobody guards: a slice that's too *long* doesn't panic, it silently drops rows, because the loop stops at the shorter one. Only the short case fails loudly.

The strongest argument for adding the missing checks wasn't my judgement — it was that one of the three already had one. The invariant was already recognised in this codebase. Two writers just never said it out loud.

---

## I Stopped Trusting Tests That Have Never Failed 🧪

Here's the habit that changed how I work this week.

**A test that finds nothing is indistinguishable from a test that does nothing.** A green checkmark is evidence about the test only if you've seen that test go red for the right reason.

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

Slack exports are read straight out of object storage over HTTP range requests, so nothing has to be staged to disk — a 10 GB export works the same as a 10 MB one. The optimisation fetches an entry's compressed bytes in **one** ranged request instead of letting the standard library pull them through in ~32 KB pieces. Daily message files are both the most numerous entries in an export and the largest, so that's thousands of HTTP requests collapsing into a handful.

But look at what could actually break: an entry's data offset, its compressed length, the inclusive end of a range, and whether the decompressor *and* the body underneath both get closed. None of that is about the storage backend.

So I put the ranged fetch behind a one-method interface, built real ZIP archives in memory, served ranges out of them, and compared byte-for-byte against what the standard library produces — deflated, stored, empty and large entries. Then asserted the properties that matter: exactly one request per entry, at exactly `[DataOffset, DataOffset+CompressedSize)`, not a byte more, because one byte more reads into the next entry's local header.

Changing the fetch length to `compSize+1` fails five assertions, including corrupted content on stored entries. That's the off-by-one this design is most exposed to, caught on a laptop in 30 milliseconds.

Two honest footnotes. This doesn't test the object store's own range semantics — but those are exercised on every import already, because reading the archive's central directory *is* a ranged request; if they were broken, nothing would import. And one of my own test cases was initially useless: I used a deflated entry with an empty body to cover the "zero compressed bytes" branch, and deflating an empty string still produces a few bytes, so that branch was never reached. A stored empty entry reaches it.

---

## What This Means If You Use OneCamp 🚀

**Both bugs need nothing from you.** The forwarded-message fix and the PR-comment guard are simply in. If you'd been bitten by either you'd have had no way to tell — the forwarded message would have arrived in a conversation you weren't watching, and the agent loop would have looked like an agent being chatty.

**If you forward messages to several places at once, that's the one worth knowing about.** A single forward to a group chat and a DM together was enough to trigger it. Nothing needs re-sending; the fix only affects new forwards.

**Slack imports get faster, quietly.** Large exports now read each message file in one request instead of many. No setting, no migration.

---

The other posts from this week: [we opened OneCamp to outside AI agents](/post/We-Opened-OneCamp-To-Outside-AI-Agents-And-Every-Gate-Found-A-Bug.html), [one context window for every model was quietly wrong](/post/One-Context-Window-For-Every-Model-Was-Quietly-Wrong.html), and [regex is not a sanitiser](/post/Regex-Is-Not-A-Sanitiser-And-Other-Things-I-Got-Wrong-About-Text.html).

*[OneCamp](https://onemana.dev/buy) is an open-source, self-hosted, AI-era workspace: chat, docs, tasks, projects, calls, boards, tables, a programmable API, and AI teammates that can see, calculate, run code, query your databases, read your documents, and open pull requests — on infrastructure you own, through the model you choose. Find it at [onemana.dev](https://onemana.dev/buy).*
