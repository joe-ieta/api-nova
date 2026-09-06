# Testing Documentation

> Document status: Active index
> Last reviewed: 2026-09-06

This directory contains executable acceptance cases and release evidence requirements. Unit-test source remains next to implementation code; historical test plans belong in `docs/archive`.

## Active Test Assets

- [Runtime Publication Acceptance Cases](./runtime-publication-acceptance-cases.md)
- [安全调用与日志审计验收用例](./runtime-security-audit-cases.md)

## Status Vocabulary

- `automated-passed`: executed successfully in the current checkout
- `automated-covered`: covered by an automated test but not necessarily rerun in the latest acceptance session
- `manual-required`: requires operator interaction or a real external service
- `environment-blocked`: cannot run until the named environment exists
- `open-gap`: acceptance is defined but implementation is incomplete

Every manual result must record date, commit, platform, database mode, upstream identity, operator, and evidence location.
