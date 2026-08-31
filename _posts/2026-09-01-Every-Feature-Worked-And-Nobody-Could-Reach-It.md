---
title: "Every Feature Worked and Nobody Could Reach It"
image: "/assets/images/post/onecamp-unreachable.jpg"
author: "Akash Hadagali"
date: 2026-09-01 12:00:00 +0530
description: "Last week I wrote about features that were lying. This week is the sequel with a different shape: features that were telling the truth and were unreachable. The meeting recap needed a recording nobody made. Browser transcription, the default, kept nothing at all. A meeting notes document existed with no link to it. An agent activity feed had a finished API and no interface. Skills had a full lifecycle in the database and no way to edit one."
tags: ["OneCamp", "Product", "AI", "Defaults", "Go", "TypeScript", "Self-Hosted", "OpenSource"]
---

If you're new here: [OneCamp](https://onemana.dev/buy) is an open-source, self-hosted workspace (chat, docs, tasks, projects, calls, boards, tables, an API) that runs on **your** infrastructure. I build it, sell it, and operate the demo, which means I get to find out what breaks.

[Last week's post](/post/Every-Test-Passed-And-The-Feature-Was-Lying.html) was about features that made false claims. This week is the sequel and the shape is different. Nothing lied. Everything worked. **Almost none of it could be reached.**

## Start with the one that stung

OneCamp's meeting recap posts a summary, the decisions and the action items into the channel after a call. It is the headline AI feature.

It only ran if somebody pressed record.

Four independent layers enforced that, and every one of them is correct in isolation. The transcription agent refuses to send a line without a recording id. The API rejects a transcript that has none. Transcripts are stored as children of a recording node, so with no recording there is nowhere to put them. The recap skips a call with too few lines.

Put together: a team with a "we do not record our meetings" policy got no recaps, ever, with no error to search for. And that is exactly the kind of team that buys a self-hosted workspace.

I fixed it by giving a call its own identity so a transcript can hang off the call instead of the recording. Wanting written notes and wanting a stored video of your colleagues are different decisions, and they are separate settings now.

## Then I found the bigger one

`defaultMode = ModeFrontend`.

Out of the box, OneCamp transcribes in each participant's browser, draws the captions, and throws the words away when the call ends.

So on a **fresh install** there was no transcript, no recap, no meeting notes and nothing for a workflow to react to, until an admin found the transcription settings and switched to the server-side agent. Every piece of AI meeting work I had shipped was real, correct, and invisible to a new customer.

The browser was already producing the text. It was already publishing it to the room so other people saw captions. It just never reached the server.

## The pattern, once I started looking

- The meeting notes **document** landed with no link from the recap that described it. It appeared in the docs list with no path from the call it came from.
- The agent activity feed, the end-user "show your work" timeline, had a finished, permission-scoped API endpoint and **no caller anywhere in the frontend**.
- The acceptance record for what agents proposed showed only on the admin page, so the person whose work the agents were doing could not see any of it.
- Skills had a revision history, blast radius and revert in the database and **no way to edit a skill at all** from the interface. The update endpoint had no caller either.

Five features. All built. All correct. None reachable by the person they were for.

## Why this happens, and it is not laziness

A feature has two halves and only one of them is satisfying to build. The mechanism is a problem with a right answer: the transcript hangs off the call, the acceptance rate is approved over decided, the revision stores the previous text. You know when it is done because it is testable.

Reachability has no such moment. There is no test that fails when a working endpoint has no button. The build is green. The suite passes. The feature is finished by every measure the tooling has.

The only thing that catches it is asking a duller question than "does it work": **who would ever see this, and how would they get there.** I was not asking it. I was asking whether the code was right, and it was, every time.

## The tell I should have noticed sooner

Every one of these has the same fingerprint: **something was built for a person and then measured by a machine.**

An endpoint with no caller passes every test it has. A feature behind a default nobody changes passes too. A document with no link is indistinguishable, in CI, from a document with one. The tooling I built to keep myself honest, and I have built a lot of it this month, is very good at "is this correct" and completely blind to "is this reachable".

Correctness has a proxy. Reachability does not. So it does not get measured, and what does not get measured is where the work quietly does not land.

## What I actually changed

Making a thing reachable is usually small, which is the annoying part.

The browser now posts the final version of each utterance to the server. That is a new endpoint and about twenty lines in the transcriber, and it turns the default install from "no AI meeting features" into "all of them".

The endpoint took the care, not the wiring. The agent's transcript API is server-to-server behind a shared secret and a browser cannot hold one, so this one is authenticated as the person: the speaker comes from the session and never from the request body, presence in the room is checked against the call server, and the call identity is resolved server-side rather than accepted. The worst a participant can do is put words they did not say into a call they are actually in, under their own name, which is what speaking already lets them do.

The recap links the document. The activity feed got a card. Skills got an editor. None of it was hard. All of it was invisible.

## What I would tell you to copy

- **A green build is not a shipped feature.** It means the mechanism is right, which is the half you were going to get right anyway.
- **Ask who reaches it and how.** Not "is this correct", which your tests already answer, but the route a real person takes to the thing you just built. If you cannot name the click, it is not shipped.
- **Look hard at your defaults.** Mine turned every AI meeting feature off for every new customer, and no test in the world was going to tell me.
- **An endpoint with no caller is a smell.** So is a setting nobody has ever changed. Both mean a decision got made and nobody was told.

## Still open

The default is fixed and browser transcription still only works in Chrome and Edge, because that is the only place the Web Speech API exists. A participant on Firefox or Safari contributes nothing. The recap now says so when it happens rather than presenting a partial transcript as a whole one, but the gap is real and the honest fix is the bundled speech server, which now ships and runs on your own machine.

All of this is in v2.7.0 and v1.5.0, out today. The other half of this release is the unglamorous bit: [AI governance is mostly boring plumbing](/post/AI-Governance-Is-Mostly-Boring-Plumbing.html). What that looks like as a changelog, with the click path for each change: [a changelog is useless without directions](/post/A-Changelog-Is-Useless-Without-Directions.html).

*[OneCamp](https://onemana.dev/buy) is an open-source, self-hosted workspace: one payment, unlimited users, your server. Find it at [onemana.dev](https://onemana.dev/buy).*
