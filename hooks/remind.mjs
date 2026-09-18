#!/usr/bin/env node
// One line at the start of every session, in every project. Keep it short: this costs tokens
// each time, and its whole job is to make the tools spring to mind at the right moment.

const NUDGE = [
  "ask-jev is available. When you need a fact about a file rather than its contents, call",
  "ask_file instead of reading it; use filter_files to narrow a list before opening anything.",
  "Above 0.70 is yes, below 0.30 is no, in between: read the file yourself.",
].join(" ");

process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: NUDGE },
}));
