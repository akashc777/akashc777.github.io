---
title: "Link Your Tables, And Add Up What's Linked"
image: "/assets/images/post/onecamp-linked-tables.jpg"
author: "Akash Hadagali"
date: 2026-10-09 17:00:00 +0530
description: "OneCamp's tables now link to each other: each deal to its company, each budget line to its vendor, seen from both sides. Rollups add up what's linked. Free, self-hosted, on every plan."
canonical_url: "https://onemana.dev/blog/link-your-tables-and-add-up-whats-linked"
tags: ["OneCamp", "Tables", "Relations", "Rollups", "Airtable Alternative", "Notion Alternative", "Self-Hosted", "OpenSource"]
---

If you're new here: [OneCamp](https://onemana.dev) is a self-hosted workspace (chat, tasks, docs, calls, calendar and AI agents) that you install on your own server. It is [open source](https://github.com/OneMana-Soft/OneCamp) and free for up to 25 people.

A list of deals is half the story without the companies they're with. A budget is half the story without the vendors it pays. Until now a OneCamp table could link a row to a task or a doc, but not to a row of another table. Now it can, and it can add up what's linked.

![OneCamp's Vendors table: each vendor's budget lines, linked from the Launch budget, and the spend they add up to](/assets/images/post/onecamp-linked-tables.jpg)

## Link two tables

Add a **Relation** column and choose **Rows of a table**, then the table. Press **+** in a cell and pick a row, or type part of its name.

A link shows the linked row's name. Rename the row, and every link to it shows the new name.

Leave **Also show these links in …** ticked, and the other table gets a column of its own: a company sees its deals, a vendor its budget lines. Link or unlink from either side, and both sides change. A table can also link to itself, such as tasks to the tasks they wait on.

## Add up what's linked

A **Rollup** column adds up the rows a relation links to:

| What it shows | Rollup |
| --- | --- |
| A vendor's spend | Sum of the budget lines' Total |
| A company's open deals | Count the rows |
| When a project's work is due | Latest of the tasks' Due |
| How much is done | Count the ticked of the tasks' Done |
| Who's on it | List each once of the tasks' Owner |

A rollup can add up a formula in the other table: the demo's Spend adds up each line's Total, which is `{Cost} * {Quantity}`. Formulas can use rollups in turn: `{Spend} / {Lines}` is a vendor's average line. Like formulas, rollups are worked out each time the table opens, so they're never out of date.

## Big tables stay quick

A row can link to a thousand others, and a status can be linked from a million tasks. A cell shows the first 100 links with a count of the rest. In our tests, the server read a page of 500 rows, each linking 1,000 others, in a fifth of a second, and a status linked from a million tasks in a tenth. Past what one page can work out, a cell says how many links it has and a rollup says it can't add them all up. Neither guesses.

Your AI agents can link and unlink rows too, with a tool of their own, and the API can make a row already linked. Updating a row never touches its links, so an agent that sends a row back exactly as it read it changes none of them.

## Private stays private

Someone who can't open the linked table sees its rows as **Private row**, and rollups over it don't show its numbers. A table shared by link shows other tables' rows the same way. A link never shows a private table's rows to someone who can't open it.

## How it compares

Notion and Airtable have linked databases and rollups, hosted on their servers and billed per member. In OneCamp they're on your server, in every edition, the free one included, alongside [formulas, sorting and filters](https://onemana.dev/blog/formulas-sorting-and-filters-for-your-tables).

## Try it

- [Open the live demo](https://onecamp.onemana.dev/?start_demo=1) and open the **Vendors** table: each vendor's Launch budget lines, and the Spend they add up to.
- On your own server: [onemana.dev/free](https://onemana.dev/free) gives you the install command, no email needed.
- Already running OneCamp? Update to v2.69.0 (with AI) or v1.54.0 (without AI).
