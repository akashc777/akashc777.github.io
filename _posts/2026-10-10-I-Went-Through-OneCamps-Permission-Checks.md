---
title: "I Went Through OneCamp's Permission Checks. Over Thirty Were Wrong."
image: "/assets/images/post/onecamp-permissions-audit.jpg"
author: "Akash Hadagali"
date: 2026-10-10 00:30:00 +0530
description: "A member could join any private channel by its id, edit anyone's message, or follow every conversation live through the message broker. GitHub sign-in took addresses GitHub hadn't verified. Here is what going through OneCamp's permission checks found, what v2.70.0 and v1.55.0 change, and why you should update today."
tags: ["OneCamp", "Security", "Release", "Self-Hosted", "Post-Mortem", "OpenSource"]
---

If you're new here: [OneCamp](https://onemana.dev) is a self-hosted workspace (chat, tasks, docs, calls, calendar and AI agents) that you install on your own server. It is [open source](https://github.com/OneMana-Soft/OneCamp) and free for up to 25 people.

**If you run OneCamp, update to v2.70.0 (with AI) or v1.55.0 (without AI) today, with `make update`.** Everything below is fixed in those versions. Most of it needed a member account to abuse. The exceptions are the GitHub sign-in, the rate limits, the email provider's webhook and the import downloads, which someone outside your workspace could reach.

People put their most private conversations in a workspace. A buyer who self-hosts is usually doing it because they care where those conversations go. So I stopped adding features for a while and went through the places OneCamp decides who may do something: the request handlers, the background jobs, the message broker, sign-in, and what the AI and automations can reach.

Over thirty of those decisions were wrong. Here they are, grouped by what they let someone do.

## Reading what you couldn't see

- **Any member could join a private channel by its id**, with its history and its notifications, and a member an admin removed could rejoin at once. The check sat inside an error branch that could never run. A private channel is now joined only by being added to it.
- **The message broker let anyone follow everything.** A signed-in person's browser subscribes to topics for live updates, and the broker decided from a list of topic prefixes. A subscription to `message/#` received every channel's and every conversation's messages as they were sent, private ones and other people's DMs included. The broker now asks the server before every subscription, and the server allows only topics for things the person can read. While the server can't be reached, it allows nothing.
- **A private doc's comments went to anyone with its id**, and a private doc turned up in everyone's AI search after any edit, because saving re-indexed it as public. Both are fixed, and the AI search entries now follow a doc's privacy and sharing whenever they change.
- **Removing someone from a private channel left it in their search for up to an hour**, files included. Their cached profile is now dropped the moment they're removed.
- **A workflow scoped to "any channel" ran on every message in every channel**, private ones its owner wasn't in included, and its steps could copy them elsewhere. "Any channel" now means any channel the owner can read.

## Changing what wasn't yours

- **Any member could edit anyone's message**, and it still showed under its author's name. Only the author can now.
- **Editing or deleting someone else's thread reply went through**, while the person doing it saw "Not authorized": the handler wrote the refusal and carried on. A test now walks every handler and fails on an error response that isn't followed by a return.
- **A doc's text, title and privacy could be changed by anyone with its id.** Editing takes edit access; changing who can see it takes its owner.
- **An invitee could delete the organiser's meeting**, or a booking, for everyone. Only an event's creator deletes it now; invitees leave it.
- **A message could be forwarded, or sent "also to channel", into announcement channels** that only admins post in, and into archived ones. A forward could also be checked against one destination and written to another. Every way of posting now goes through the same rules: a live channel, you in it, and an admin of it if only admins post.
- **A group message could be sent into a group the sender wasn't in.** The sender must be one of its people.
- **A channel reminder could post anywhere**, in its owner's name, including channels they had been removed from. It's checked when set and again each time it fires.

## Signing in

- **GitHub sign-in took addresses GitHub hadn't verified.** Anyone can add an address to their own GitHub account without proving it's theirs. OneCamp now takes only GitHub's verified addresses, and Google's address only when Google says it's verified.
- **Tokens were interchangeable.** The two-step challenge, handed out after the password alone, was accepted as a session. The month-long refresh token signed requests in directly, so logging out never ended it, and a copied refresh token kept working however often it was rotated. Each token now says what it is, refresh tokens are checked against the device's own, and changing or resetting a password ends your other sessions.
- **Signing in through LDAP skipped two-step sign-in.** It's asked for after a directory password as after an email password.
- **Someone an import brought in as a placeholder could sign in without joining**, without taking a seat. Only members sign in now.
- **The directory's admin groups never took admin away**, and over LDAP never gave it either. Both work now.

## Limits that didn't hold

- **Behind the proxy, every visitor counted as one.** Twenty mistyped passwords from anyone locked everyone out of email sign-in. Worse, the address came from a header the client writes, so rotating it escaped the limits entirely. The address is now the one the proxy saw.
- **A Redis outage switched off the limits** on sign-in, two-step codes and password resets, the only bound on guessing a six-digit code. They now count in the process while Redis is down. So do incoming webhooks.
- **Anyone could stop your workspace emailing an address.** The email provider's bounce webhook checked its signature only when a secret was set, and no shipped configuration set one. It now accepts only signed events; set `RESEND_WEBHOOK_SECRET` to record bounces.

## Requests your server makes

- **The list of internal addresses the server won't call was incomplete.** It missed `0.0.0.0`, the carrier-grade NAT range some clouds use for metadata, and internal addresses written inside IPv6. It's now one table of every reserved range, checked again on the exact address of each connection.
- **Imports downloaded attachments from wherever a link pointed**, including the server's own network, and sent the importing admin's token to any URL that merely contained the provider's name. Downloads now go through the same guard, over https only, and a token goes only to its provider's own host.

## AI and automation

- **An agent ran every tool as its owner, for anyone who could message it.** Asking someone's agent to "find the plan" searched their private channels and DMs. A run now carries who asked, and reaches only what both that person and the agent's owner can. There's [a post of its own](/post/An-Agent-Can-Only-Reach-What-The-Person-Asking-Can.html) on this.
- **An agent bound to an event heard about events everywhere**, private channels its owner wasn't in included. It now hears only events in places its owner can see.
- **Anyone who could manage a channel's members could put someone else's agent in it.** Only its owner or an admin can now.
- **The UI Designer's generated screens were cleaned with patterns** that missed handlers written after a slash or a quote. They're now cleaned by parsing the HTML.

## How I looked, and what stays

Most of these weren't subtle once I looked. They were the same question answered by hand in many places, and one of the copies was wrong. So the fix in most cases wasn't a patch: it was one rule per question. Who may read a channel, a doc, a board, a table. Who may post where. Who is in a project. Everything that asks now asks that rule. A wrong answer is now wrong everywhere at once, which is much easier to notice than wrong in one place out of eight.

Every fix has a test that fails without it, and many have tests that walk the whole codebase for the pattern that went wrong: an error response without a return, a membership removal without a cache purge, an outbound request that skips the guard.

## Update

- Run `make update` on your server. It backs up, migrates, rebuilds and verifies. Nobody is signed out by it.
- Then set `RESEND_WEBHOOK_SECRET` to your Resend webhook's signing secret, if you use Resend.
- The full list is in the [release notes](https://github.com/OneMana-Soft/OneCamp/releases). If you find something I missed, please report it through [GitHub's private security reporting](https://github.com/OneMana-Soft/OneCamp/security), not a public issue.
