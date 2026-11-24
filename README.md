# mend

One patch tool for every AI edit format. mend applies AI-written edits — unified diffs (even with wrong line numbers), SEARCH/REPLACE blocks, V4A patches and JSON text-editor tool calls — to a tree of files, finding the lines an edit names even when their whitespace or indentation has drifted, and changing every file or none.

This repository is an entry to the make.fun bounty [Build mend, one patch tool for every AI edit format](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

## Files

- `main.ts` — the mend CLI (Node 22, standard library only)
- `runner.ts` — the runner the entry is exercised with

## License

MIT — see `LICENSE`.
