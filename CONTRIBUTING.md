# Contributing to GitSentry

Thank you for your interest in contributing to GitSentry!

## What's in scope

This repository contains the open source analysis engine:

- `apps/backend/` — the webhook server and AI analysis engine
- `packages/shared/` — shared TypeScript types and constants

The dashboard at [gitsentry.dev](https://gitsentry.dev) is proprietary.

## Getting started

1. Fork the repo and clone it locally
2. Follow the self-hosting setup in [README.md](README.md)
3. Create a branch: `git checkout -b feat/your-feature`

## Pull request guidelines

- Keep PRs focused. One feature or fix per PR.
- Add tests for new behaviour.
- Run `yarn test` before opening a PR.
- Write a clear PR description: what changed and why.

## Security issues

Do **not** open a public issue for security vulnerabilities. Email
security@gitsentry.dev instead.

## Code of Conduct

Be kind. We're all here to make security tooling better.
