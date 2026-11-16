# github-core-clone

A standalone GitHub-compatible git forge: one Node process, its own
in-memory store, no UI, no outside services. It serves git smart HTTP
(clone/fetch/push), REST v3, GraphQL v4 and MCP — the four surfaces the
make.fun `github-core-clone-01` bounty grades.

## Run

```sh
node --experimental-strip-types main.ts
```

Node 22.18+ with type stripping; Node stdlib only, no dependencies, no
`git` binary — the pack protocol is implemented by hand. The entry binds an
ephemeral port, registers it at `$MAKEFUN_ENV_URL/register`, and polls
`$MAKEFUN_ENV_URL/done` until the trial ends (see `main.ts`).

For local practice, start the server with a tiny harness that calls
`createApp().listen(port)` (the entry point `main.ts` needs a
`MAKEFUN_ENV_URL` to register with), then point the kit runner at it:

```sh
MAKEFUN_SHOP_TOKEN=testtoken node --experimental-strip-types harness.ts
```

then, from the kit directory:

```sh
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:PORT --token testtoken [--perf] [--json]
```

## Layout

| File | What it does |
| --- | --- |
| `main.ts` | The entry ↔ env lifecycle (bind, register, wait for done). Kept as the kit shipped it. |
| `app.ts` | The one HTTP server: routes `/healthz`, REST, GraphQL, MCP and git smart HTTP onto a single store; every reply is JSON with `X-GitHub-Request-Id`. |
| `gitobj.ts` | The git object model: SHA-1 hashing, tree/commit/tag parsing and building, reachability and merge-base, pkt-line codec, packfile read/write (plain objects, deltas resolved on read). |
| `store.ts` | The store: repos, objects, refs, labels, issues and pull requests; fixed identity and timestamps so two runs on the same instance leave identical state. |
| `git.ts` | Git smart HTTP: v2 advertisement, `ls-refs`, `fetch` (v2 and v0) and `receive-pack`. The v2 fetch follows upload-pack's rule — a request carrying `done` gets no `acknowledgments` section, and the `packfile` section is always sent (even an empty pack) when the packfile is due. |
| `rest.ts` | GitHub REST v3: repos, branches, commits, contents, labels, issues, comments, pull requests (including squash merge with 3-way conflict detection); `Link` pagination; 401 without the bearer token. |
| `graphql.ts` | GraphQL v4: a small parser and executor for the queries the suite sends — `viewer`, `repository`, `node`, `__type` introspection, cursor-paged `issues`/`pullRequests`, and the `createIssue` / `closeIssue` / `createPullRequest` / `mergePullRequest` / `addComment` mutations. |
| `mcp.ts` | MCP over JSON-RPC 2.0 Streamable HTTP: `server/discover`, `initialize`, `tools/list` and `tools/call` for `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`. |
| `http.ts` | Shared HTTP plumbing: request/response shapes, JSON helpers, bearer auth against `MAKEFUN_SHOP_TOKEN`. |

## Verification

Against the kit's local runner (`sdk/run.ts`) the forge passes **120/120
checks** (git 30, repos 15, issues 15, pulls 20, protocol 5, GraphQL 20,
MCP 15) with **perf 142/200** — feature 600 + agent 200 + perf 142 =
**942/1000**. A real `git` client (2.43) was also tested by hand: v2 and v0
clones, pushes, incremental fetches (including multi-round negotiation over
a 50-commit history) and fetches with nothing new all round-trip
byte-exactly.

The token holder is treated as the scenario viewer `adaiversen`; every
reply carries a non-empty `X-GitHub-Request-Id`; all stored timestamps are
fixed (2025-01-01), so repeated runs on the same instance export identical
state.
