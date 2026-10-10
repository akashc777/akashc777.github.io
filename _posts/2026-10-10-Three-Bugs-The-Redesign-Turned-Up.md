---
title: "Three bugs the redesign turned up"
image: "/assets/images/post/onecamp-three-bugs.jpg"
author: "Akash Hadagali"
date: 2026-10-10 11:40:00 +0530
description: "Going through every OneCamp screen for the redesign meant opening a lot of tasks and running a lot of imports. Three things happened that shouldn't have: opening a task could record an edit nobody made, an import could run twice at once, and undoing a Slack import failed halfway. All three are fixed in v2.71.0, with tests that fail if they ever come back."
tags: ["OneCamp", "Reliability", "Imports", "Tasks", "Self-Hosted", "OpenSource"]
---

If you're new here: [OneCamp](https://onemana.dev) is a self-hosted workspace (chat, tasks, docs, calls, calendar and AI agents) that you install on your own server. It is [open source](https://github.com/OneMana-Soft/OneCamp) and free for up to 25 people.

This release's [redesign](https://github.com/OneMana-Soft/OneCamp/releases/tag/v2.71.0) meant opening nearly every screen in the app, many times, in two themes and at two sizes. Most of what turned up was visual. Three things were not.

## Opening a task could record an edit

**What you might have seen.** You opened a task, read it, closed it, and its activity said you had updated the description. Its "updated" time moved too, so it jumped up any list sorted by recent changes.

**Why.** When a task opens, its description field is switched between read-only and editable, depending on whether you can edit it. The editor OneCamp uses treats that switch as a change, even though the text is the same, and the field passed it on as if you had typed. A moment later the field saved.

Most of the time the save changed nothing, because the text was identical. But a description stored in a slightly different form from the one the editor writes (plain text without paragraph tags, say) came back reformatted, so the save went through and was recorded as yours.

**The fix.** Switching a field between read-only and editable no longer counts as an edit, and a field only reports a change when the text itself changed. This applies to every editor in OneCamp: task descriptions, docs and messages.

## An import could run twice

**What you might have seen.** You started an import from Slack or another tool, it failed or you cancelled it, and you pressed Run or Retry straight away. Usually that was fine. Occasionally, two runs of the same import ran side by side, and the second one could no longer be cancelled.

**Why.** An import is marked failed or cancelled the moment that is decided, but the run behind it keeps going for a little while: it finishes the batch it's holding and tidies up. A new run started in that window ran next to the old one. When the old one finished tidying, it removed the cancel switch, which by then belonged to the new run. A retry could also put batches back in the queue while the old run was still working on them.

**The fix.** An import now runs once at a time. If you press Run or Retry while the previous run is still finishing, OneCamp says "The last run of this import is still stopping. Try again in a moment." A few seconds later it starts normally.

## Undoing a Slack import failed halfway

**What you might have seen.** You imported a Slack workspace, decided to start over, and pressed Rollback. It answered with a database error. The imported messages were gone, but the channels and people the import had made were still there, and the import still said it could be rolled back.

**Why.** Three faults, one after another. The rollback looked up what the import had made in a table that had been merged into another one months ago, so any import that had made a channel or brought in a person failed there. An import that brought files failed a step earlier, on a column the files table doesn't have. And the steps weren't one unit, so each failure left whatever had already been removed, removed.

**The fix.** The rollback reads the table that exists, removes files properly, and runs as one transaction for every importer, not only Slack: it removes all of an import or none of it. If it stops, it says "the rollback stopped and took nothing away", with the reason. And like Run and Retry, it waits for a run that is still finishing.

## How they stay fixed

Each bug now has a test that reproduces it and fails without the fix:

- **Opening a task:** the test opens a task, an editable doc and a message without touching them, and checks that nothing is saved. Then it makes a real edit and checks that the edit is saved.
- **Running an import:** four presses of Run at the same moment must start exactly one run. A press while the last run is still stopping must be refused, and must leave the import as it was.
- **Rolling back:** a Slack import that made a channel, brought a person and a file is rolled back completely. With the database made to refuse a step halfway, the rollback must change nothing at all.

The import test also runs on a deliberately overloaded machine, because the original bug only showed up under load.

## Get it

- On your own server: `make update` brings v2.71.0 (with AI) or v1.56.0 (without AI). All three fixes are in both.
- New to OneCamp? [onemana.dev/free](https://onemana.dev/free) gives you the install command, no email needed, or try the [live demo](https://onemana.dev/demo) first.
