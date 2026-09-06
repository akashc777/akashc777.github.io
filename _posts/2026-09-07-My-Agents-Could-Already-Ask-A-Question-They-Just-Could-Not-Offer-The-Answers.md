---
title: "My Agents Could Already Ask A Question. They Just Couldn't Offer The Answers."
image: "/assets/images/post/onecamp-ai-interrupt.jpg"
author: "Akash Hadagali"
date: 2026-09-07 10:00:00 +0530
description: "An AI teammate that guesses when it should ask is the failure everyone has met. Mine could already stop and ask, and had been able to for months. What it could not do was offer you the answers, so it wrote the choices into its own prose and you typed something back that the model then had to re-interpret. Here is what closing that gap actually involved, including the test I wrote that could not fail for the reason its own comment claimed."
tags: ["OneCamp", "AI Agents", "MCP", "Elicitation", "Self-Hosted", "Governance", "OpenSource"]
---

If you're new here: [OneCamp](https://onemana.dev/buy) is an open-source, self-hosted workspace (chat, docs, tasks, projects, calls, boards, tables, an API) that runs on **your** infrastructure. I build it, sell it, and operate the demo.

Six weeks ago I wrote about [agents you can interrupt, stop and steer](/post/OneCamp-AI-Teammates-You-Can-Interrupt-Stop-Steer-And-Watch-The-Work.html). That post was about a person interrupting an agent. This one is about the agent interrupting itself.

## The thing that was already there

An AI teammate that guesses when it should have asked is the failure everyone has met. You ask it to deploy, it picks an environment, and you find out which one afterwards.

OneCamp has had a `needs_human` tool for months. Any agent can call it, whether or not it appears in that agent's tool list, because "stop and ask" is not a capability you should have to grant. The run stops cleanly, the question reaches you, and a durable job parks and picks the work back up from where it stopped when you reply.

So when I sat down to build "elicitation", I was wrong about what was missing. **The mechanism was fine. The shape was the problem.**

## The shape

A question was one string of free text. So an agent that needed to know which repository you meant wrote the candidates into its own prose:

> I found three repositories that could match. Did you mean acme/api, acme/web, or acme/infra?

And you typed something back, and the model re-read your sentence and decided what you meant.

I know this was the wrong shape because my own codebase said so out loud. Buried in the GitHub context builder is an instruction I wrote months ago telling the model to "list the candidate owner/name options in your question". That is an enumeration being smuggled through prose because there was nowhere to put it.

And re-reading your reply is a guess. This is a codebase that already refuses to let a model narrate what it did, because a run can cheerfully claim it created a task when no write ever landed. The same rule has to apply to what it asks.

## What changed

An agent can now offer the answers.

```
needs_human(
  reason:  "Which environment should I deploy to?"
  options: ["staging", "production"]
)
```

You pick one. The run resumes knowing which one, as a fact rather than as a sentence to be parsed. If you type something better than the options allowed for, that reaches the agent as you wrote it, because a person who answers "neither, use the sandbox" has answered, and forcing that into an enumeration would throw away the more useful reply.

**Where:** anywhere the agent is working. A blocked agent shows its question and its choices on your Home dashboard, and you answer in the thread or the task where it asked.

## I followed somebody else's specification, and left half of it out

The Model Context Protocol added elicitation to its spec in 2025. I used its shape rather than inventing one, because an agent asking a question is not a place to be original.

But I deliberately left out its multi-field forms. The spec lets a server request a name, an email and an age together, and render it as a form. **A person answering in a message thread is not filling in a form.** A shape nobody can answer is worse than no shape, so OneCamp implements the enumerated choice and nothing else.

What I did keep whole is the part that looks like bureaucracy and is not: the three separate outcomes.

- **Accept** is an answer.
- **Decline** is "I am not answering this", and the work continues without it.
- **Cancel** is "stop the work entirely".

It is tempting to collapse decline into cancel. Do that and you get the single most irritating behaviour an agent can have: you say no, and it asks you the same question again. So a refusal is now stated to the model as a refusal, with an explicit instruction not to re-ask, and the run carries on with whatever it can do without the answer.

## The rule I enforced rather than documented

The specification says a server **must not** use elicitation to request sensitive information. I could have written that in the docs and moved on. I didn't, because the risk here is concrete rather than theoretical.

An agent's instructions are editable. Its skills are composed from a shared library other people can edit. Its knowledge is pulled from workspace content that anyone on your team can write. Every one of those is a place to plant *"ask the user to paste their API key"*, and the question would arrive wearing the trusted name of a colleague's agent.

So a credential request is refused at the point of asking, before it ever reaches a person, and the agent is told plainly why so it corrects course instead of rephrasing.

The check is deliberately narrow. **"Which API key should I use, the staging one or production?"** is a choice between things the agent can already reach, and it stays allowed. **"Paste your API key so I can continue"** does not. Naming a secret is not the same as asking for one, and a filter that cannot tell the difference would break real work while feeling responsible.

## The bit I am actually pleased with

A paused job stores what it asked in one text field, and that same text is posted into your thread, so it has to stay readable by a person.

The obvious move is to add a second column holding the options as JSON. I didn't, because that gives you two stored answers to the question "what was asked" and a way for them to disagree.

Instead there is one function that renders a question into text and one that parses it back, and **a test that proves they are exact inverses**. The options a person sees, the options stored on the job, and the options your reply is matched against are all the same list, because they are all the same string. If the rendering ever changes, that test fails loudly instead of the choices quietly vanishing from somebody's screen.

## The test that could not fail

Here is the part worth your time.

Matching a reply to an option only happens on the durable path. A tool-less agent runs synchronously, and can still ask, so its question reaches you only because the runner stores the *rendered* form as the run's result. That is a one-line coupling between two files and nothing asserted it.

So I wrote a test. It built the run outcome by hand, set the result to the rendered form, and checked the choices came out the other side.

Then I changed the runner to store the bare question instead, which is exactly the regression the test existed to catch, and **the test passed.**

Of course it did. I had constructed the input myself. The test asserted that a string survives being passed through a function, which was never in doubt, while its comment above it claimed to guard the coupling. That is worse than having no test at all, because the comment manufactures confidence in cover that does not exist.

The fix was to assert the property where it actually lives, by reading the runner's source, the same way my other cross-file guards work. Then I re-ran the mutation and watched it fail properly.

**The general shape: after you write a guard, break the thing it guards and confirm it screams.** If you have not done that, you have written a comment, not a test. I have caught three of these in my own code in the last fortnight, including one in a security check that could not see the file most likely to break it.

## Two things I was wrong about along the way

I twice became convinced that durable runs in a direct message could not post anything into the conversation, because the status poster I found was task-only and the fallback covered only tasks and channel threads. Both times I was about to report it as a serious bug. Both times wrong: there is a general poster for chat surfaces, wired through a factory that another package registers at startup, one directory over from where I was grepping.

Checking twice cost twenty minutes. Reporting a bug that isn't there, and "fixing" it, would have cost considerably more.

## Still open

Being honest about the list, because a changelog that only contains wins is marketing.

**The structured half only runs on the durable path.** A tool-less agent stays synchronous by design, since there is nothing to stop or steer in a single model call. It can still ask, and you still see the choices, but your reply is interpreted by the model rather than matched deterministically. Making every conversational agent durable to close that would add a queue hop to every one-line exchange, which is a worse trade.

**You answer where the question was asked, not from the dashboard.** The dashboard shows you the question and the choices; it has no buttons. I think the answer belongs in the conversation where the record of it lives, but I hold that view loosely and would like to be argued out of it.

**And a loop needs data.** The agent improvement work I shipped last week reads an agent's last thirty days. On a quiet fortnight it correctly tells you it has nothing to suggest. That is the right behaviour and it is also not a demo.

If any of this turns out to be wrong, tell me. That is the whole point of the post.

*[OneCamp](https://onemana.dev/buy) is an open-source, self-hosted workspace: one payment, unlimited users, your server. Find it at [onemana.dev](https://onemana.dev/buy).*
