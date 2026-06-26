---
title: "OneCamp Tables: Notion-Style Databases Your AI and API Can Actually Use"
image: "/assets/images/post/onecamp-tables-modern.jpg"
author: "Akash Hadagali"
date: 2026-06-25 11:00:00 +0530
description: "Why a table in OneCamp is its own first-class entity rather than a blob inside a doc: a jsonb row model that survives schema changes, fractional ordering, grid/board/calendar views, a relation field that links rows to real tasks and projects, AI that builds a whole table from one sentence, and a permission model that mirrors the rest of the workspace, all self-hosted."
tags: ["OneCamp", "Go", "NextJS", "Postgres", "AI", "Self-Hosted", "Architecture", "OpenSource"]
---

Every workspace ends up needing a small database.

A content calendar. A bug tracker that is lighter than Jira. A list of vendors with status and owner. A reading list. None of these deserve a whole app, and none of them fit comfortably in a doc or a chat thread. This is the Notion-database / Airtable shaped hole, and OneCamp just grew one: **Tables**.

This post is about the decisions underneath them, because a "table" sounds trivial and is not. The hard parts are where the data lives, how it survives you renaming a column, how it stays editable in real time, and how to make it useful to both a human clicking cells and an AI agent calling tools.

---

## A Table Is Not A Doc 📦

The tempting shortcut is to store a table inside a document's body, as a big node in the editor. It looks done in an afternoon. It is also a trap:

- The data is trapped in one doc. You can't query it, relate it, or let an agent read it without parsing rich text.
- It bloats the doc's CRDT. Every keystroke anywhere in the doc now drags the whole table's bytes along.
- It has no permissions of its own, no views, no API surface.

So in OneCamp a table is its **own first-class entity** with its own rows, fields, views, and permissions. A doc can *embed a live view* of one through a tiny Tiptap node that holds only a `{table_id, view_id}` reference, but the data itself lives in its own home. The node is a window, not a warehouse.

---

## The Row Model That Survives Schema Changes 🧱

Here is the schema decision that everything else hangs on. A row does **not** have a column per field. Instead, each row stores a single `jsonb` object keyed by **field id**:

```sql
CREATE TABLE data_table_rows (
    id         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    table_id   uuid NOT NULL REFERENCES data_tables(id) ON DELETE CASCADE,
    values     jsonb NOT NULL DEFAULT '{}'::jsonb,  -- { "<field_id>": <cell> }
    position   double precision NOT NULL DEFAULT 0,
    ...
);
```

Why keyed by field id and not field name? Because people rename columns. If `values` were keyed by name, renaming "Status" to "State" would orphan every cell. Keyed by the field's stable UUID, a rename touches exactly one row in `data_table_fields` and zero rows of actual data. Adding or deleting a field never rewrites existing rows either; a new field is simply absent from old rows until someone fills it in.

The field definition carries its type and a `jsonb` config bag, with the type as an open `varchar + CHECK` so adding a new kind is a one-line migration rather than a schema rewrite:

```sql
type varchar NOT NULL DEFAULT 'text'
  CHECK (type IN ('text','number','select','multi_select',
                  'date','checkbox','person','url','email')),
config jsonb NOT NULL DEFAULT '{}'::jsonb  -- select options, number format, ...
```

This is the classic Entity-Attribute-Value tradeoff made deliberately: you give up per-column SQL constraints, and in exchange you get a schema users can reshape live without a migration. For a user-defined table, that flexibility is the entire point. Validation moves up into the business layer, which checks each cell against its field's type and config before the write lands.

---

## Ordering Without Renumbering: Fractional Positions 🔢

Drag a row from the bottom to the second slot. The naive model renumbers every row in between, which is N writes and a sync storm for everyone watching. OneCamp uses **fractional positioning**: `position` is a `double precision`, and to drop a row between two neighbours you set it to the average of their positions.

Moving one row is then exactly one update, no matter how big the table. The same trick orders fields and views. (There is a known long-tail where repeated insertions between the same two rows exhaust float precision; the pragmatic answer is a cheap occasional rebalance, which a table this size never realistically triggers.)

---

## One Table, Three Views 👓

The data is the truth; a **view** is a saved lens over it. Each view is a row with a type and a `jsonb` config holding filters, sorts, the group-by field, the calendar's date field, and which fields are visible:

- **Grid** is the spreadsheet: inline-editable cells, resizable columns, add-row-at-bottom.
- **Board** is a kanban: pick a `select` field to group by and the rows become cards in columns; dragging a card writes the new group value into that one cell.
- **Calendar** maps a `date` field onto a month, rendering each row on its day.

Switching views never touches the data. A board and a calendar over the same table are just two configs reading the same rows, which is why the same content calendar can be a grid for editing, a board by status for standup, and a calendar by publish-date for planning.

---

## The Field That Makes It A Workspace, Not A Spreadsheet 🔗

A spreadsheet is an island. The feature that makes Tables feel native to OneCamp is the **relation** field: a cell that links a row to a real OneCamp entity, a task or a project, not just free text. A "Launches" table can have an Owner relation pointing at the actual project, so the table becomes a structured index over work that already exists, with live links instead of copy-pasted names.

Because the relation stores the entity's id, it stays correct when the target is renamed, and it gives an agent a real handle to follow rather than a string to guess at.

---

## Build A Table From One Sentence 🪄

A blank table has the same cold-start problem as a blank canvas. So there is an AI entry point: type "a content calendar with title, status, channel, publish date and owner", and OneCamp generates the whole thing, typed columns and a few seed rows.

The server side is strict in the same way the board diagram generator is. The model is constrained to emit a small JSON description (field names with types from the allowed set, plus example rows), and the backend then:

- validates every field type against the allowed kinds and drops anything malformed,
- builds the table, fields, and a default grid view through the *same* create functions the UI uses,
- maps the seed rows' values onto the new field ids so they land in the right cells.

It rides the exact model-agnostic AI service as everything else, with the same rate limiter, circuit breaker, per-user model choice, and the workspace token budget. The model proposes; the validated business layer disposes.

---

## Live, Without A Second Sync Service 📡

A table is multiplayer too, but it does not need the CRDT machinery the docs and boards use, because cells are independent and last-write-wins is fine for structured data. Instead, edits broadcast over the **MQTT** bus the rest of OneCamp already uses for presence and notifications. The table's bundle response includes the live topic to subscribe to, and a cell edit anywhere shows up for everyone watching that table. One messaging fabric, reused again, rather than a bespoke socket per feature.

---

## Permissions, Inherited Not Reinvented 🔐

Tables follow the same simple, real model as the rest of the workspace:

- **private** tables are visible only to their owner (and system admins).
- **workspace** tables are viewable and row-editable by every member, while structural changes (adding fields, deleting the table, editing views) stay with the owner and admins.

The list query returns exactly what the caller may see (`visibility = 'workspace' OR created_by = me`, admins see all), and that single rule is enforced in the business layer so every surface, the UI, the AI tools, and the public API, gets the same answer. A new surface inherits the rules; it does not get to invent its own.

---

## Built So An Agent Can Use It Too 🤖

This is the part that makes Tables more than a UI feature. Because a table is a real entity with a clean data model, the AI layer ships **tools** over it: list tables, read rows, create a row, update a row, all permission-checked as the acting user. An agent can keep a triage table current, or the public API can append a row from an external system (more on that surface in the next post). The same table is a spreadsheet to a human and a typed datastore to a program.

That duality was the goal from the first schema line. A table you can click is useful. A table your automations and your API can also read and write is infrastructure.

---

## How To Use It 🚀

**Create one.** Open **Templates / Tables** from the left sidebar (or the command palette: press the shortcut and type "Templates"/"Tables"), then **New table**. You get an empty grid with a single "Name" column.

**Add columns.** Click the **+** at the end of the header row, name the column, and pick a type: text, number, select, multi-select, date, checkbox, person, URL, email, or **relation**. For a select, add your options; for a relation, choose whether it links to tasks or projects.

**Add and arrange rows.** Click the bottom "+ New row", type into cells inline. Drag a row by its handle to reorder, drag a column header to reorder columns. Nothing renumbers; it just moves.

**Switch how you see it.** Use the view switcher (top-left of the table) to add a **Board** view (pick a select field to group into columns and drag cards between them) or a **Calendar** view (pick a date field). All views read the same rows, so editing in one shows up everywhere.

**Let AI build it for you.** On a new or empty table, click **Generate with AI** and describe it in one line, e.g. *"a content calendar with title, status (Idea/Drafting/Published), channel, publish date and owner"*. OneCamp creates the typed columns and a few starter rows. Tweak from there.

**Embed it in a doc.** In any document, type `/table` and pick a table and a view; the doc renders a live window into it. Editing the table updates the embed for everyone.

**Share or keep private.** In the table's settings, set visibility to **Workspace** (everyone can view and edit rows) or **Private** (just you). Structural changes stay with the owner either way.

**Drive it from code or an agent.** Every table is reachable from the AI tools and the public API, so an agent or an external script can append and update rows. That part is the next post.

---

*OneCamp is an open-source, self-hosted, AI-era workspace: chat, docs, tasks, projects, calls, boards, an AI coworker, and now structured Tables, all on your own infrastructure.*
