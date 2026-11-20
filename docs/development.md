# Development

## Prerequisites

- [Node.js](https://nodejs.org/) 24 or newer
- [Rust](https://www.rust-lang.org/tools/install) (latest stable)
- Tauri v2 system dependencies ([see Tauri docs](https://v2.tauri.app/start/prerequisites/))

## Commands

```bash
npm install
npm run tauri dev          # the app
npm run dev                # Vite only; ?demo=1 gives an in-memory inbox in a browser
npm run test               # all tests
npx tsc --noEmit           # type-check
npm run build              # type-check + production frontend
npm run tauri build        # installers for your platform
cd src-tauri && cargo check
```

## Accounts

- Gmail needs your own Google OAuth client: [docs/google-client.md](google-client.md).
- Outlook or Hotmail (personal): Add account, Outlook. It needs a Microsoft client ID saved in Settings: [docs/microsoft-client.md](microsoft-client.md).
- IMAP/SMTP: Add account, IMAP / SMTP. Well-known providers are filled in; others take the server details. No Google project needed.

## Tests

Vitest with jsdom, `globals: true`, `src/test/setup.ts` as setup. Tests are next to the code they cover. Screens run against the demo source (`setDemoSource`) or a real SQLite in memory (`src/voa/inbox/inboxDb.test-helper.ts`).
