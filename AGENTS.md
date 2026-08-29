# Agent notes — pictaria-server

## Engineering workflow (Linear ↔ GitHub)

This repository has used the **full pull-request flow** since July 24, 2026.
These rules are public-safe and self-contained; access to any other repository
is not required.

- Linear is the source of truth for work and GitHub is the source of truth for
  code. Use an issue in **Pictaria Server**, or a repository-specific sub-issue
  of a cross-product **Pictaria Launch** issue.
- Before implementation, read the issue and linked evidence, inspect the
  current code and worktree, confirm there is no existing branch or PR, and
  move the issue to **In Progress**.
- Use one focused branch per issue, normally `pic-XX-short-description`.
  Start PR titles with `PIC-XX:`. On branches intended for a public repository,
  never use a personal-name prefix.
- Every tracked change, including repository documentation, requires a pull
  request. Do not commit directly to `main`.
- Use `Fixes PIC-XX` only when merging the PR completes the whole issue. Use
  `Related to PIC-XX` when deployment, another repository, restore/upgrade
  testing, or any other acceptance criterion remains.
- PR descriptions must explain the outcome, material changes, validation,
  risks/rollback, remaining work, and any material agent authorship or
  independent agent review.
- Run validation proportionate to risk: the relevant tests, the full suite
  when warranted, container build/boot checks, and backup, restore, upgrade,
  or live-reference validation when required. A merge alone does not make an
  issue Done when deployment or operational acceptance remains.
- Preserve unrelated changes in dirty worktrees. Never put credentials,
  tokens, private photo data, household/network details, or sensitive logs in
  Linear, commits, branches, PRs, images, or public documentation.
- User-facing or operational behavior changes update the `CHANGELOG.md`
  Unreleased section and durable documentation in the same PR.
- Naming: the app is **Pictaria Frame** — or **Frame** when "Pictaria" was
  just named. Never "the frame app" or a generic lowercase "frame" when the
  product (rather than a physical device) is meant.
