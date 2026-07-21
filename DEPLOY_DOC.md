# Deployment

This webview is **not** hosted on a traditional CDN/PaaS. The built bundle is
published to the **Polkadot Bulletin Chain** (content-addressed, served over
IPFS gateways) and bound to a human-readable **DotNS `.dot` domain**. The
native app loads that `.dot` name directly; browsers reach it through a gateway.
Deployment is automated by a GitHub Actions workflow that calls the shared
[`paritytech/polkadot-app-deploy`](https://github.com/paritytech/polkadot-app-deploy)
reusable workflow.

> This repo ships an **example** deploy workflow. The committed
> [`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml) fills in a
> concrete domain, environment, and gateway purely as an illustration — replace
> those with your own (see §3e). The valid environment ids, gateways, and RPC
> endpoints come from `polkadot-app-deploy` itself (`--list-environments`), not from
> this repo.

- **Workflow:** [`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml)
- **Only required secret:** `DOTNS_MNEMONIC`

---

## 1. How it works (the big picture)

```
push to main ─┐
PR opened ────┤→  typecheck ─┬─ build (npm run build → dist/, uploaded as artifact)
              │              │
              │              ▼
              │   polkadot-app-deploy reusable workflow:
              │     1. download the build artifact
              │     2. merkleize + upload the files to the Bulletin Chain (→ a CID)
              │     3. point a DotNS .dot domain at that CID (signed by DOTNS_MNEMONIC)
              ▼
        a .dot URL that serves this exact build
```

There is no server to provision and no environment to keep running — a deploy
is a chain transaction that publishes immutable content and repoints a name at
it. "Rolling back" means repointing the name at a previous CID.

### Where each trigger lands

| Trigger | Job | Domain | Browser URL |
|---|---|---|---|
| **Pull request** | `deploy-preview` | a throwaway per-PR `.dot` name | `https://<pr-domain>.<gateway>` |
| **Push to `main`** / manual | `deploy-production` | your `.dot` name | `https://<domain>.<gateway>` |

The production job can be a matrix that publishes the **same** `.dot` name to
more than one environment, so builds on different networks all resolve it. Each
PR gets its own throwaway preview domain and a sticky PR comment with the link.

> The in-app browser resolves the bare `.dot` name natively (via DotNS). The
> gateway URL is for opening the build in a normal browser (e.g. testing on a
> phone — see §7).

---

## 2. The one secret you must set

Add a single **repository secret** (Settings → Secrets and variables →
Actions → New repository secret):

| Secret | Required | What it is |
|---|---|---|
| `DOTNS_MNEMONIC` | **Yes** | The mnemonic (seed phrase) of the account that **owns the `.dot` domain(s)** and signs the deploy. |
| `SENTRY_DSN` | No | Optional Sentry DSN for deploy telemetry (the workflow doesn't wire it today, but the reusable workflow accepts it). |

**What the `DOTNS_MNEMONIC` account must satisfy** for deploys to succeed:

1. **It owns the domains it deploys.** It must own the `.dot` name you publish
   to and be able to register/own the per-PR preview names. If a name is owned
   by a different account the deploy fails with *"Domain … is owned by a
   different account"* — see §8.
2. **It (or its upload pool) is authorized for Bulletin storage.** Uploads go
   through Bulletin-authorized accounts. By default polkadot-app-deploy uses a
   derived **pool** of uploader accounts that must be authorized once by an
   operator (`polkadot-app-bootstrap`). If unauthorized you get *"Account … is not
   authorized for Bulletin storage"* — see §8.
3. **It is funded** on the target network to pay the DotNS registration storage
   deposit and transaction fees.

> Treat this mnemonic as a live credential — it controls the domain. Rotating
> it means transferring domain ownership to the new account first.

---

## 3. One-time setup (new repo, or re-bootstrapping)

The workflow file is already committed here, so for *this* repo you normally
only need step (d). The full sequence — from scratch, or for a new repo — is:

### a. Provision the deploy account

Generate a Substrate mnemonic for the deployer and fund it on the target
network. Testnets usually have a self-serve faucet and a self-serve DotNS
registrar — see your network's docs for those. Where a network maps
Ethereum ⇄ Substrate addresses automatically (`autoAccountMapping`), you don't
manage the mapping by hand.

### b. Register / own the `.dot` domain(s)

The owning account must hold the `.dot` name you publish to plus the
preview-domain namespace used by PRs. Register them through the DotNS registrar
for your target network; the registration storage deposit is paid by the
deployer account.

### c. Authorize Bulletin uploads (operator step)

Bulletin uploads require an authorized uploader. polkadot-app-deploy uses a
**pool** of derived accounts by default (to spread nonce/authorization load).
An operator initializes/authorizes that pool **once** per network with the
companion CLI:

```bash
npm install -g @parity/polkadot-app-deploy        # ships polkadot-app-bootstrap too
polkadot-app-bootstrap --env <id> --pool-size 10  # uses BULLETIN_POOL_MNEMONIC / MNEMONIC
```

This is an admin/setup operation, **not** part of routine deploys. On a managed
network the shared pool may already be authorized — check before bootstrapping
a new one.

### d. Add the GitHub secret

Set `DOTNS_MNEMONIC` (§2). That's the only repo-level configuration the workflow
needs.

### e. Point the workflow at your deployment

The workflow lives at `.github/workflows/deploy.yml` and ships with example
values. Change:

- the **artifact name** if you like,
- the **`dotns-domain`** values (the name you publish to + the PR-preview pattern),
- the **`env` / `gateway`** matrix to the network(s) you target — run
  `polkadot-app-deploy --list-environments` for valid ids,
- `permissions:` — `contents: read` at the workflow level; the preview job
  adds `pull-requests: write` so it can post its sticky PR comment,
- pin **`polkadot-app-deploy-version`** (minimum supported is `0.7.0`) and the
  reusable-workflow ref (`@v<version>`) to the same release.

---

## 4. The reusable-workflow inputs

`deploy.yml` calls `paritytech/polkadot-app-deploy/.github/workflows/deploy.yml@v0.13.1`
— the ref is pinned to the same release as `polkadot-app-deploy-version`; bump
both together. Inputs it accepts (the ones this repo sets are marked ✓):

| Input | Type | Default | Purpose |
|---|---|---|---|
| `artifact-name` ✓ | string | — (required) | Name of the build artifact to download. |
| `dotns-domain` ✓ | string | `''` | The `.dot` domain to bind (with extension). |
| `env` ✓ | string | the tool's default | Target environment id (drives both the Bulletin RPC and the Asset-Hub/DotNS RPC). Run `--list-environments` for valid ids. |
| `gateway` ✓ | string | the tool's default | Gateway host used to build the **display** URL only (doesn't affect the deploy). |
| `skip-cache` ✓ | boolean | `false` | Force redeploy, ignoring the build-hash cache. **Required `true` here** — see §6. |
| `comment-on-pr` ✓ | boolean | `false` | Post/replace a sticky PR comment with the deploy link. |
| `max-retries` ✓ | number | `1` | Retry attempts; retries fire only on flake-class chain errors (nonce-stale, ChainHead disjointed, …). This repo uses `10`. |
| `polkadot-app-deploy-version` ✓ | string | `''` (latest stable) | npm version/dist-tag of polkadot-app-deploy to install. |
| `js-merkle` | boolean | `false` | Pure-JS merkleization (skips the IPFS Kubo download). |
| `direct-signer` | boolean | `false` | Use the mnemonic directly as the signer instead of the derived upload pool. |
| `derivation-path` | string | `''` | Substrate derivation path on the mnemonic (e.g. `//deploy/3`) — lets parallel direct-signer runs avoid nonce contention. |
| `pool-size` | number | `10` | Number of derived pool accounts (pool mode). |
| `rpc` | string | `''` | Override the Bulletin RPC within the chosen env. |
| `runner` | string | `ubuntu-latest` | Runner label. |
| `polkadot-app-deploy-ref` | string | `''` | Build polkadot-app-deploy from a git ref instead of npm (takes precedence over `-version`). |
| `gateway-path-style` | boolean | `false` | URL form: `false` → `https://{domain}.{gateway}`; `true` → `https://{gateway}/{domain}.dot`. |
| `gh-pages-mirror` | boolean | `false` | Also push the CAR to the caller repo's `gh-pages` branch as an HTTP fast-path (needs `contents: write`). |
| `comment-header` | string | `polkadot-app-deploy` | Sticky-comment identity (override if multiple deploy workflows comment on the same PR). |
| `tag` | string | `''` | Free-form Sentry `deploy.tag` label. |

**Secrets:** `mnemonic` (required) ← `DOTNS_MNEMONIC`; `sentry-dsn` (optional).
**Outputs:** `cid` (content CID), `domain` (the bound `.dot` name).

---

## 5. How a deploy actually runs

The reusable workflow (per leg):

1. Node 22, downloads the `dist/` artifact.
2. Computes a **build hash** over the artifact and checks a GitHub Actions
   cache keyed on it. On a hit it reuses the prior CID and skips the upload
   (unless `skip-cache: true`).
3. Installs IPFS Kubo (unless `js-merkle`), installs the pinned
   `polkadot-app-deploy`, and asserts it's ≥ `0.7.0`.
4. Runs `polkadot-app-deploy build <dotns-domain> --env <env> [flags]`, which
   uploads the content to Bulletin and updates the DotNS record. Retries up to
   `max-retries` on transient chain errors only.
5. Validates that a CID + domain came back, writes a job summary (domain, CID,
   browser URL) and, on PRs, the sticky comment.

The equivalent local command (see §7) is `polkadot-app-deploy ./dist <domain>.dot --env <env>`.

---

## 6. Why `skip-cache: true` is mandatory for a multi-env matrix

The reusable workflow keys its deploy cache on the **build-content hash only**
— it does **not** include the env/network in the key. If you publish the same
build artifact to **more than one** environment from a matrix, then with
caching enabled whichever leg finishes first would populate the cache, and the
other leg would cache-hit and **skip its deploy entirely** — silently never
publishing to that environment.

Forcing `skip-cache: true` makes every leg always deploy. The tradeoff is that
every push to `main` redeploys every environment even when the build content is
unchanged; that's intentional. Leave it `true`.

---

## 7. Manual & local deploys

### Manual run from GitHub

The workflow has a `workflow_dispatch` trigger — run it from the Actions tab to
force a redeploy without a new commit.

### Local deploy (debugging only)

```bash
npm run build                            # → dist/index.html (single file)
npm install -g @parity/polkadot-app-deploy
export MNEMONIC="<the deploy mnemonic>"  # same account that owns the domain
polkadot-app-deploy ./dist <your-domain>.dot --env <env>
```

Use a throwaway domain when experimenting so you don't repoint a real one.
`polkadot-app-deploy --list-environments` shows valid `--env` ids; `--help` lists
all flags.

### Testing a build on a phone

iOS-WebKit-specific rendering can't be checked on desktop. Open a PR — the
`deploy-preview` job comments the preview gateway URL on the PR; open that on
the device. (You can also `npm run preview --host` and hit the dev machine over
LAN, but that won't exercise the DotNS/gateway path.)

---

## 8. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Domain … is owned by a different account` | `DOTNS_MNEMONIC` doesn't own that `.dot` name. Transfer the domain to this account, or deploy under a name it owns. |
| `Account … is not authorized for Bulletin storage` | The uploader (pool) isn't authorized on that network. Operator runs `polkadot-app-bootstrap` for that env (§3c). |
| Deploy "succeeds" but step fails on *"produced no CID or domain"* | The deploy process likely OOM'd. The workflow already sets `--max-old-space-size=8192`; re-run, and check for an unusually large `dist/`. |
| Only one environment got the new build | `skip-cache` was off — the second matrix leg cache-hit and skipped. Keep `skip-cache: true` (§6). |
| Preview comment didn't post | The calling workflow needs `permissions: pull-requests: write`. |
| Transient `nonce stale` / `ChainHead disjointed` / connection errors | Flake-class; `max-retries: 10` retries these automatically. A single failure usually self-heals on re-run. |
| Version error: *"polkadot-app-deploy vX is below minimum v0.7.0"* | Bump `polkadot-app-deploy-version` to ≥ `0.7.0`. |

---

## 9. Reference

Environment ids, gateways, and RPC endpoints come from polkadot-app-deploy, not
this repo — run `polkadot-app-deploy --list-environments` for the valid `--env` ids
and their gateways. Default URL form is subdomain: `https://<domain>.<gateway>`.

**Related:**
- Bridge contract / what the webview consumes at runtime: [`NATIVE_SPEC.md`](./NATIVE_SPEC.md)
- The deploy tool: [`paritytech/polkadot-app-deploy`](https://github.com/paritytech/polkadot-app-deploy)
