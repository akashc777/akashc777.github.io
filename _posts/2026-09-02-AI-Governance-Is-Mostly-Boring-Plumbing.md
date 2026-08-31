---
title: "AI Governance Is Mostly Boring Plumbing"
image: "/assets/images/post/onecamp-governance.jpg"
author: "Akash Hadagali"
date: 2026-09-02 12:00:00 +0530
description: "The AI Act's transparency rules took effect on 2 August 2026. ServiceNow bought a company to watch what agents do at runtime. Only 23% of organisations report significant ROI from agents. All three are the same story: nobody can show what their AI did. Here is what governing an AI workspace actually consists of, mechanism by mechanism, including the four places where my own answer is still 'not yet'."
tags: ["OneCamp", "AI Governance", "EU AI Act", "Audit", "Agents", "Self-Hosted", "OpenSource"]
---

If you're new here: [OneCamp](https://onemana.dev/buy) is an open-source, self-hosted workspace with AI agents that runs on **your** infrastructure. I build it and sell it, which means I have spent this year finding out what governing agents actually requires, as opposed to what it sounds like it requires.

Three things happened this year that are the same thing.

The EU AI Act's [transparency obligations became applicable on 2 August 2026](https://artificialintelligenceact.eu/article/50/), with fines up to €15 million or 3% of worldwide turnover. ServiceNow [acquired Traceloop](https://newsroom.servicenow.com/press-releases/details/2026/ServiceNow-expands-AI-Control-Tower-to-discover-observe-govern-secure-and-measure-AI-deployed-across-any-system-in-the-enterprise/default.aspx) specifically to see what agents do at runtime. And the adoption surveys keep reporting that [only 23% of organisations see significant ROI from AI agents](https://prefactor.tech/learn/ai-agent-adoption-statistics) while 97% of executives say they deployed some.

Regulation, acquisition and disappointment, all pointing at one gap: **organisations cannot show what their AI did.** Not "cannot prove it was safe". Cannot show what it did at all.

## Governance is not a policy document

The word suggests committees. In practice, for a product with agents in it, governance is a short list of unglamorous mechanisms. Here is the whole list as I have come to understand it, with what each one actually means in code.

### An agent must not be able to do more than its author

Not "should not". Cannot. Every action an agent takes is checked against the live permission graph of the human who authorised it, read at the moment of the call rather than cached when the agent was set up. Remove someone from a channel and the agents acting for them lose it on the next request, not at the next token rotation.

The failing version of this is an agent with its own service account. It works beautifully and it means the agent's blast radius is whatever you granted the service account, forever, regardless of what happened to the person who built it.

### Refusals have to be recorded, not just actions

An audit log of things that happened answers "what did it do". The question after an incident is usually "what did it *try*", and only a log that records denials can answer it. In OneCamp a refused tool call writes a row with the reason, the credential, the named agent and the human behind it, using one fixed word so a reviewer can query for them.

There is a test asserting that the words "allowed" and "refused" do not change, which sounds absurd until you picture the reviewer grepping for a phrasing that got reworded in a refactor.

### The record has to be written before the thing happens

For an agent's tool calls, OneCamp writes the audit entry first and refuses the call if the write fails. No record, no action. A decision that was made and never recorded is worse than one recorded and abandoned, because only the second is discoverable.

**And here is where I have to correct myself in public.** That guarantee covers an agent's tool calls. It does not cover administrative changes, which write their entry on a detached goroutine and discard the error so the audit never adds latency. My own website claimed the strong version for both, without qualification, for months. I found it this week while mapping these mechanisms against the AI Act, by reading the code behind a claim instead of the sentence describing it. The copy now says which guarantee covers which path.

That is the argument for writing the mapping down, and I would rather tell you about it than quietly fix it.

### History that cannot be quietly edited

Each audit entry hashes its own contents plus the previous entry's hash. Any later insertion, edit or deletion breaks the chain, and a verify endpoint recomputes it and reports the first divergence. Exports carry the per-row hashes so an auditor can check them without trusting the interface they are looking at.

### A human has to be able to stand in the way

OneCamp's agents have autonomy levels, and in the governed one a write is proposed as a durable approval card and executes only when a person approves, **as that person**, with their permissions rechecked at execution time. The bot never holds standalone privilege.

There is also a backstop that ignores the autonomy setting entirely: an action nobody can undo is queued for approval regardless, including OneCamp's own tools and not only ones a remote server declares destructive. That one exists because three tools documented as "requires confirmation" were auto-running without any.

### Shared behaviour needs a blast radius and a way back

This is the one I underrated for longest. In OneCamp a *skill* is one instruction module attached to many agents: define "how we write status updates" once, attach it everywhere. Editing it changes every agent on their next run.

For a year you could edit one and see none of it: not how many agents you were about to change, not what the text said before, not who changed it last or why. That is the same shape as an unlogged deployment to production, and it took me embarrassingly long to see it that way.

Now an edit shows the blast radius first, records a revision with the author and the reason, and can be reverted. The revert writes a **new** revision rather than deleting the ones after it, because a rollback is a thing that happened and erasing what it undid leaves a history that cannot explain itself.

### Something has to notice when it gets worse

Agents have test scenarios and a pass rate. When an agent changes, the suite reruns, and if the rate drops the owner is told, with the numbers and, if a skill it uses was edited recently, which one.

This is the piece that most resembles the observability layer ServiceNow went and bought. It is also, for now, deliberately the half with a human in it. A loop that diagnoses a regression and applies its own fix needs an evaluation gate and an audit trail before anyone should trust it, and I would rather see the detection prove itself useful before I build the half that acts.

### The content has to say it is machine-made

The AI Act wants generated content marked in a machine-readable way, not merely attributed to a bot. OneCamp had the attribution: agent messages come from their own principal, badged, with a profile saying which kind of bot it is. It had nothing on the content, so a recap quoted into another channel carried no signal at all.

Every machine-written body now carries a marker in the content itself, applied at the outermost point so it covers the whole message and not only the model's words. The interesting part was the sanitiser: allowing an attribute through is exactly the change that fixes one thing and opens another, so the test asserts both that the marker survives and that the same input carrying an onclick handler, an inline style and a script tag still loses all three.

## The part most write-ups skip

A governance page that lists only the parts that pass is marketing. So `docs/AIActControls.md` in the repository names four places where the honest answer is "not yet":

- **The marking does not survive leaving the product.** It is HTML. Paste a recap into an email and it arrives unmarked.
- **There is no configurable retention window.** Nothing deletes audit entries, which satisfies a six-month minimum by never expiring and is the wrong default for anyone who must delete on a schedule.
- **Administrative audit is best-effort.** As above.
- **Nothing is certified by anybody.** No third party has audited any of this. Every claim is a mechanism you can read in the source, which is the strongest thing an uncertified product can honestly say.

## Why self-hosting makes this easier to answer, not harder

Every mechanism above runs on the customer's own machine. They hold the logs, the data and the model keys. Nothing depends on trusting my control environment, because there is no vendor in the data path: a OneCamp install never contacts me, with no licence check, no heartbeat and no telemetry.

That is unusual enough to be worth saying plainly. The normal shape of enterprise AI governance is a vendor asserting things about a system you cannot inspect, backed by a certification you also cannot inspect. The self-hosted shape is worse for me commercially, since I cannot see fleets or usage, and better for the buyer's actual question, which is not "do you promise" but "can I check".

The EU seems to agree with the direction. The [Open Source Strategy published in June 2026](https://www.osborneclarke.com/insights/new-eu-open-source-strategy-europes-path-digital-sovereignty-through-open-technologies) puts open source at the centre of technological sovereignty, and the upcoming Cloud and AI Development Act introduces a free-software-first principle for public procurement of cloud and AI software.

## What I would take from this

Governance sounds like ethics and is mostly plumbing. Permissions read at call time, denials written down, a hash chain, an approval step, a blast radius, a revision history, a test that reruns, a marker on the output. Every one is a small mechanism with a right answer, and none of them requires a committee.

What it does require is being willing to write down where your own answer is still "not yet", and to correct the sentence on your website when it turns out to be broader than your code. I did both this week. The second one was more useful.

v2.7.0 and v1.5.0 are out, and everything described here is in them. The other post from this release: [every feature worked and nobody could reach it](/post/Every-Feature-Worked-And-Nobody-Could-Reach-It.html).

*[OneCamp](https://onemana.dev/buy) is an open-source, self-hosted workspace: one payment, unlimited users, your server. Find it at [onemana.dev](https://onemana.dev/buy).*
