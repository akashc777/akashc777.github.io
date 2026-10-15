---
title: "A close look at OneCamp's chat found more than fifty things wrong"
image: "/assets/images/post/onecamp-chat-fixes.jpg"
author: "Akash Hadagali"
date: 2026-10-15 19:45:00 +0530
description: "I set out to compare OneCamp's chat with Slack, one part at a time. Before I got to anything Slack has, the review found more than fifty things our chat got wrong by its own rules: thread replies that told the wrong people or nobody, a group that went silent once someone was added, a desktop app that never showed a notification, and conversations that only went live after a reload. They're fixed in the latest release, in both editions."
canonical_url: "https://onemana.dev/blog/a-close-look-at-onecamps-chat-found-more-than-fifty-things-wrong"
tags: ["OneCamp", "Chat", "Reliability", "Security", "Slack Alternative", "Self-Hosted", "OpenSource"]
---

If you're new here: [OneCamp](https://onemana.dev) is a self-hosted workspace (chat, tasks, docs, calls, calendar and AI agents) that you install on your own server. It is [open source](https://github.com/OneMana-Soft/OneCamp) and free for up to 25 people.

**If you run OneCamp, update to the latest release, with AI or without.** Some of the fixes below are about private messages that were less private than they should have been.

This week I started comparing OneCamp's chat with Slack, one part at a time: how a message travels, who gets told about it, what a thread does, and how search, links and commands behave. I expected a list of things Slack does and we don't. The first list was a different one: things our chat got wrong by its own rules. More than fifty of them are fixed in the latest release.

## Who gets told

Most of the list was about a notification going to the wrong person, or to nobody.

- **Thread replies skipped the people they were for.** On the default setting, a reply never pushed to the person who started the thread, or to anyone it @mentioned. Someone on "mentions only" would have heard; someone on "all" didn't. And on "Mentions and threads you're in", a thread you had replied in never pushed at all. A reply now reaches the thread's people on every setting.
- **A group went silent once someone was added.** A group conversation's id was made from the people in it, so adding someone gave the group a new id, and everyone's notification settings stayed behind with the old one. From then on nobody in the group was told anything, @mentions included. The settings now move with the group, and groups that went quiet are heard again after the update.
- **One long message switched off push for everyone it went to.** A message bigger than the push service accepts (about 4 KB), or any passing error from that service, made the server forget the device of every person it was sending to. They got no pushes at all until they opened the app again. Now the pushed text is cut to fit, a device is forgotten only when the push service says it no longer exists, and the app registers its device every time it opens.
- **Reactions told the wrong person.** Reacting to a direct message buzzed your own phone, and its author heard nothing. Now the author is told.
- **The desktop app never showed a notification.** The app exists so that messages reach you while it sits in the background, and it never raised a single one: the web app inside it only knew how to use browser push, which the app's window doesn't have. Now direct messages, mentions, replies, calls and reminders raise a native notification, by the same rules as push, pauses and focus time included.

Smaller ones: a second person's notification no longer replaces the first's on your screen, and the conversation you're reading no longer pops a preview for every new message. Opening Home no longer clears the Inbox badge, and the badge counts only what the Inbox shows. During someone's focus time, the message box says so and until when, and Notify anyway reaches them.

## Private stays private

These are the reason to update soon. All of them are fixed:

- A message could be read from outside the conversation it was posted in, and an edit could reach a conversation other than its own.
- A thread reply's text could reach people outside the channel, by email and in Activity.
- A deleted message stayed readable in its thread, through guest links and wherever it had been forwarded, and a deleted direct or group message could still be edited.
- Someone removed from a private channel, or deactivated, kept receiving its new messages until they reloaded.
- Any moderator of a private channel could make it public, history and files included. Now only a workspace admin can, after a confirmation, and the channel says who changed it.
- Workspace-wide webhooks received the text of every direct and group message. No webhook receives those now.
- Six unused search routes that handled typed text unsafely are gone.

If you have scripts or integrations, the [changelog](https://onemana.dev/changelog/2026-10-12-a-workspace-with-nothing-in-the-way) lists what changed for them, webhooks most of all.

## Conversations stay live

- **A new conversation only went live after a reload.** A direct message, group or channel that started, or that you joined, after you opened the app didn't stream. If someone sent you a first direct message, nothing arrived until you reloaded. Now it streams at once.
- **Reconnecting had two holes.** The first reconnect after opening the app never caught up on what you had missed, and after about three minutes offline the app stopped trying while still saying it was reconnecting. Now every reconnect catches up, the app keeps trying, and it offers Reconnect.
- **A duplicated browser tab took the live connection from the original.** Each tab has its own now.
- **Live edits, reactions and reply counts snapped back to their old values.** They stay now.
- **A sent message could say Not sent**, even though the server had it, and Try again posted it twice.
- **Scrolling back skipped messages.** Any message sent in the same second as the edge of a page was never fetched. It's the same mistake the Activity feed made in the last post: times cut to the second.

## Threads, links and commands do what they say

- A reply typed in one thread followed you into the next, and Enter posted it there. Each thread keeps its own draft now.
- A link to an older message, from Activity, search, Later or Home, opened a thread that spun for ever.
- Every email about a direct message, group, thread reply or call opened an empty conversation. Now it opens the right one.
- `/remind @someone` reminded you instead of them. It now reminds them and says who asked, and a reminder that fires while you're away waits in Later.
- `/poll` in a direct or group conversation made a card only you could see. It now posts a real poll.
- With two conversations side by side, a slash command ran in both.
- Enter inside a list or a code block sent the message. Now it adds an item or a line, and Ctrl or Cmd with Enter sends.
- Search never returned channels, and a channel you had just joined stayed out of search and slash commands for up to an hour. Search also said "20 results" when it had stopped at 20; it now says "20+", and Show more fetches the rest.
- Most apps from the directory installed and then answered every command with an error. An app now says Needs setup until its commands have somewhere to go.
- Slack imports lost every thread reply in a channel.

And for bigger installs: on servers that run the API apart from the workers, chat events never reached workflows or the Slack bridge, and with more than one worker a scheduled message or a reminder could be sent twice. Both are fixed, and a system check now says when no worker is taking events.

## How it was checked

The fixes ran on the [live demo](https://onemana.dev/demo) before they were released. Then a second review went through all of them. It found nothing blocking and nine things worth doing better, and six of those were released with them.

The other list, what Slack does and we don't, is written too. The first part of that work is on the demo already.

## Update

To update a server you run, follow the steps under Updating on the [installation page](https://onemana.dev/docs/installation#updating).
