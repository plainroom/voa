# AGENTS.md

For any coding agent working on voa.

- Code, identifiers, commits and docs are in English. The UI copy is English.
- Never use an em dash or an en dash.
- Screens use only the tokens and primitives in `src/voa/ui/`.
- Run `npx tsc --noEmit && npm run test` before every commit. Run `cd src-tauri && cargo check` when Rust changes.
- Nothing may archive, relabel or send mail differently than the user asked. Changes to `src/services/gmail/`, `src/services/snooze/` or `src/services/emailActions.ts` need a test for each path.
- Commands and account setup are in `docs/development.md`.
