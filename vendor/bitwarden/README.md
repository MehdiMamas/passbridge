These files are copied from bitwarden/clients `apps/browser/src/autofill` at the commit in `PINNED`.

They are GPL-3.0. They are the sync baseline, not a second runtime. PassBridge's running code is under `src/`. When Bitwarden changes autofill behavior, run `pnpm sync:bitwarden <commit>`, read the diff, update `src/`, and move the pin.

Nothing under `bitwarden_license/` is included. The Bitwarden name and logo are not used.
