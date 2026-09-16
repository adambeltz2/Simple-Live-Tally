# Backlog

Known follow-ups and enhancements that haven't shipped yet. Anything here
that gets built moves to `CHANGELOG.md` under its release and is removed
from this list — this file is only what's still outstanding.

## Reliability

- [ ] **Bulk JSON editor replaces the whole file, no merge.** Saving
      through the "Raw JSON" tab overwrites the entire stored file, so a
      concurrent edit made by someone else between opening the editor and
      hitting Save is silently discarded (no merge, no conflict warning).
      Acceptable for a power-user bulk-edit tool, but worth calling out in
      the UI if it becomes a recurring pain point.

## Process

Every PR that fixes a bug or ships an enhancement should:
1. Add an entry under `[Unreleased]` (or the next version) in
   `CHANGELOG.md`.
2. Remove the corresponding item from this file, if one existed.
3. Add a new item here for anything it surfaces but doesn't fully resolve.
