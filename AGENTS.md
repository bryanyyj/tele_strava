# Repository Guidelines

## Project Structure & Module Organization

This repository contains a private Strava-to-Telegram bot running on Cloudflare Workers. `src/index.ts` handles HTTP routes, OAuth callbacks, queue consumption, and scheduled cleanup. `src/bot.ts` implements activity notifications and conversations. `src/api.ts` wraps Strava and Telegram; `src/store.ts` handles D1 persistence. Database migrations live in `migrations/`, tests in `tests/`, and administrative scripts in `scripts/`. GitHub workflows live in `.github/workflows/`. There is no frontend or asset pipeline.

## Build, Test, and Development Commands

- `npm ci`: install dependencies from the lockfile using Node.js 24.
- `npm run types`: regenerate Worker bindings after changing configuration.
- `npm run db:local`: apply migrations to local D1 storage.
- `npm run dev`: start Wrangler's local Worker runtime.
- `npm run typecheck`: check strict TypeScript types.
- `npm test`: run Vitest tests against local D1 and mocked external APIs.
- `npm run build`: validate and bundle with Wrangler's deployment dry run.

## Coding Style & Naming Conventions

Use TypeScript with two-space indentation, semicolons, and single-quoted strings. Use `camelCase` for functions and variables, `PascalCase` for types, and uppercase environment binding names. Keep API calls in the API module and persist conversation state in D1. Await promises and use bounded network timeouts. No formatter or separate lint tool is currently configured.

## Testing Guidelines

Name tests `tests/*.test.ts`. Cover owner authorization, OAuth state consumption, webhook validation, conversation order, gear selection, and retry behavior when changing these paths. Mock external APIs; never call real Strava or Telegram services in tests. No numerical coverage threshold is enforced. Run type checking, tests, and the build before submitting changes.

## Commit & Pull Request Guidelines

The project has no prior commit conventions. Use concise Conventional Commit messages such as `feat: add gear selection`. Describe resulting behavior, link relevant issues, and include validation results in pull requests. Include Telegram screenshots for conversation changes when available, with personal data removed.

## Secrets & Deployment

Keep credentials in ignored `.env` files locally and GitHub/Worker secrets in production. Never log tokens, authorization codes, or secret webhook URLs. Deployment requires explicit owner approval; pushing code must not deploy. Use the manually triggered GitHub deployment workflow only after approval. Strava media attachments require its own app; do not invent unsupported upload endpoints.
