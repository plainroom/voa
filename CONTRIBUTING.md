# Contributing to voa

voa is small on purpose: one inbox, three exits (done, star, remind me), a photo at zero. Changes that add screens, settings or chrome are unlikely to fit; fixes and polish are welcome.

## Setup

```bash
git clone <this repository>
cd voa
npm install
npm run tauri dev
```

See [docs/development.md](docs/development.md) for prerequisites and commands.

## Before a pull request

```bash
npx tsc --noEmit
npm run test
npm run build
```

Add a test next to the code you change. Screens use only the design tokens in `src/voa/ui/tokens.css`. Keep database migrations append-only.

## Bugs

Open an issue with what you did, what you expected, what happened, your OS and the voa version. Never paste tokens or mail content.

## License

By contributing you agree that your contribution is licensed under the [Apache License 2.0](LICENSE).
