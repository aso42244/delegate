# Phase 5 — a prompt for designing the Notion request database

Paste the block below into Notion AI. It is a starting point for a conversation,
not a specification: the AI should be asking questions back.

The constraint that shapes everything else is that this must **not** be automated
from idea to merge. The agent may open a pull request; a Notion field must never
be the only thing standing between a sentence someone typed and code on `main`.

---

```
I'm designing a feature-and-bug-request workflow for a private software project,
and I want your help thinking it through before we build anything.

CONTEXT
- The project is "Delegate", a self-hosted envelope-budgeting app for my
  household. Private GitHub repo. I'm the only person who approves changes.
- I'm not an experienced programmer. An AI coding agent (Claude Code) does the
  implementation work.
- Today I ask the agent for things in chat. I want requests to live in a Notion
  database instead, so nothing gets lost and I can see what's queued.

WHAT I WANT
A Notion database holding feature requests and bug reports, and a defined path
from "request" to "shipped".

THE HARD CONSTRAINT
This must NOT be automated from idea to merge. I want to approve twice: once
that an idea is worth building, and once that the finished code is right. The
agent may open a pull request. It may never merge one on the strength of a
Notion field alone.

WHAT I'D LIKE FROM YOU
Ask me questions before proposing anything — I don't know what I want yet in
several of these areas. Help me decide:

1. Properties. What fields does each request need? I can imagine title, type
   (feature/bug), description, priority, status, who asked. What am I missing
   that I'll regret not having six months from now?

2. Status workflow. What are the states between "someone had an idea" and "it's
   live", and exactly where do my two approval gates sit?

3. Approval. Should approval be a checkbox, a status, or a person field? What
   stops it being set by accident, or by anyone other than me?

4. Scope limits. Some parts of the codebase I don't want a request-driven change
   touching without me looking hard: authentication, database migrations, and the
   CI configuration. How should the database express what a request is allowed to
   touch?

5. The handoff. What exactly gets sent to the coding agent when I approve — the
   whole page, or specific fields? How do I make sure a request is unambiguous
   enough to build from without a conversation?

6. The return trip. When the agent opens a pull request, how does that come back
   into Notion — a link, a status change, a comment? How do I review it and then
   mark the request done?

7. Failure. What happens when the agent can't do something, or gets it wrong?
   Where does that surface, and can a failed request be retried forever?

8. Bad input. Anyone I share this database with could write anything in a
   description field. What should the workflow do with a request whose text is
   trying to give the agent instructions rather than describe a problem?

Start by asking me about whichever of these you need answered first. Then
propose a schema and a workflow — and tell me where you think I'm making a
mistake.
```

---

Question 8 is the one whose answer matters most. A description field that reaches
a coding agent is untrusted text arriving at something with commit access, and
the fact that the household wrote most of the entries does not change what the
pipeline would do with one they did not.

Whatever comes out of that conversation needs recording as an ADR before any of
it is built — see the Phase 5 entries in
[open-questions.md](open-questions.md).
