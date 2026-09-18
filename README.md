# ask-jev

Ask about a file instead of reading it.

An agent usually needs one fact, not a file. Reading it costs around twelve thousand tokens, and
that text then travels along with every later turn. Here the file goes to [Jev](https://typesafe.ai),
the agent gets a probability back, and the file never enters the conversation.

## Three tools

**`ask_file(path, questions[])`** — up to ten questions about one file, in a single request.
Ten cost the same as one, so ask everything at once.

```
0.91  [lines 1-1416]  Does this file swallow an exception without logging it?
0.56  [lines 1-1416]  Does it run git commands?
0.08  [lines 1-1416]  Does it write to a database?

app/Support/CorpusRepository.php · 81075 chars · 2 parts · 22401 tokens · jev-1.13.0
```

A file too large for one request is split on line boundaries. The answer says which part it came
from, so you know where to look.

A question can also be an object. Give `options` to ask which one holds; the answer is the
likeliest option and a confidence. `none of these` is added for you, because the file may not say.
Give `yes` and `no` to say what each answer means, with the boundary cases in them.

```
ask_file("tests/Frontend/AppSidebar.test.mjs", [
  { question: "Which test runner do these tests run under?",
    options: ["vitest", "jest", "mocha", "node:test"] },
  "Does this file render a Svelte component?",
  { question: "Does this file talk to a real database?",
    yes: "It opens a connection to a database server or file, or runs SQL.",
    no: "No database is touched; mocks, fixtures and in-memory values do not count." },
])

1.00  node:test  (confidence 1.00)  Which test runner do these tests run under?
0.96  Does this file render a Svelte component?
0.04  Does this file talk to a real database?
```

That file imports Vite, and the runner is still `node:test`. When no option fits, the answer
says so: `1.00  none of these  (confidence 1.00)  Which database driver does this file use?`

**`filter_files(paths[], question, yes?, no?)`** — the same question across many files, highest
first. Narrow the list, then open only what survives.

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
Redis, which it never does, and the answer says so first:

```
Where does it connect to Redis?

Not in this file (0.07). The lines below are only the closest.
```

Between 0.30 and 0.70 it says the file answers the question in part. A confident line without
that guard is a guess.

## Reading the number

Above 0.70 is yes. Below 0.30 is no. In between means the answer is not plainly in the file —
open it yourself. A probability says where to look, not what is true.

For a question with options, read the confidence. Under 0.50 the model is not sure which option
holds; open the file.

## What Jev does badly

From TypeSafe's own list for `jev-1.13` ([jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13)):

- **It reads literally.** It answers the question you wrote, not the one you meant. Put the
  boundary cases in `yes` and `no`.
- **It does not count.** "Does this file define more than five routes" is a guess. Use grep and
  count.
- **It does not compare numbers or dates.** "Is the timeout above 30 seconds" and "was this
  written after 2024" belong to code. Ask where the value is, then read it.
- **It stumbles on negatives and indirection.** Ask "does it log the error", not "does it fail to
  not log the error".
- **The file can argue back.** A file that tells the model how to answer can move the answer.

## Install

```bash
claude plugin marketplace add janegbert/ask-jev
claude plugin install ask-jev@ask-jev
```

The same plugin lives under the Calq org as `Calq-dev/ask-jev`. Either marketplace works.

Then `/plugin configure ask-jev@ask-jev` and paste your TypeSafe key. Leave it empty to use
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

- One thing per question. `filter_files` takes yes/no questions only.
- Use `grep` when the answer must be exact: line numbers, every call site, a precise string.
- The file is sent to TypeSafe. Do not use it for files that may not leave your machine.
- At most eight parts per file; beyond that the answer says how much it did not read.
- At most six requests run at once, across all tools. A rate limit, an overload or a dropped
  connection is retried twice, the way TypeSafe's own SDKs do it.
- One Node file, no dependencies.

MIT.
