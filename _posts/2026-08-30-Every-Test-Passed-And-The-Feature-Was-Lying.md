---
title: "Every Test Passed and the Feature Was Lying"
image: "/assets/images/post/onecamp-feature-lying.jpg"
author: "Akash Hadagali"
date: 2026-08-30 12:00:00 +0530
description: "Last week I wrote about things that broke silently. This week nothing broke. The build was green, the frontend's 618 tests passed, and three features were telling customers things that were not true: a meeting recap that only works for recorded calls and never says so, every bot in the product claiming to be the AI assistant including on the edition that has no AI, and a feature I shipped to the one frontend repository nobody deploys."
tags: ["OneCamp", "Testing", "Product", "AI", "Go", "TypeScript", "Self-Hosted", "OpenSource"]
---

If you're new here: [OneCamp](https://onemana.dev/buy) is an open-source, self-hosted workspace (chat, docs, tasks, projects, calls, boards, tables, an API) that runs on **your** infrastructure. I build it, sell it, and operate the demo, which means I get to find out what breaks.

[Last week's post](/post/One-Dead-Hostname-Took-Video-Calls-Down-For-26-Days.html) was about things that broke silently. A certificate expired, video calls died for 26 days, and no alarm went off.

This week is stranger, and I think more useful. **Nothing broke.** The build was green. The frontend's 618 tests passed. Every one of the bugs below survived a full test suite, a typechecker, a linter, and a production deploy, because none of them were failures. They were claims. The software said something, and the something was false.

## 1. The recap that quietly needs a recording

OneCamp's meeting recap posts a summary, the decisions and the action items into the channel after a call ends. It is one of the features people point at when they ask what the AI actually does.

It only works if somebody pressed record.

That constraint is enforced in four independent places, and I want to list them because every single one is correct:

- The transcription agent will not even send a line without a recording. `if not egress_id: return`, under a comment that says "Only save if recording involved".
- The API rejects a transcript with no egress id. A flat 400.
- Transcripts are stored in the graph as children of a *recording* node, so a room with no recording has nowhere for them to live.
- The recap skips a call with fewer than six utterances, because a two line call is noise.

Four layers, all right, all silent. Put them together and a team with a "we do not record our meetings" policy gets no recaps, ever, with no error, no warning and nothing to search for. The feature simply does not happen. And that is exactly the kind of team that buys a self-hosted workspace in the first place.

The settings card did have a sentence: "Requires call recording/transcription." Read it as an admin. It sounds like a system prerequisite, the sort of thing you satisfy once by turning transcription on. It is not. It is a condition on *every individual call*, evaluated after the fact, forever.

Two things sharpened this for me. [Notion's AI meeting notes](https://www.notion.com/help/ai-meeting-notes) transcribe audio and require no video recording at all, which makes the coupling in my own product look like a decision rather than a law of physics. And Notion states its own floor, "at least one minute of audio", right next to the feature. I had the identical floor, six utterances, and stated nothing.

That coupling is the part I am least happy about. Wanting written notes is not the same as wanting a stored video of your colleagues, and right now OneCamp makes you accept the second to get the first.

## 2. Every bot in the product said it was the AI assistant

`is_bot` is one boolean. Three completely different things carry it:

- the workspace assistant, which posts recaps and answers when you @mention it,
- one principal per configured agent, which does whatever that agent was built to do,
- the automation bot, which carries workflow and integration messages.

The profile screen read that boolean as "this is the assistant". So an agent you built to post deploy notices was titled **Assistant**, badged **AI**, given a **Chat with AI** button, and described in its own bio as posting meeting recaps and running your agents. It does none of that. Only the person who configured it knows what it does, which is precisely why the product should not have guessed.

Then the part that stings.

OneCamp ships in two editions, one with AI and one without. The AI-free edition is not a marketing tier, it is a different build with the AI packages removed. Some people buy it specifically because they do not want AI anywhere near their workspace.

The automation bot is seeded into the database with the display name **"OneCamp AI"** and the handle `onecamp-ai`. On both editions. So a customer who deliberately bought the build with no AI in it had a bot called OneCamp AI posting their workflow messages, and a profile screen describing it as an AI assistant.

I have a guard against exactly this. `noAiOnV1.test.ts` fails the build if an AI component reaches the AI-free branch. It passed, correctly, the whole time. It scans **imports**, and this string is not an import. It is seeded into the `users` table by the backend, in a Go file that both editions share.

The guard was asking the right question in the wrong language.

## 3. The feature I shipped to the repository nobody deploys

I added a workflow trigger, "a call in this channel ends". Backend, migration, webhook wiring, frontend picker, tests. Shipped it.

There are two frontend repositories. The public one is what customers build from. The private one is what the demo actually deploys. They are usually byte identical, which is exactly what makes this easy to get wrong.

The trigger went to the public one. For a day the demo backend supported a trigger that the demo's own workflow editor did not offer. Nothing failed, nothing could: they are separate repositories with no shared CI, so there is no build anywhere that sees both halves.

I only found it because I went looking for something else.

## The thing these have in common

None of them is a failure. All of them are assertions.

A test can check that a function returns six. It cannot check that "Requires call recording/transcription" is a sentence a human being will read as "this call, the one you are about to have, right now, unless somebody presses the button". A typechecker can prove the badge renders. It has no opinion on whether the badge should say AI.

Types, tests, linters, monitoring and error tracking all watch **behaviour**. Not one of them watches **claims**. And a product is mostly claims: every label, every empty state, every bot bio is the software telling a user what is true about their workspace.

## Making a claim into something that can fail

So the fixes are all the same shape. Take a sentence and give it a way to be wrong.

**Make the compiler demand the words.** The trigger help is a `Record<WorkflowTriggerType, string>`, keyed on the trigger union. You cannot add a trigger without writing the line that explains it, because it will not compile. The bot copy is a `Record<BotKind, BotProfileCopy>` covering title, badge, subtitle, bio, button and fallback name, so a new kind of bot cannot ship half described.

**Make the fallback safe rather than convenient.** An unrecognised bot kind, or a server too old to send one, resolves to neutral wording and never to the assistant. Without that rule, the first server that learns a new kind before the client does reintroduces the whole bug.

**Test the copy against the constraint.** There is now a test that reads the settings card's own source and asserts the recording condition is still stated in it. It looks pedantic. It is there because the natural next edit to that paragraph is to tighten it, decide the condition is redundant, and delete it.

**Then break it on purpose.** I edited the copy to remove the claim and watched the test fail before I believed it. A guard you have never seen fail is a guard you are guessing about, and I have shipped guards that could not fail. The one in this post is not one of them, because I checked.

**Split the question that was really two questions.** The bot's name needs to follow the *build*, not the current configuration. I had one call, `FeatureStatus`, answering "is this usable right now", which is what a button needs. A name written into seeded data needs "is this compiled in at all". Keying the name on the runtime probe would have renamed the bot every time an admin toggled AI off, and renamed the author on every message it had ever posted. So there are two calls now, with a comment explaining why anyone would want the second.

## What I would take from this

- **Your copy is untested code.** The claims in your interface are as load-bearing as your types, and nothing in a normal toolchain is looking at them.
- **One boolean should mean one thing.** `is_bot` covering three kinds of principal is the entire reason all three got the same words.
- **A constraint enforced in four places needs to be stated in one.** If you cannot point at the sentence, users cannot either.
- **Guards must be checked in the language the bug is written in.** Mine scanned imports for a string that lived in a database seed.
- **Write the guard, then break the thing on purpose.**

## Still open

The recap is honest now, and still coupled to video recording. A team that wants written notes without keeping video of their colleagues still cannot have them. Labelling that was the small fix and it was the right one to do first, because shipping a trigger whose companion data silently is not there was the thing to stop. Decoupling the transcript from the recording is the real work, and it is next.

OneCamp is [$19 once to self-host](https://onemana.dev/buy), source included, on your own server. If you want to read the fixes rather than take my word for them, they are all in the open repository.
