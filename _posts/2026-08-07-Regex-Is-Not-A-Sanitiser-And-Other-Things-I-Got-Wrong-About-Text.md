---
title: "Regex Is Not a Sanitiser, and Other Things I Got Wrong About Text"
image: "/assets/images/post/onecamp-v2-hero.png"
author: "Akash Hadagali"
date: 2026-08-07 09:00:00 +0530
description: "Four fixes about handling text and media, none of which involve AI. Truncating a string by bytes was splitting characters and producing invalid UTF-8, and the guard around it was appending an ellipsis to text it had never shortened. A markdown renderer was stripping script tags with regexes and handing the result to dangerouslySetInnerHTML — five payloads walked straight through it, on the origin where the admin session lives. An uploaded SVG could run script when navigated to directly. And base64 images were still reaching the search index by a path the guard never covered."
tags: ["OneCamp", "Go", "NextJS", "Security", "XSS", "UTF-8", "OpenSearch", "Self-Hosted", "OpenSource"]
---
One of four posts about a week with no new features in it. The others were about [opening OneCamp to outside AI agents](/post/We-Opened-OneCamp-To-Outside-AI-Agents-And-Every-Gate-Found-A-Bug.html), [token limits that follow the model](/post/One-Context-Window-For-Every-Model-Was-Quietly-Wrong.html), and [four mechanisms that were written and never called](/post/The-Code-Was-Written-Nothing-Called-It.html).

This one has no AI in it at all. It's about text, media, and the browser — and it's the one with the most general lessons in it, because none of these mistakes are specific to what I'm building.

If you're new here: [OneCamp](https://onemana.dev/buy) is an open-source, self-hosted workspace with AI teammates, running on your own infrastructure through your own choice of model.

---

## Truncating Text Was Splitting Characters ✂️

Slicing a Go string counts **bytes**. So cutting at a fixed offset severs any multi-byte character straddling the boundary and produces invalid UTF-8, which then travels into API responses, the graph database and the search index — where it's either rejected outright or rendered as a replacement glyph.

Every accented, emoji or non-Latin string hits this. Which is to say: all user text, for most of the world.

The guard around it was wrong in a more embarrassing way:

```go
if len(text) > 800 { text = text[:800] + "…" }
```

`len` also measures bytes. So 800 characters of Japanese is roughly 2400 bytes, the branch fires, and an ellipsis gets appended to text that **was never actually shortened** — actively telling the reader something was cut when nothing was.

One helper now counts characters for both the limit and the guard, and appends the suffix only when something really went. The codebase already had two competing idioms for this — ten sites doing the verbose rune-slice dance, twenty-six slicing bytes — so this replaced the pattern rather than adding a third variant. It also can't panic on an out-of-range index, which the rune-slice idiom does happily if you forget the guard.

The general version of this lesson: **a length check and a cut have to agree on their unit.** If one counts bytes and the other counts characters, you don't get a bug you can see — you get a message that says it was truncated when it wasn't, and occasionally a broken glyph.

---

## Regex Is Not a Sanitiser 🧨

The markdown renderer on the marketing site stripped `<script>…</script>` and ` on*="…"` attributes with regular expressions, then handed the result to `dangerouslySetInnerHTML`. A comment described it as defence in depth.

It defended against almost nothing. Every one of these walked through, each falling outside the exact shapes the patterns were looking for:

```
<img src=x onerror=alert(1)>        unquoted attribute value
<script src="//evil/x.js">          no closing tag, so nothing to match
<svg onload=alert(1)>               unquoted, and <svg> was never stripped
[click](javascript:alert(1))        a URL scheme, not a tag or an attribute
<iframe srcdoc="&lt;script&gt;…">   entity-encoded, invisible to the regex
```

Both rendering paths execute on the frontend origin, which is where the admin token lives in session storage. Either one could have stolen an admin session.

The reason regex fails here isn't that these particular patterns were sloppy — it's that HTML is not a regular language, and a blocklist has to anticipate every shape an attacker might use while a parser only has to understand the document. Sanitising has to happen against a parsed tree with an **allowlist** of elements and attributes, not a list of things you thought to forbid.

If you have a `dangerouslySetInnerHTML` anywhere near user or CMS content, this is the thing to go and look at today.

---

## An Uploaded SVG Could Run Script 🖼️

SVG was on the upload allowlist, and blog media was served inline with that declared content type.

An SVG is a **document**, not just a picture. It can carry `<script>` and event handlers, and they execute when the URL is opened directly. Loading the same file through an `<img>` tag cannot run script; *navigating* to it can — and "open image in new tab" is one click away.

The `nosniff` header doesn't help here, and it's worth being precise about why: nosniff stops a browser from second-guessing a declared type, but the declared type genuinely *is* SVG. There is nothing to sniff. The browser is doing exactly what it was told.

So the fix is a restrictive Content-Security-Policy on that response: block script, fetch and every subresource load outright, and sandbox the document so it doesn't inherit the origin it would otherwise run in. Inline `style` stays permitted, because SVGs legitimately use internal `<style>` and blocking it would break real images.

---

## Media Still Reaching the Search Index 🔍

Some background: a beta search node was OOM-killed a while ago by a single update whose document body contained a base64 image. The editor bug that allowed it was fixed at the time. This closed the paths that could still put media into an index.

Two of them mattered, and both had live traffic:

**The bulk path bypassed the guard entirely.** It hand-builds newline-delimited JSON and never touched the sanitising seam, while carrying most of the write volume across posts, comments, chats, tasks, projects, teams and attachments. Sanitising it needed a per-line pass that reproduces the line layout exactly, because the format pairs each action line with the next one and depends on the trailing newline.

**The AI embeddings index wrote raw HTML.** Worse than the storage cost: embedding vectors were being computed **from base64**, which both degrades semantic search and spends the entire text budget on payload rather than on words. Media is now stripped before embedding, not after.

The pattern worth extracting: a guarantee enforced at one seam isn't a guarantee if a second path writes to the same place. It's a convention. Finding the second path meant looking for every writer to the destination, not every caller of the guard.

---

## And While I Was In There

The server now **refuses to boot on schema drift** rather than starting against a database it doesn't match. Dead links got repointed at pages that exist. A Node version floor is declared where the tooling actually needs one. And the public mirror finally carries the MIT licence its README badge had been promising for a while.

---

## What This Means If You Use OneCamp 🚀

**The text and search fixes need nothing from you.** They're in. If you write in a non-Latin script, you were the most likely person to have seen the truncation bug.

**Self-hosters: the boot check on schema drift is deliberate.** If an upgrade stops instead of starting, run your migrations rather than working around it — running against a database you don't match is how data gets written in the wrong shape.

**If you run the marketing/blog stack, take the rendering and media fixes.** Both the stored-XSS and the inline-SVG issue execute on the origin where an admin session lives, so they're worth applying before anything else in this post.

---

*[OneCamp](https://onemana.dev/buy) is an open-source, self-hosted, AI-era workspace: chat, docs, tasks, projects, calls, boards, tables, a programmable API, and AI teammates that can see, calculate, run code, query your databases, read your documents, and open pull requests — on infrastructure you own, through the model you choose. Find it at [onemana.dev](https://onemana.dev/buy).*
