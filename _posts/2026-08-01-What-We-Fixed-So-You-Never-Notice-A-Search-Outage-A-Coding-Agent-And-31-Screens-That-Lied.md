---
title: "What We Fixed So You Never Notice: A Search Outage, a Coding Agent That Couldn't Run, and 31 Screens That Lied to You"
image: "/assets/images/post/onecamp-security-resilience-hero.png"
author: "Akash Hadagali"
date: 2026-08-01 10:00:00 +0530
description: "No new features in this one. A search node was killed by someone pasting a screenshot into a document. The coding agent turned out to be unable to work in the exact configuration it shipped with. And 31 screens told people they had no data when the truth was a failed request. This is the unglamorous half of building software, written up honestly, because the bugs are more instructive than the features."
tags: ["OneCamp", "Go", "NextJS", "OpenSearch", "Reliability", "Accessibility", "UX", "Security", "Self-Hosted", "OpenSource"]
---
The last few posts were about new capability. This one is about the other half of the job, and I think it's the more useful read.

Three things happened. Someone pasted a screenshot into a document and took down search. The coding agent turned out to be structurally unable to work in the configuration it ships with. And a large number of screens had been quietly telling people their data was empty when the real answer was "the request failed."

None of these are features. All of them are the difference between software you trust and software you tolerate.

---

## A Pasted Screenshot Took Down Search 🖼️

The symptom was a stopped container and a Java stack trace ending in `OutOfMemoryError`. The cause took a while to find and turned out to be almost mundane.

When you added an image to a document, the editor uploaded it to object storage and stored a URL. Sensible. But if that upload *failed* for any reason, the editor fell back to embedding the entire image directly in the document as a base64 data URI.

That fallback was written to be helpful. It inverted the exact control that had just refused the file. The backend correctly rejects an oversized upload — and the only consequence of that rejection was that the image got embedded anyway, in the document body, where it was stored and then handed to the search index as text to be analysed.

Then I found the worse door. **Pasting never went through the upload path at all.** Copy content from a word processor or a webmail client and the HTML brings `<img src="data:image/png;base64,…">` along with it. No upload had to fail for this to happen. Pasting a screenshot into a page is completely ordinary behaviour, and it was quietly putting megabytes of binary into documents.

Search then tipped over on a single write, because parsing one of those documents costs several times the payload in memory at once.

**What it does now.** Paste an image and it appears immediately, then quietly becomes a hosted image — it uploads itself in the background and the document ends up referencing storage like any other image. That's the behaviour people already expect from a modern editor; it just wasn't there.

Behind that, four independent layers now bound this: the editor never embeds, the indexing layer strips inline payloads and caps every field, the write route caps request size and returns a proper error instead of a vague failure, and the search cluster is configured to refuse what it can't parse rather than dying trying.

**The lesson I keep relearning:** a fallback that "degrades gracefully" is a control that can be bypassed. The failure path deserves as much scrutiny as the success path, because it's the one that runs when something is already going wrong.

---

## The Coding Agent Couldn't Run Where It Ships 🔧

I went looking for bugs in the code-PR feature and found eight. One of them meant the feature could not work at all in its own documented deployment.

The coding sandbox builds a deliberately clean environment for the commands it runs, so a secret in the runner's own environment can never leak into a build script. Good instinct. It also stripped the proxy settings — and in the shipped configuration, that proxy is the *only* route out of the sandbox to reach GitHub. Every clone and every push failed with a network error.

The containment check kept passing the whole time, because it tests the proxy from its own separate container. It proved the guard worked. It never proved anything could get *through* the guard.

Others in that batch, briefly: a change made entirely of **new files** measured as zero and got discarded, because `git diff` can't see untracked files — so "add a test file" silently reported "I couldn't produce a change." A build gate that backgrounded anything hung far past its own timeout. And the PR body claimed tests had passed when the suite was empty, because an empty test suite exits successfully.

That last one bothered me most. A false claim in a PR body is worse than no claim, because a reviewer relies on it to decide how hard to look.

**And a change of identity.** Code PRs used to push using the workspace admin's GitHub connection. That means every commit an agent wrote was authored by an admin who had never seen the code — which defeats review, lets them approve their own pull request, and gave every member who could task the agent that admin's reach across every organisation they belong to.

Agents now push with **your** GitHub connection. GitHub enforces the boundary, the pull request carries the identity of the person who actually asked, and the check confirms you have *write* access before spending a run rather than discovering it at the final step.

---

## 31 Screens Stopped Lying To You 📊

This is the one with the widest reach, and it's embarrassingly simple.

When a request failed, a lot of screens rendered their empty state. "You have no tasks." "No agents yet." "Nothing here."

That's not a cosmetic issue. Telling someone their data is *gone* when the truth is *we couldn't reach the server* is the most alarming possible way to fail. I've watched people refresh, log out, and start hunting for a support channel over what was a five-second network blip.

Thirty-one surfaces now distinguish the two, with a test that keeps them apart so the distinction can't quietly rot back.

While in there:

**Seventy icon-only buttons got accessible names.** If you use a screen reader, a row of unlabelled icons is a row of "button, button, button." These are now announced properly, with a test that stops new ones shipping unnamed.

**Seven destructive actions now ask first.** They used to fire on a single click, with no confirmation and no undo.

**Notification taps stopped landing on broken pages.** One notification type routed to a malformed URL — you'd tap a notification and arrive somewhere that didn't exist.

**Spinners became skeletons.** Twelve loading states now hold the shape of the content that's arriving, so the page stops jumping around underneath you when it lands.

**Small type came up to a readable floor**, and thirteen different colours expressing four meanings became four consistent ones.

---

## Reliability You Shouldn't Have To Think About 🛡️

Less visible, more important.

A panic in background work no longer takes down the server — previously one failing import provider could end the process for everyone. Every database iterator is now closed and checked, which is the class of bug that leaks connections until the pool is exhausted an hour later and the cause is nowhere near the symptom. And a test now pins which routes are reachable without authentication, so a route can't lose its guard in a refactor without the build failing.

---

## Why Write This Up 📝

It would be easy to ship these quietly and only post about features. I think that's the wrong instinct, for two reasons.

The first is that for anyone self-hosting OneCamp, **this is the post that matters**. You're running this on your own infrastructure. Knowing that a search node can be killed by a pasted image — and that it now can't — is more useful to you than another capability announcement.

The second is that the bugs are more instructive than the features. Every one of these has the same shape: a guard that was verified in isolation and never verified in composition. The secret-free environment that removed the network. The `git diff` that couldn't see new files. The empty state that doubled as an error state. Each piece was correct on its own and wrong in the system.

That's the failure mode worth naming, because unit tests don't catch it. They test the piece.

---

## How To Use It 🚀

**Nothing to do for most of it.** The search fix, the routing fix, the confirmations, the loading states, the accessibility names and the reliability guards are all just in.

**Paste images freely.** They upload themselves now. If an upload fails you'll be told, and the image will stay put for you to retry rather than silently bloating the page.

**Check your OpenSearch config (self-hosters).** If you run your own, set `http.max_content_length` to something sane like `10mb` and give the service a restart policy. Both are in the shipped compose files now.

**Reconnect GitHub if you use code PRs.** Agents push with your own connection now — **Settings → Connectors**. Unattended runs are paused until a repository-scoped GitHub App lands, deliberately, rather than borrowing an admin's identity.

---

*OneCamp is an open-source, self-hosted, AI-era workspace: chat, docs, tasks, projects, calls, boards, tables, a programmable API, and AI teammates that can see, calculate, run code, query your databases, read your documents, and open pull requests — on infrastructure you own, through the model you choose. This week it also stopped lying to you about empty lists.*
