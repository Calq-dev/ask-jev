# jev-ask

Ask about a file instead of reading it.

An agent usually needs one fact, not a file. Reading it costs around twelve thousand tokens, and
that text then travels along with every later turn. Here the file goes to [Jev](https://typesafe.ai),
the agent gets a probability back, and the file never enters the conversation.

## Two tools

**`ask_file(path, questions[])`** — up to ten yes/no questions about one file, in a single request.
Ten cost the same as one, so ask everything at once.

```
0.91  [lines 1-1416]  Does this file swallow an exception without logging it?
0.56  [lines 1-1416]  Does it run git commands?
0.08  [lines 1-1416]  Does it write to a database?

app/Support/CorpusRepository.php · 81075 chars · 2 parts · 22401 tokens · jev-1.13.0
```

A file too large for one request is split on line boundaries. The answer says which part it came
from, so you know where to look.

**`filter_files(paths[], question)`** — the same question across many files, highest first. Narrow
the list, then open only what survives.

```
Does this file make a network call to an external service?

0.90  src/qlab/calibrate.py
0.85  src/qlab/corpus_checks.py
0.23  src/qlab/http.py
0.03  src/qlab/__init__.py

17 files · 29787 tokens · jev-latest
```

Seventeen files judged; the agent's context grew by twenty lines.

**`find_in_file(path, question)`** — which line answers a question, and whether the file answers
it at all. Read those few lines instead of the file.

```
Where is an exception caught and ignored without logging?

0.91  line 1792  } catch (\Throwable) {
0.89  line 74    } catch (\Throwable) {
0.87  line 847   } catch (\Throwable) {

… · answer present 0.96 · 54057 tokens
```

The `answer present` figure is the part that matters. Ask the same file where it connects to
Redis, which it never does, and it reads 0.05 with a line in the office of nothing. A confident
line without that guard is a guess.

## Reading the number

Above 0.70 is yes. Below 0.30 is no. In between means the answer is not plainly in the file —
open it yourself. A probability says where to look, not what is true.

## Install

```bash
claude plugin marketplace add Calq-dev/jev-ask
claude plugin install jev-ask@jev-ask
```

Then `/plugin configure jev-ask@jev-ask` and paste your TypeSafe key. Leave it empty to use
`TYPESAFE_API_KEY` from the environment instead.

The plugin brings its own habit: a session hook adds one line of context at every start, and a
skill carries the detail when the task calls for it. No `CLAUDE.md` to edit, in any project.

## Settings

| | Default | |
|---|---|---|
| `apiKey` | — | TypeSafe key; empty falls back to `TYPESAFE_API_KEY` |
| `model` | `jev-latest` | which Jev model |
| `maxChars` | 60000 | characters per part |

## Limits

- `ask_file` and `filter_files` take yes/no questions only, one thing per question.
- Use `grep` when the answer must be exact: line numbers, every call site, a precise string.
- The file is sent to TypeSafe. Do not use it for files that may not leave your machine.
- At most eight parts per file; beyond that the answer says how much it did not read.
- One Node file, no dependencies.

MIT.
