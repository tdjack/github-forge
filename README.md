# github-forge

A standalone GitHub-compatible git forge, built for
[github-core-clone-01](https://make.fun/bounty/github-core-clone-01).
One Node 22 process, standard library only, no dependencies, no git binary,
no outside service.

## Run it

```sh
node --experimental-strip-types main.ts
```

`MAKEFUN_ENV_URL` names the env to register with (the lifecycle in `main.ts`:
bind an ephemeral port, POST `/register`, poll `/done`, exit 0).

## What it serves

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}` |
| `GET /api/v3/` | GitHub API root, `X-OAuth-Scopes: repo, read:org` |
| `/api/v3/...` | REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files and merges |
| `POST /api/graphql` | GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: `server/discover`, `initialize`, `tools/list`, `tools/call` |
| `/<owner>/<repo>.git/...` | git smart HTTP: protocol v2 `info/refs` / `ls-refs` / `fetch`, v0 `receive-pack` |

Every API call carries `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; a missing
or wrong token is refused with 401. The token owner is the scenario's first
generated user, re-derived deterministically from the kit's fixed seed.

## How it works

- In-memory store with deterministic ordering and fixed-epoch timestamps, so
  two runs on the same instance leave the same state.
- Pure-TypeScript git: SHA-1 objects, trees, commits, tags, packfile reading
  (OFS_DELTA and REF_DELTA) and writing (no deltas), pkt-line framing and
  sideband-64k, shallow/deepen fetch, fast-forward enforcement on push.
- Pull requests track their base at creation, so a second merge of the same
  file after the base moved is a 405 conflict; a squash merge writes one
  commit onto the base branch with the head's content.

## Layout

- `main.ts`: the entry <-> env lifecycle. Keep it as it is.
- `app.ts`: the whole forge.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT).
