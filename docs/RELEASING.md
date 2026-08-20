# Releasing and running

Three things ship from this repo: two container images and one npm package.

| artifact | what it is | where |
| --- | --- | --- |
| `ghcr.io/cowprotocol/cow-drop/keeper` | Activates registered drops and pays the gas. Holds a hot key. | GitHub Container Registry |
| `ghcr.io/cowprotocol/cow-drop/watch-tower` | Posts on-chain orders to the order book. No key. | GitHub Container Registry |
| `@cowprotocol/cow-drop-sdk` | Compile a recipe, derive an address, build the activation tx. | [npm](https://www.npmjs.com/package/@cowprotocol/cow-drop-sdk) |

The web app is **not** one of them: it deploys from Vercel, which builds it out of this repo, so no
image of it is published. `apps/web/Dockerfile` is still here and still builds — see [Building an
image locally](#building-an-image-locally) — and its leg of `docker.yml` is commented out rather than
deleted, so publishing it again is a one-line change.

The contracts are not released from here — a deployment is a **generation**, never an update in
place. See [DEPLOYMENTS.md](DEPLOYMENTS.md).

## Cutting a release

A tag is the entire process:

```bash
git tag v0.1.0
git push origin v0.1.0
```

That fires two workflows:

- [`release.yml`](../.github/workflows/release.yml) — re-checks the address derivation against the
  contracts, publishes the SDK to npm with a provenance attestation, and opens the GitHub release
  with generated notes.
- [`docker.yml`](../.github/workflows/docker.yml) — builds and pushes both images, tagged `0.1.0`,
  `0.1`, `latest` and `sha-<commit>`.

The two run in parallel off the same tag, and neither waits on the other: a failed npm publish still
leaves the images pushed, and vice versa. Both are re-runnable — see below.

The tag is the only place the version lives. `packages/sdk/package.json` carries a placeholder for
local installs; the workflow overwrites it before packing, so there is no version bump to forget and
no way for the published version to disagree with the tag.

Creating the release from the GitHub UI works too — that also pushes the tag, and `release.yml`
leaves an existing release's notes alone.

### Prereleases

A prerelease suffix routes everything away from the defaults: npm gets dist-tag `next` instead of
`latest`, the GitHub release is marked prerelease, and the images do **not** get `latest`.

```bash
git tag v0.2.0-rc.1 && git push origin v0.2.0-rc.1
# consumers: pnpm add @cowprotocol/cow-drop-sdk@next
```

### If a release fails halfway

Re-running the workflow is safe. The npm publish skips a version that is already on the registry,
and the release step skips a release that already exists. Note that npm publishes are **not**
retractable — which is why the derivation checks run before the publish, not after.

## Repository settings this depends on

| secret / setting | used by | needed for |
| --- | --- | --- |
| `NPM_TOKEN` | `release.yml` | Publishing the SDK. An automation token for the `@cowprotocol` org, with publish rights. |
| `AUTODEPLOY_URL`, `AUTODEPLOY_TOKEN` | `docker.yml` | Rolling the `:main` images out after a push to `main`. |
| Workflow read/write permissions | `release.yml` | Creating the GitHub release. |

Pushing to GHCR needs no secret — `GITHUB_TOKEN` covers it. The one caveat is that a pull request
from a **fork** cannot push images, so its `docker` job fails; branches in this repo are fine.

## Running the images

Both services take their configuration as flags, with environment fallbacks, and both persist state
under `/data`. Mount it: see the note on each below for what losing it costs.

### Keeper

Spends real money, so it needs a funded hot key and a policy. The key is read from a file or the
environment, never an argument — an argument is readable by every other process on the host.

```bash
docker run -d --name cow-drop-keeper \
  -p 8787:8787 \
  -v cow-drop-keeper:/data \
  -e RPC_URL=https://rpc.gnosischain.com \
  -e KEEPER_PRIVATE_KEY=0x... \
  ghcr.io/cowprotocol/cow-drop/keeper:latest \
  --state /data/state.json --cursor /data/cursor.json --policy /data/policy.json
```

- **Set `--policy` before pointing anything public at it.** The default subsidises every owner up to
  a small daily budget.
- `/data` holds the registry of watched drops and the spend ledger. Neither is reconstructible from
  the chain: lose it and the keeper forgets which drops it agreed to watch, and forgets how much of
  today's budget it already spent. Back it with real disk.
- `GET /v1/health` reports the payer, its balance and the budget left. Browsable API docs are at
  `/v1/docs`.
- It runs a watch tower in-process, so **do not** also run the watch-tower image for the same chain.

### Watch tower

Nothing privileged and no key — the orders it posts are already signed on-chain, so this only makes
them visible to solvers. Running two is harmless.

```bash
docker run -d --name cow-drop-watch-tower \
  -v cow-drop-watch-tower:/data \
  -e RPC_URL=https://rpc.gnosischain.com \
  ghcr.io/cowprotocol/cow-drop/watch-tower:latest \
  --state /data/cursor.json --only-drops
```

`/data` holds only a block cursor. Losing it is recoverable — the tower restarts from the head, at
the cost of not posting whatever was placed while it was down.

### Web

Deployed from Vercel, so there is no image to pull — build it yourself if you want to run it as a
container:

```bash
docker build -f apps/web/Dockerfile -t cow-drop-web .
docker run -d --name cow-drop-web \
  -p 8080:80 \
  -e KEEPER_URL=https://keeper.example.com \
  -e RPC_URL=https://rpc.gnosischain.com \
  cow-drop-web
```

It is configured at **container start**, not at build time, so one image is promotable across
environments. The entrypoint writes `$KEEPER_URL` and `$RPC_URL` into `/config.js` before nginx
starts; see [`apps/web/src/lib/runtimeConfig.ts`](../apps/web/src/lib/runtimeConfig.ts).

Both are optional. With no `KEEPER_URL` the page hides **Hand to keeper** and keeps drops locally
only; with no `RPC_URL` it falls back to its built-in public endpoints. Locally, `VITE_KEEPER_URL`
and `VITE_RPC_URL` still work exactly as before — the runtime values just take precedence.

## Building an image locally

All three build with the **repo root** as context, because each one depends on the SDK through the
workspace — including the web one, which CI no longer publishes:

```bash
docker build -f packages/keeper/Dockerfile -t cow-drop-keeper .
docker build -f packages/watch-tower/Dockerfile -t cow-drop-watch-tower .
docker build -f apps/web/Dockerfile -t cow-drop-web .
```

No foundry toolchain and no submodules are needed: `packages/sdk/src/generated/` is committed, and
CI is what guarantees the committed copy still matches the contracts.
