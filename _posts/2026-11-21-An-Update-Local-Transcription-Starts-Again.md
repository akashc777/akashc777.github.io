---
title: "An update: local transcription starts again"
image: "/assets/images/post/onecamp-local-transcription-again.jpg"
author: "Akash Hadagali"
date: 2026-11-21 05:16:19 +0530
description: "An update for OneCamp, with AI or without: local transcription starts again. It runs on a current speech-to-text image, and the transcription service builds again. Nothing else changes."
canonical_url: "https://onemana.dev/blog/an-update-local-transcription-starts-again"
tags: ["OneCamp", "Release", "Calls", "Self-Hosted", "OpenSource"]
---

If you're new here: [OneCamp](https://onemana.dev) is a self-hosted workspace (chat, tasks, docs, calls, calendar and AI agents) that you install on your own server. It is [open source](https://github.com/OneMana-Soft/OneCamp) and free for up to 25 people.

**If you transcribe calls on your own server, update today, with AI or without.** Local transcription had stopped starting on any server that didn't already have it: the speech-to-text server it runs could no longer be downloaded, and the transcription service it builds never finished building. Today's update fixes both, and it's the only change. Local transcription now runs on a current speech-to-text image, which no longer reports installs to its maker, and the transcription service builds again in a few minutes. There's nothing to migrate and no setting to change. To update a server you run, follow the steps under Updating on the [installation page](https://onemana.dev/docs/installation#updating), then start local transcription again with `make stt_up`, so it picks up the new image. Everything else that's new is in the [last post](https://onemana.dev/blog/triage-slas-and-a-calendar-for-every-project).
