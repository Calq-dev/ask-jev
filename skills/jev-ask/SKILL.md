---
name: jev-ask
description: >
  Answer questions about files without reading them into context. Use when you are about to
  open files to find something rather than to change it: which files still use an old helper,
  where a secret is hard-coded, whether a module has tests, which of these forty files touch
  the database. Also use before reading a large file when you only need one fact from it.
---

# Ask about a file instead of reading it

Reading a file of six hundred lines costs about twelve thousand tokens, and that text travels
along with every later turn. Asking costs the answer.

## Two tools

`ask_file(path, questions[])` — one file, up to ten yes/no questions in one call. Ten questions
cost the same as one, so ask everything you might want at once.

`filter_files(paths[], question)` — the same question across many files, sorted by probability.
Use it to narrow a list, then open only what survives.

## How to ask

**One thing per question.** "Does this file call the old API and lack tests" gives a muddy
answer. Split it.

**Ask what is in the file, not what you wish were true.** "Is this file well written" fires on
almost anything. "Does this file swallow an exception without logging it" does not.

**Read the number as a direction, not a verdict.** Above 0.70 act as if yes, below 0.30 as if no.
Between the two, open the file — that is the model telling you the answer is not in there
plainly.

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
