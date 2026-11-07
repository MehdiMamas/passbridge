# Contributing to PassBridge

Thanks for helping. Questions and ideas are welcome in [Discussions](https://github.com/MehdiMamas/passbridge/discussions); bugs and concrete requests go in [Issues](https://github.com/MehdiMamas/passbridge/issues). Issues labelled [good first issue](https://github.com/MehdiMamas/passbridge/labels/good%20first%20issue) are small and self-contained.

## Setup

You need Node.js 22.18 or newer and pnpm 10 (`corepack enable`). The project uses pnpm, not npm.

```bash
git clone https://github.com/MehdiMamas/passbridge.git
cd passbridge
pnpm install
pnpm build
```

Load `dist/` unpacked from `chrome://extensions`. Disable Apple's own iCloud Passwords extension first: both use the same extension id. Platform steps are in [SETUP.md](SETUP.md); how the code is laid out is in [AGENTS.md](AGENTS.md).

## Tests

- `pnpm typecheck` checks the extension and the tooling.
- `pnpm test` runs the main suite; `pnpm test:unit` runs the unit tests alone.
- Browser tests (also run in CI): `pnpm exec playwright install --with-deps chromium`, then `node test-harness/automation/build-test-extensions.ts` and `node test-harness/automation/run-all.ts`. On Linux wrap the last one in `xvfb-run -a`. They use a simulated Apple helper, so no iCloud account is needed. See [test-harness/automation/README.md](test-harness/automation/README.md).

Run typecheck and tests before opening a pull request. A behavior change comes with a test.

## Upstream sync

Field-detection lists and the Apple protocol code come from pinned upstream projects (Bitwarden, au2001, Open Passwords). To pull a newer commit:

```bash
pnpm sync <name> [commit]
```

Read the printed diff, rebuild, run the tests, and only then add `--accept`. Details and the list of upstreams are in [UPSTREAMS.md](UPSTREAMS.md). Keep the credit lines for the upstreams in the README and NOTICE.

## Pull requests

- Branch from `main`, keep one change per pull request, and say what it fixes and how you checked it.
- Link the issue it closes (`Closes #123`).
- CI must be green (typecheck, build, tests).
- Site-specific autofill fixes go in `patches/site-fixes.md` with the page they cover.
- Update `README.md`, `SETUP.md` or `AGENTS.md` when you change how something works.
- By contributing you agree your work is released under the project's [GPL-3.0 license](LICENSE).

## Reporting security problems

Do not post vulnerabilities in a public issue. Use the repository's "Report a vulnerability" button under the Security tab.
