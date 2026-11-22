# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/badboy0771/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/badboy0771/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files, built for the
[make.fun](https://make.fun) `hidden-spec-cli-01-run-20261122` bounty. Models write edits in four formats —
a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor
tool calls as JSON — and `mend` reads all four to one written specification, `SPEC.md`, finds the lines an
edit names even when the model drifted their whitespace or indentation, and changes every file or none.

## Run it

Node 22, standard library only, no install:

```sh
node main.ts [options] [PATCH]
```

- `PATCH` is the patch file, relative to the working directory (the root of the tree); absent or `-` reads
  the patch from standard input.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a` or `json`; `auto`, the default,
  detects it.
- `--check` does everything but write: the same output and exit code, no file created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit `0` prints one line per changed path (`A`/`D`/`M`, `R <old> -> <new>` for a move) and `ok: <n> files`;
exit `1` lists every edit that failed and `failed: <k> of <n> edits`, and no file is written; exit `2` is a
usage, missing-patch, format or parse error.

## How it works

- **Three-tier matching (SPEC §5).** Old lines are found at the first tier where they occur: exact, then
  trailing whitespace ignored, then leading and trailing whitespace ignored. At tier 2 the new lines are
  re-indented to the file's own indentation; context lines are always written as the file's own lines.
- **Unified diffs (SPEC §6).** Sections, renames, creates, deletes and moves; hunks apply in order with the
  drift `d`, each taking the occurrence nearest its (possibly wrong) line number; `\ No newline at end of file`
  decides the final line break.
- **SEARCH/REPLACE blocks (SPEC §7).** Path taken from the nearest non-blank, non-fence line above the block
  (or the previous block's path); an old block that occurs more than once at its tier is `ambiguous`.
- **V4A patches (SPEC §8).** Add / Delete / Update / Move-to sections; chunks follow an anchor cursor, and an
  `*** End of File` chunk only takes an occurrence ending at the file's last line.
- **JSON edits (SPEC §9).** `create`, `str_replace` and `insert`, as an array or JSON Lines, with CRLF files
  read and written back in their own line breaks.
- **Atomicity (SPEC §10).** Edits apply in patch order to the tree as earlier edits left it; a failed edit
  changes nothing and the edits after it still run; when any edit failed, no file is written.

## The files

- `main.ts` — the CLI. Its last lines hand a trial over to `runner.ts` when `MAKEFUN_ENV_URL` is set.
- `runner.ts` — the kit's runner, as shipped: reads the trial's checks, runs `main.ts` on each in a fresh
  directory, and posts the results.
- `check.ts` — the practice set on your own machine:

      node check.ts ../program/generator/practice.json
      node check.ts ../program/generator/practice.json u-offset s-basic

- `SPEC.md` — the whole specification.
- `LICENSE` — MIT.

## Practice score

100 of 100 practice checks pass (unified 30/30, search_replace 20/20, v4a 20/20, json 15/15, cli 15/15),
practice score 1000.
