# Shared browser infrastructure

## Pinned CLI with verified shutdown patch

`cli.mjs` launches `@playwright/cli@0.1.19` from `agent/npm/browser/`, not the npm cache. It refuses an unpatched or unrecognized core bundle before launching anything.

Setup after checkout/reinstall:

```sh
npm ci --prefix ~/.pi/agent/npm/browser --ignore-scripts --no-audit --no-fund
node ~/.pi/agent/lib/browser/cli_patch.mjs
```

The patch is intentionally narrow: make `gracefullyProcessExitDoNotHang` idempotent. CLI stop and the context-close listener both call it; re-entry force-kills an already-closing Chrome before cookies flush. The pinned source is [playwright-core 1.63.0-alpha-2026-08-31](https://unpkg.com/playwright-core@1.63.0-alpha-2026-08-31/lib/coreBundle.js). `cli_patch.mjs` validates full original/patched SHA-256 hashes, applies atomically, and rejects any other bytes. Upgrades require review and a new live persistence proof; no silent patch drift.

Evidence: unpatched close produced SIGKILL and lost a synthetic persistent cookie on two restarts. The identical dependency with the latch exited normally and retained it. Direct Playwright close/reopen also retained it. A separate profile never saw the test cookie. Only disposable example.com profiles were used; authenticated profiles remain untouched.

Verification:

```sh
node --test ~/.pi/agent/lib/browser/cli_patch.test.mjs
node ~/.pi/agent/lib/browser/persistence.smoke.mjs
```

The smoke opens two disposable Chrome windows, writes one harmless persistent cookie, tests restart/isolation, and closes both. It is not part of the unit suite because it starts a browser and visits example.com.

## One session/identity foundation

```
main browser tool / browser.py
crew browser tool
          │
          ▼
     session.ts
   validate → lease → guard
          │
          ▼
       cli.mjs
     pinned Playwright
```

`config/browser_profiles.json` owns the profile registry and root directory. Existing identity directory names remain unchanged. `pool.ts` is shared with legacy MCP while fleet is retired. Browser-role crew workers automatically load the CLI tool; `mcp: "browser"` remains a compatible opt-in spelling for other roles, not an MCP adapter.

- **Identity outlives task.** A task record lives in `workers/browser_cli/<owner-hash>/<session>/`; Chrome uses the leased identity directory, not that task directory. No profile copy/import/export.
- **Exclusive ownership.** Atomic registry mutex, random lease tokens, daemon PID ownership and Chrome `SingletonLock` checks prevent concurrent acquisition and stale-token release. Mutex failures stop; they are not silently stolen. Chrome still alive after a worker crash retains its lease until closed.
- **CLI namespace isolation.** Each task gets a `.playwright` marker. CLI scopes daemon names by this marker, not by cwd; missing it lets identical task names in different owners collide. The live handover smoke was seen red before this marker, green after.
- **Shared auth interception.** Before keyboard/form input, read a fresh snapshot/URL and the target's field descriptor through the same auth rule used by the browser role. Missing evidence, auth hosts and credential fields block. This is accident prevention, not a sandbox or authorization to submit/mutate shared records.
- **Private evidence.** Owner/task directories are created mode 0700, state/locks 0600. Captures stay there; scrub before sharing. Supported commands reject arbitrary scripts, config/profile overrides, cookie export/import, and screenshot path escapes.

## Verification and remaining acceptance

`node lib/browser/handover.smoke.mjs` uses only newly created temporary profiles. It proves named-identity contention, cookie-preserving close/handover, and independent live browsers for identical main/worker task names. Unit tests exercise the actual registrar and crew capability helper; fresh snapshots block auth before dispatch while ordinary typing still works.

**Live tool acceptance passed:** main held scratch-1 while an actual browser worker opened the identical task name on scratch-2, snapshotted and closed it. Main independently confirmed its window remained intact. This exposed inline YAML snapshot output; the shared typing guard accepts both inline and file-linked snapshots, with auth blocks preserved and live ordinary typing verified through the compatibility entrance.

**Still requires human acceptance:** controlled handover of a real authenticated profile. Synthetic cookies do not prove a site's full login/MFA lifecycle. No authenticated profile has been opened or migrated by these tests.

- Main leaves its browser open; explicit close releases the lease. Normal worker shutdown attempts closure. Hard kills or shutdown failures require closing that owner's window; no automatic takeover.
- Old Python task-profile directories are left untouched. New owner-scoped tasks do not adopt their daemons.
- Existing live CLI daemons keep their loaded version. Close/reopen to use the patched launcher.
- Session cookies, site expiry/MFA and browser-crash recovery remain separate cases; this is not a promise of permanent login.
- Remove the dependency patch only when an upstream release passes the same persistence test.
