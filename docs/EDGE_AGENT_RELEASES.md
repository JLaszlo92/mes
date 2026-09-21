# Edge Agent Release Process

**Scope:** `packages/edge-agent` and its Python bridge scripts
(`packages/edge-agent/python/*.py`) — the code that runs on node-gate and
talks to the actual machines. This does NOT cover the backend or frontend,
which deploy differently (direct `git pull` + `pnpm run build` +
`systemctl restart`, per `DEVELOPMENT_STATUS.md`).

## Why git tags instead of cryptographic signing

PRD Section 8.6 asks for edge updates to be "staged" (not forced
immediately) and "reversible" (a failed update should roll back
automatically rather than bricking a device mid-production). A full
PKI-based signing scheme — where the edge agent verifies a cryptographic
signature before accepting an update — is the eventual, formal answer to
this, but Section 8.1's own phasing logic applies here too: that
infrastructure is reasonable to build once a real customer's security
requirements demand it, not speculatively for a one-node internal pilot.

What this process gives instead: every deployed version is a named,
immutable git tag, deployment is a single deliberate command (never
automatic), and rolling back to the previous version is equally a single
command — reversible in practice, even without a cryptographic
verification step. If a customer later requires signed updates, this
tagging discipline is exactly the foundation that scheme would build on.

## Cutting a release

Once a change to the edge agent has been tested and is ready to deploy:

```bash
scripts/tag-edge-agent-release.sh "add reconnection logic to ModbusSignalSource"
```

This tags the current commit as the next `edge-agent-vN` and pushes the
tag to GitHub.

## Deploying a release

On node-gate:

```bash
git pull origin main          # make sure the tagged commit is available locally
scripts/deploy-edge-agent.sh edge-agent-v5
```

Or, to deploy whatever the newest tag is without looking it up:

```bash
scripts/deploy-edge-agent.sh --latest
```

The script checks out the tag, rebuilds `packages/edge-agent`, and
restarts every edge-agent systemd service that exists on this node.

## Rolling back

If a deployed version turns out to have a problem:

```bash
scripts/deploy-edge-agent.sh --rollback
```

This finds the tag immediately before the one currently deployed,
deploys it, and restarts the services — no need to remember or look up
the previous version number.

## Checking what's currently deployed

```bash
git describe --tags --match 'edge-agent-*' --exact-match
```

If this prints a tag name, that tag is exactly what's running. If it
errors, the working tree is on some untagged commit (e.g. mid-development
on `main`) rather than a released version.