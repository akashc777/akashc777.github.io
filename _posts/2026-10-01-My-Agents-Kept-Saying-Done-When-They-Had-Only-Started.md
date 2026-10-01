---
title: "My Agents Kept Saying Done When They Had Only Started"
image: "/assets/images/post/onecamp-agents-finish.jpg"
author: "Akash Hadagali"
date: 2026-10-01 19:20:00 +0530
description: "I assigned real work to OneCamp's AI teammates for a week and kept a list of every time one said it had finished when it had not: it had started a coding job, or offered me three options, or written 'ready for the next step'. This is what changed so an agent now checks the thing itself before calling it done, keeps going when a long job runs out of steps, tells you privately instead of interrupting a channel, signs every action it takes, and runs your background work on the model you choose."
tags: ["OneCamp", "AI Agents", "Governance", "Reliability", "Self-Hosted", "OpenSource"]
---

If you're new here: [OneCamp](https://onemana.dev) is a self-hosted workspace whose AI teammates act as the person who sponsors them, and never more. It is [open source](https://github.com/OneMana-Soft/OneCamp) as of today.

For a week I gave the agent in our demo workspace, Release Captain, real work: tasks assigned to it, docs to update, pull requests to open. Then I kept a list of every time it said it was done when it was not. The list was long, and almost none of the entries were the model being wrong. They were OneCamp accepting the wrong things as an answer.

## What "done" used to mean

Some of the entries:

- It **started a coding job** and reported the task as finished. Starting is not finishing.
- It ended its reply with **"Shall I do A, B or C?"** and the task was marked complete.
- It wrote **"Ready for the next step"**, a sentence that answers nothing.
- It said an item was **already done** because the task said so, without looking at the thing itself.
- A delegated task stayed in **To do** the whole time the agent worked on it, so nobody could tell it had been picked up.

Each of these is now its own rule, and each one checks something the agent cannot talk its way past:

- **It checks the thing, not the label.** Before calling an item done, an agent looks at the doc, the pull request or the task itself. In the screenshot above, Release Captain refuses to mark the checklist done until someone posts the load-test numbers.
- **A question is not an answer.** A reply that ends by offering choices, or that only acknowledges the work, leaves the task open and asks you.
- **A pause written as text is still a pause.** If an agent says it is waiting for you, OneCamp treats it as waiting, and the decision reaches your phone.
- **A delegated task moves to In progress** the moment the agent starts, and the person who delegated it hears when the agent needs them.

## Long jobs keep going

Every agent run has a step limit, so a confused agent cannot spend your budget forever. The side effect was that a genuinely long job simply stopped halfway, and you found out later.

Now, when a job runs out of steps, it **continues in a new session**, carrying a short account of what it has done, up to three sessions. It only stops when the work is finished, when it needs you, or when the third session ends, and it says which.

For coding work, **a follow-up adds a commit to the agent's existing pull request** instead of opening a second one, and a running job says where it is while it works.

Agents can also now **add to an existing doc as a live edit**, with your approval, so "put the rollback steps in the launch notes" lands in the notes everyone already has open.

## Speak, say it privately, or stay quiet

An agent that follows a channel used to have two choices: answer in the channel, or say nothing. A lot of what it noticed was worth telling its sponsor but not worth interrupting six people with.

It now has a third: **tell its sponsor privately**. You get a direct message from the agent with a quote of the message that prompted it and a link back.

It can also now notice **related discussions in other channels**, the "two teams are deciding the same thing in two places" problem. That is only ever used in a private note to you. It never reads anyone's direct messages for this, never posts what it found in a channel, and a public reply still draws only on the channel it is in.

## Every action, signed

OneCamp records every action an agent takes before it takes it, in a log where each entry is chained to the one before. Until now, though, an entry proved nothing about who wrote it: anyone with database access could have added one.

Each agent now has its own signing key, derived from your server's secret key and never stored anywhere. **Every action is signed as it is recorded.** Open an agent's run history and the **Signatures** panel checks them: each one valid, edited, or unsigned, and someone holding only the database cannot produce a valid one.

## Your background work, on the model you choose

Catch-ups, morning briefings, meeting recaps and workspace memory all ran on your workspace's one default model. If that default was a large cloud model, you paid that price for every catch-up. If it was a small local model, meeting recaps came out thin.

Admins can now choose a **model per job** under **Admin, AI models**: say, a fast local model for summaries and a larger one for recaps of long meetings. Only models on your approved list can be chosen, and local-only mode still refuses cloud models. A person's own chat, an agent, and a channel with a pinned model keep the model someone chose for them.

## Smaller things that mattered

- **Deadlines** an agent finds in a message ("by Friday") now land on the right day, and a request phrased as a question ("could you send the deck?") counts as an action item.
- **You can see and end** the assistants you have connected to OneCamp (Claude, ChatGPT, and others), from your own settings.
- **Backups now include search**, so a restored workspace can find things again straight away.

All of this is in OneCamp **v2.38**. To see an agent hold the line on "done", open `#engineering` in the [live demo](https://onemana.dev) and ask Release Captain whether the checklist is finished.
