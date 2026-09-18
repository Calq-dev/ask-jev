# jev-ask

Ask Jev about a file instead of reading it.

An agent often needs one fact, not a file. Reading it costs about twelve thousand tokens, and that
text then travels along with every later turn. Jev reads the file, the agent gets a probability
back, and the file never enters the conversation.

## Two tools

**`ask_file`** — one file, one to ten yes/no questions. All questions go in a single request, so
ten cost the same as one.

```
0.99  Is a password or key hard-coded in this file?
0.98  Is an exception swallowed silently?
0.56  Does the docstring describe something other than what the function does?
0.05  Does this file contain tests?

/tmp/payment.py · 299 chars · 570 tokens · jev-1.13.0
```

**`filter_files`** — the same question across many files, sorted by probability. Use it to narrow a
list before you open anything.

```
Does this file make a network call to an external service?

0.90  src/qlab/calibrate.py
0.85  src/qlab/corpus_checks.py
…
0.03  src/qlab/__init__.py

17 files · 29787 tokens · jev-latest
```

Seventeen files judged. The agent's context grew by twenty lines.

## Reading the answer

Above 0.70 means yes. Below 0.30 means no. In between means: read the file yourself. A probability
is not a verdict — it says where to look.

## Install

```bash
claude plugin marketplace add ~/Projects/jev-ask
claude plugin install jev-ask@jev-ask
```

Then set the key:

```
/plugin configure jev-ask@jev-ask
```

It is stored as a sensitive plugin setting, the same way `fast-jev-compaction` stores its key.

If you would rather keep the key out of any file, leave the setting empty and start Claude Code
with the key in the environment instead:

```bash
TYPESAFE_API_KEY=$(op read "op://Calq/TypeSafe API/credential") claude
```

## Settings

| | Default | |
|---|---|---|
| `apiKey` | — | TypeSafe key; leave empty to use `TYPESAFE_API_KEY` |
| `model` | `jev-latest` | which Jev model |
| `maxChars` | 60000 | a longer file is cut, and the answer says so |

## Making it a habit

The tools only help if the agent reaches for them. Put a line in your project's `CLAUDE.md`:

> When you need one fact about a file, call `ask_file` instead of reading the file.

## Limits

- Yes/no questions only. Ask one thing per question.
- A file that does not fit one request is cut. Split it yourself.
- The file goes to TypeSafe. Do not use this for files that may not leave your machine.
- No dependencies: one Node file, using `fetch`.
