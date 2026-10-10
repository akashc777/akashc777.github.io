---
title: "Everyone has a handle now"
image: "/assets/images/post/onecamp-handles.jpg"
author: "Akash Hadagali"
date: 2026-10-10 11:20:00 +0530
description: "OneCamp people have three names: a display name, a full name and an @handle. Until v2.71.0 the app picked between them differently on every screen, and anyone who joined before handles existed had none. Now there is one rule, everyone has a handle, and you can find a teammate by any of their names."
tags: ["OneCamp", "Profiles", "Mentions", "Slack Alternative", "Self-Hosted", "OpenSource"]
---

If you're new here: [OneCamp](https://onemana.dev) is a self-hosted workspace (chat, tasks, docs, calls, calendar and AI agents) that you install on your own server. It is [open source](https://github.com/OneMana-Soft/OneCamp) and free for up to 25 people.

I opened my own profile and found the handle field empty. Which raised a fair question: what is the difference between a display name, a full name and a handle, and why is mine blank?

The answer was embarrassing. Handles arrived in v2.70.0, but only for accounts made after it. Everyone who joined earlier had none. And the app had no single idea of which name to show: messages used the display name, while activity, admin lists and boards preferred the full name. The same person could be "Sam" in one place and "Samuel Rivera" in the next.

## Three names, one job each

| Name | What it's for | Example |
|---|---|---|
| **Display name** | What everyone sees on your messages, in lists and in notifications | Sam |
| **Full name** | Your whole name, on your profile and in admin lists | Samuel Rivera |
| **Handle** | How people @mention you; unique in the workspace | @sam |

Your profile now says this beside each field.

## One rule for which name shows

Everywhere a person appears, OneCamp shows their **display name**. If they never set one, it shows their **full name**. Failing that, it shows the part of their email address before the @. Pages that people outside your workspace can see, such as a guest link or a booking page, never fall back to an email address.

The same rule now names you in push notifications, emails, activity, calls and recordings, webhooks and search.

## Everyone has a handle

When your server starts, OneCamp gives a handle to every member who doesn't have one. It's made from their name, in the order people joined: Sam becomes @sam, and a second Sam becomes @sam-2. Bots and agents keep their own.

If someone still has no handle when they open their profile, it's made right then. You can change yours any time in your profile.

## Find people by any name

The @mention list, the people pickers, the admin member list and forwarding all find a person by display name, full name or handle, with or without the @. The mention list shows each person's @handle beside their name, so two people called Sam are easy to tell apart.

While I was there, I fixed people search for any term with a full stop in it, such as "priya.raman". It used to find no one.

## Guests and Slack people under their own names

Clients on a guest link and people in a linked Slack channel now appear under their own names, with a small Guest or Slack tag, in messages, threads, the channel list and search. Before, they all appeared as one "Guests" or bridge account, with their name in square brackets.

## Try it

- Open the [live demo](https://onemana.dev/demo) and type @ in any channel.
- On your own server: [onemana.dev/free](https://onemana.dev/free) gives you the install command, no email needed.
- Already running OneCamp? `make update` brings v2.71.0 (with AI) or v1.56.0 (without AI). Your members get handles at the first start.
