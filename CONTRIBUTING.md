# Contributing to DJ Manager

Thank you for your interest in contributing! This document covers how to get set up, the project's conventions, and the different types of tests.

---

## Getting started

```bash
git clone https://github.com/Radexito/djman.git
cd djman
npm install
cd renderer && npm install && cd ..

# Download the mixxx-analyzer binary
bash scripts/download-analyzer.sh

# Install local FFmpeg binaries (Linux)
bash scripts/install-ffmpeg.sh

# Start the dev server
npm run dev
```

---

## Project structure

```
src/           Electron main process (Node.js ESM)
renderer/      React 19 + Vite UI
src/audio/     Worker thread — calls mixxx-analyzer binary
src/db/        SQLite schema, migrations, repositories
.github/       CI/CD workflows, issue templates
scripts/       Dev helper scripts (no Python required)
```

See `.github/copilot-instructions.md` for a detailed architecture walkthrough.

---

## Code style

- **ESLint + Prettier** are enforced via a pre-commit hook (Husky + lint-staged).  
  They run automatically on `git commit` — just write code and commit normally.
- To run manually: `npm run lint:all` and `npm run format:check`
- Single quotes, 2-space indent, 100-char line width (see `.prettierrc`)

---

## Testing

### Unit tests (Vitest)

The main process and renderer each have Vitest suites.

```bash
# Run all unit tests
npm test

# Watch mode
npm run test:watch

# With coverage (must stay above 75% statements/functions/lines, 70% branches)
npm run test:coverage
```

Test files live in `src/__tests__/` and `renderer/src/__tests__/`.

### E2E tests (Playwright)

End-to-end tests launch the full Electron app and interact with it like a real user. Playwright is the current standard for Electron E2E testing.

```bash
# Install Playwright (one-time)
npm install --save-dev @playwright/test playwright

# Run E2E tests
npx playwright test
```

E2E tests live in `e2e/`. When writing them, use Playwright's [Electron launch API](https://playwright.dev/docs/api/class-electron):

```js
import { _electron as electron } from 'playwright';

const app = await electron.launch({ args: ['.'] });
const window = await app.firstWindow();
// interact with window...
await app.close();
```

> **Note:** E2E tests are not yet part of CI — contributions to add them are very welcome.

---

## Submitting changes

1. Fork the repo and create a branch: `git checkout -b feat/my-feature`
2. Make your changes — the pre-commit hook will lint and format automatically
3. Open a pull request against `master`
4. Describe what you changed and why

---

## Reporting bugs

Use the [GitHub Issues](https://github.com/Radexito/djman/issues) page. Please include:

- OS and version
- Steps to reproduce
- What you expected vs what happened
- Any relevant logs from DevTools (`Ctrl+Shift+I`)
