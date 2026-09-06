---
title: "Six Things Were Quietly Off And None Of Them Threw An Error"
image: "/assets/images/post/onecamp-release-editions.jpg"
author: "Akash Hadagali"
date: 2026-09-06 12:00:00 +0530
description: "Push notifications were off on every install that followed my own guide. Video calls had no certificate because the documentation told you not to create the record. Telemetry was going nowhere because I read a URL as a hostname. None of these threw an error, which is the only reason they lasted. Here is the fortnight, the two releases it produced, and the three things I promised last time that are now done."
tags: ["OneCamp", "Release", "Self-Hosted", "AI Agents", "Observability", "Audit", "OpenSource"]
---

If you're new here: [OneCamp](https://onemana.dev/buy) is an open-source, self-hosted workspace (chat, docs, tasks, projects, calls, boards, tables, an API) that runs on **your** infrastructure. I build it, sell it, and operate the demo.

This fortnight shipped as **v2.8.0** and **v1.6.0**, the AI edition and the edition without AI. Most of it was not new features. Most of it was finding things that were already broken and not saying so.

That turned out to be the theme, so that is how this post is organised. A feature that fails loudly gets fixed on the same day. A feature that fails silently survives for months, and every one of the six below survived because nothing anywhere printed a word about it.

## 1. Push notifications were off. On every install.

Three weeks ago I found a private key inside every download and [wrote about it](/post/I-Built-The-Password-Reset-And-Found-A-Private-Key-In-Every-Download.html). Removing that file from the build was correct.

It also left a hole I did not notice. The shipped environment file still named a credential file that the archive no longer contained, so on a fresh install Firebase never initialised and mobile push was simply never sent. Not broken, not erroring. Off.

The only place this was reported was one line in the server log at boot, which nobody reads on a working install, and the settings screen went on offering notification preferences the whole time.

Push is now configured from the admin panel. You paste the service account JSON, it is encrypted at rest, and it takes effect **without a restart**. The screen tells you which of three states you are in, because "no credential set" and "credential set but Firebase rejected it" are different problems and collapsing them is how somebody spends an afternoon on the wrong one. It will not show you the key back. A credential you can read is a credential that leaves in a screenshot.

**Where:** Admin, then Push notifications.

## 2. Video calls had no certificate, because my documentation told you not to create the record

This is my favourite one, in the sense that it is the most instructive and the most embarrassing.

Weeks ago I trimmed the DNS guide. It had listed fourteen subdomains including the database, and publishing a database hostname is how those ended up reachable from the internet the first time. The trim removed the datastores, the admin consoles, and also `onecamp-livekit` and `onecamp-collab`, on the stated grounds that those services "are not in the shipped stack at all".

That was **true when I wrote it**.

Then I added LiveKit and the collaboration service to the shipped stack, so that the record button in a call would have something behind it. Both got Traefik routers. Nothing went back to the DNS page.

So the product shipped video calls and live document editing, and the documentation told customers not to create the DNS records those features need. No record means no Let's Encrypt certificate, which means the feature fails with nothing anywhere naming DNS as the cause. The page even said "Do not create records for anything else", so anyone who noticed the installer printing seven records was told by the docs to ignore it.

Both halves are fixed, and there is now a test that fails the build when the stack file and the installer's DNS instructions disagree about any hostname. Neither file was wrong on its own. Only the relationship between them was, so the relationship is what gets checked.

While I was there: `onecamp` was listed under "records pointing at this server", and nothing on the server serves it. That is the address your team actually opens, and the web app is a separate deployment. Pointing it at the backend is the one DNS mistake that makes a correct install look completely broken.

**Where:** the [DNS page](https://onemana.dev/docs) is corrected. If your calls have never worked, this is almost certainly why. `onecamp-turn` must be **DNS only and never proxied**, because it carries UDP media that a proxy cannot pass. On Cloudflare that means grey cloud, not orange.

## 3. Telemetry was going nowhere, and a TLS collector was being downgraded to plaintext

OneCamp can export traces and logs to your own observability stack. `OTEL_EXPORTER_OTLP_ENDPOINT` is defined by the OpenTelemetry specification as a **URL**, scheme included.

My code read that variable by hand and passed it to an option documented as accepting host and port only, then forced insecure mode on top. Three faults stacked: passing the option suppressed the variable the SDK would have parsed correctly by itself, a whole URL got used as a hostname, and an `https://` collector was silently downgraded to plaintext.

Nothing reported any of it. A batch exporter sends its failures to the OpenTelemetry error handler, and nothing installs one, so the symptom is that telemetry simply never arrives.

Both spellings work now. And a failure to build an exporter no longer calls `log.Fatalf`, which meant a typo in a collector address took down a chat and video product that was perfectly capable of running without sending anyone a trace.

**Where:** your `.env`. If you set it with a scheme and saw nothing arrive, try again.

## 4. The first download was designed to time out

Your copy of OneCamp is compiled with your own domains built into it, which is why nobody else's build will do. That compile takes about 143 seconds. Cloudflare stops waiting for an origin at 100.

So the very first thing a paying customer did produced `Failed to download ZIP file. Server returned an error.` The build actually finished and was cached, so trying again two minutes later worked, but nothing told anyone that.

The build now starts the moment you submit your domains, during the minute the installer spends installing Docker and its dependencies. And when a download does fail, the message says what to do instead of what went wrong.

**Where:** nothing to click. Buy a licence and the install just starts faster.

## 5. Six other ways the installer lied quietly

The installer parses its licence response with `jq`, on line 86. It installed `jq` on line 296. Ubuntu and Debian cloud images do not ship it.

Its absence stopped nothing. Every `jq` call just returned an empty string, so the version printed blank, the domains you had already set looked unset and were asked for again, and the list of available editions came back empty so the **edition choice was skipped entirely**. The install completed successfully on whichever edition your licence defaulted to, and you were never asked.

Also fixed in the same pass: every non-200 response reported "Invalid Onecamp Key", so an outage or a DNS failure told a paying customer their key was wrong, which is the one diagnosis that sends somebody to support instead of to a retry. Answering "no" to the download still installed four packages first. A validation failure used `exit` inside a subshell, so a typo in an unattended install printed a refusal and then installed the other edition anyway. And a first install ended in silence with the files unpacked and nothing telling you that one more command sets it all up.

**Where:** the install command from your licence email. It is the same command.

## 6. And on my own storefront, a paid subscription that waited for the customer while telling them to wait for me

Not the product, but the same disease, and I am not going to leave it out because it is the least flattering.

Subscribing to managed hosting creates your workspace record and then waits for you to choose an address. Nothing is provisioned until you do. The welcome email said, in the same breath: **"There's nothing you need to do right now."**

Five lines apart in the same file: create the thing that waits for the customer, then email the customer telling them not to act. The first reminder was twenty four hours later.

Both the email and the confirmation page now ask for the address and link to the page where you choose it. And they mention what nobody had ever been told: the address is **free on onemana.dev**, and you can move the workspace to a domain you own afterwards, at no extra cost, from the same page.

## The three things I said were still open

[Last post](/post/A-Changelog-Is-Useless-Without-Directions.html) ended with three admissions. All three are now done, which is a nicer sentence to write than it usually is.

**Retention was an environment variable.** It is now an admin setting with a six month floor that a shorter value cannot cross by accident, and every evidence pack records the policy that was in effect when it was built.

**A run did not record which version of its skills produced it.** Every run now stores the model it used, a fingerprint of the fully composed instructions, and which skills were in them with a fingerprint of each. Editing an instruction later cannot silently change what a past run appears to have been asked. That was the honest "no" to the question enterprise buyers actually ask, and it is a yes now.

**The agent improvement loop applied changes rather than proposing them.** It now proposes. Each agent reads its own last thirty days, and a run that went wrong becomes a proposed test that would have caught it, with the failed run attached as the evidence. **Nothing is applied automatically.** A proposal becomes a real scenario when a person accepts it, through the same endpoint a hand written one uses, so an accepted proposal is indistinguishable from a typed one afterwards. A product whose case is that agent behaviour is governed cannot be the product that rewrites its own instructions while nobody is looking.

It also proposes attention rather than prose. A count is evidence that something needs saying. It is not evidence of what to say, and inventing the wording from a count is exactly the confident guess this whole codebase exists to avoid.

**Where:** Admin for retention. Your agent's page for what its history suggests.

## New: an agent can ask you a question and offer you the answers

Agents could already stop and ask. When one genuinely cannot proceed it pauses, the question reaches you, and your reply picks the work back up where it left off.

The question was one line of free text, which meant an agent asking "which repository?" wrote the candidates into its own prose and you typed something back that the model then had to re-interpret. Re-interpreting your answer is a guess, and this is a codebase that already refuses to let a model narrate what it did.

So an agent can now offer the answers. It lists two to six choices, you pick one, and the run resumes knowing which. The shape follows the Model Context Protocol's elicitation specification rather than one I invented, including keeping **decline** and **cancel** as separate things: refusing to answer is not the same as abandoning the work, and collapsing them is what makes an agent ask you the same question twice after you have already said no.

One rule from that specification is enforced rather than documented. **An agent may never ask you for a password, key, token or other credential.** That is not theoretical here: an agent's instructions are editable, its skills come from a shared library, and its knowledge is pulled from workspace content other people write. Any of those is a place to plant "ask the user to paste their API key", and the question would arrive wearing the trusted name of a colleague's agent. The request is refused before it reaches you. Asking *which* key to use is a choice between things the agent can already reach, and stays allowed.

**Where:** wherever the agent is working. A blocked agent shows its question and its choices on your Home dashboard, and you answer in the thread or the task it asked in.

## New: your agents' governance record can leave the building

Every finished agent run is now emitted as an OpenTelemetry span alongside the audit entry: which agent, what triggered it, how long it took, which tools succeeded and failed, and what policy refused.

The reason is simple. If your team runs agents across several systems, you watch one place, and a governance signal that lives in somebody else's product is a governance signal nobody reads. Set `OTEL_EXPORTER_OTLP_ENDPOINT` and this lands next to your other traces. Leave it unset and nothing is exported, which is the default.

Two deliberate choices. Attributes that have an OpenTelemetry standard name use it, so this shows up in a dashboard you already have. And **a run blocked by governance reports Ok, not Error**, because a refusal is the product working, and the fastest way to make a team stop trusting a governance signal is for it to wake somebody at 3am when nothing is wrong.

The span carries the run id, not the transcript. What the agent was asked and what it said stays on your infrastructure.

**Where:** your `.env`, and then your own tooling.

## Also in these releases

The audit log now records **whether a person or an agent acted**, and internal agent runs are written to it at all, which they previously were not. So a workspace can answer "show me everything agents did, and prove the list has not been edited", which is the question enterprise buyers have started asking by name.

There is an **evidence pack** that assembles the log in chain order with per row hashes, the chain recomputation, the runs with their instruction fingerprints, and a manifest fingerprinting every section, so the pack verifies without trusting the tool that made it. It also states plainly what it does not prove.

AI answers now **disclose what they were built without**. If a connected server was unreachable or a source could not be read, the answer says so instead of only logging it and reading as though it were complete.

AI conversations have an id, so there is something to come back to.

And the shared services stack is deleted. It existed from when the cloud ran beside the demo on one box, nothing has run it for months, and it was keeping a live Redis password and a live LiveKit secret in git for services that no longer exist. **If you ever deployed from it, rotate both. Deleting is not rotating.**

## The thing worth copying

Last time the lesson was to test that a feature is *reachable*, not only that it works.

This time it is one step further out. Four of the six failures above were **not inside any single file**. The stack file was right. The DNS page was right when it was written. The installer was right about what it needed. Each one, read on its own in review, looks fine.

What was wrong was the relationship between two files that nothing was watching.

So the guards I added this fortnight do not check files. They check agreements between files: every hostname with a router must appear in the DNS instructions, with the one deliberate exception named out loud. Every claim in the compliance document must point at a file that exists. Every SQL statement's placeholders must match its arguments.

**If two files have to agree and nothing enforces it, they will eventually disagree, and the failure will be silent.** That is not a rule about DNS or about Go. It is the shape of most of the bugs I have found this year.

## Still open

Being honest about the list, because a changelog that only contains wins is marketing.

**OneCamp has never run two nodes.** The architecture is closer to it than most self hosted chat products, because realtime lives in an external broker and sessions live in Redis rather than in the web process. But untested is untested, and I publish no concurrency number because nobody has produced one. There is now a [document](https://github.com/OneMana-Soft/OneCamp) that says exactly that, and what measuring it would take.

**Elicitation is one question at a time.** The specification also allows multi field forms. I left them out because a person answering in a message thread is not filling in a form, and a shape nobody can answer is worse than no shape. If you want them, tell me.

**You answer a blocked agent in the conversation, not from the dashboard.** The dashboard shows you the question and the choices; the answer belongs where the question was asked, because that is where the record of it should live. I may be wrong about that one.

And the agent improvement loop is real but hungry. It reads your last thirty days, and on a workspace with a quiet fortnight it will correctly tell you it has nothing to suggest. That is the right behaviour and it is also not a demo.

If any of the directions above turn out to be wrong, tell me. That is the whole point of the post.

*[OneCamp](https://onemana.dev/buy) is an open-source, self-hosted workspace: one payment, unlimited users, your server. Find it at [onemana.dev](https://onemana.dev/buy).*
