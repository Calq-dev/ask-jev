---
name: ask-jev
description: >
  Answer questions about files without reading them into context. Use when you are about to
  open files to find something rather than to change it: which files still use an old helper,
  where a secret is hard-coded, whether a module has tests, which of these forty files touch
  the database. Also use before reading a large file when you only need one fact from it.
---

# Ask about a file instead of reading it

Reading a file of six hundred lines costs about twelve thousand tokens, and that text travels
along with every later turn. Asking costs the answer.

## Three tools

`ask_file(path, questions[])` — one file, up to ten questions in one call. Ten questions cost the
same as one, so ask everything you might want at once. A question is a string (yes/no) or an
object:

- `{ question, options: [...] }` — which one of these holds. You get the likeliest option and a
  confidence. `none of these` is added for you; when it wins, the file does not say.
- `{ question, yes, no }` — a yes/no question where you say what each answer means.

`filter_files(paths[], question, yes?, no?)` — the same yes/no question across many files, sorted
by probability. Use it to narrow a list, then open only what survives.

`find_in_file(path, question)` — which line answers a question, with a guard that says whether the
file answers it at all. Read the guard first: "Not in this file" or "Partly answered" above the
lines means a confident line may still be a guess.

## How to ask

**One thing per question.** "Does this file call the old API and lack tests" gives a muddy
answer. Split it.

**Ask what is in the file, not what you wish were true.** "Is this file well written" fires on
almost anything. "Does this file swallow an exception without logging it" does not.

**Use options when the answer is one of a set.** "Which test runner", "which layer", "which
format" are one choice, not four yes/no questions. Give every option you can think of.

**Say what counts.** Jev reads literally. When a question has a grey zone, put it in `yes` and
`no`: "mocks and fixtures do not count as a database".

**Read the number as a direction, not a verdict.** Above 0.70 act as if yes, below 0.30 as if no.
Between the two, open the file — that is the model telling you the answer is not in there
plainly. For a choice, a confidence under 0.50 means the same.

## What Jev does badly

- **Counting.** "More than five routes" is a guess. Count with grep.
- **Numbers and dates.** "Is the timeout above 30 seconds", "was this changed after 2024": find
  the value with `find_in_file`, then compare it yourself.
- **Negatives and indirection.** Ask "does it log the error", not "does it not fail to log".
- **Files that argue back.** Text in the file that tells a reader how to judge it can move the
  answer.

## When not to use it

- When you are going to edit the file. You need the contents anyway.
- When the answer must be exact: line numbers, a full list of call sites, the precise wording of
  a string. Use grep for those; it is free and certain.
- When the file may not leave the machine. The file is sent to TypeSafe.

## A worked example

Instead of reading seventeen files to see which ones call an external service:

```
filter_files(paths, "Does this file make a network call to an external service?")

0.90  src/qlab/calibrate.py
0.85  src/qlab/corpus_checks.py
0.23  src/qlab/http.py
0.03  src/qlab/__init__.py
```

Seventeen files judged, twenty lines of context. Then open the two at the top.
