# Plan/apply rework: implementation plan

Status: agreed design, not yet implemented. Delete this file once the rework
lands; `docs/deploy.md` is the lasting description.

Baseline on `next` at 4c961bc: `tsc --noEmit` reports 138 errors and the branch
cannot deploy. All 101 unit tests pass because `bun test` does not typecheck.

## Goals

- `bun stack.ts plan --plan-file=foo.plan`, then later
  `bun stack.ts apply --plan-file=foo.plan`, from separate processes.
- Remotes are thin: they hold state and execute steps. Local owns planning,
  ordering and comparison.
- Handlers are bundled, sent as base64 URLs and never written to disk.
- Task outputs can be used as inputs, including across hosts.
- Live stacks keep working, and rolling back to the old version stays possible.

## Decisions made while writing this plan

These were not discussed explicitly. Veto any of them before phase 1.

1. **`CloseSession` is acknowledged.** Local waits for `SessionClosed` so that
   `Commit`s are flushed before the connection closes. Failed commits are
   reported there.
2. **One stale host aborts the whole apply.** All sessions open first, and
   nothing runs unless every host accepts its state hash.
3. **`apply --plan-file` does not prompt.** The plan was approved in CI. It also
   rejects `--target` and `--reapply`, since the plan already fixes those.
4. **Plans separate `updated` from `maybe`.** `updated` means the input differs.
   `maybe` means only the cascade reached the task. `printPlan` shows them
   differently, so a cascade doesn't look like a definite change.
5. **Metadata-only commits.** Unchanged tasks whose stored `deps` differ are
   rewritten without running anything. This backfills `deps` on live stacks at
   the first apply, so odd deletes last only as long as necessary.
6. **Hidden work runs without a prompt.** Metadata commits and `$noop` deletes
   don't count as changes for "No changes" or confirmation, but they still run.
7. **`Node.replacements` goes away.** Tokens contain the task id and path, so
   they can be parsed directly. `substituteState` is local-only, not in
   `common/`, now that remotes receive resolved state.
8. **`fatal` stays removed.** Plan failures use `PlanResult.error`, session
   failures use `Ready.error` or `Done`, and anything else is logged on the host
   and surfaces as a closed connection.

## Task code

Leave `task/` handlers and helpers alone unless the rework cannot work without
the change. The only planned changes outside `task/index.ts` are the option
renames in `task/nebula/index.ts` and `task/podman/index.ts`.

## State format

Path stays `/opt/tunkki/<stack>/state/current.json`. `remote/session.ts:24`
currently points one directory too high.

```ts
type StateFile = Record<string, TaskRecord>;

interface TaskRecord {
    handler: string;  // Task type
    state: unknown;   // Resolved input
    output?: unknown; // Last step's return value
    deps?: string[];
}
```

Rules that protect rollback:

- No top-level keys other than task ids. The old runner treats each one as a
  task and queues it for deletion.
- `state` stays complete; `content` is not stripped.
- All new data lives in `current.json`.
- Task ids do not change, except rolling `-end` tasks, which become deletes.

`stateHash` is the sha256 of the raw file bytes, or of nothing if it's missing.

## Protocol

`CURRENT_PROTOCOL` stays 1. Local rejects a mismatched `Hello` and tells the
user to run `install-agent`.

| Event | Direction | Fields |
|---|---|---|
| `hello` | remote to local | `protocol` |
| `settings` | local to remote | `logLevel` |
| `plan` | local to remote | `stack` |
| `planResult` | remote to local | `stack`, `tasks`, `stateHash`, `error?` |
| `openSession` | local to remote | `session`, `stack`, `concurrency`, `stateHash` |
| `loadHandlers` | local to remote | `session`, `handlers` |
| `ready` | remote to local | `session`, `error?`; one reply each to the two above |
| `run` | local to remote | `session`, `task`, `id`, `step`, `state` |
| `done` | remote to local | `session`, `id`, `status`, `output` |
| `commit` | local to remote | `session`, `id`, `record` |
| `closeSession` | local to remote | `session` |
| `sessionClosed` | remote to local | `session`, `error?` |

`StepStatus` on the wire is `started | done | error`. `unchanged` and `skipped`
exist only on local. `Run.replacements` and `Run.force` are removed.

`Run` with `state: undefined` means cleanup. That's unambiguous because a step
with a following step must not return `undefined`. Last steps may, and most
in-tree ones do. Local fails the task if a non-final step returns `undefined`,
so a broken handler can't trigger a cleanup by accident.

## Plan structure

```ts
interface Plan {
    version: 1;
    stack: string;
    mode: 'apply' | 'reapply' | 'destroy';
    hosts: Record<string, { stateHash: string }>;

    created: string[];
    updated: string[];  // Input differs
    maybe: string[];    // Reached only by the cascade
    replaced: string[]; // Handler changed: cleanup old, then apply new
    deleted: string[];
    unchanged: string[];
    refresh: string[];  // Metadata-only commits

    old: Record<string, TaskRecord>; // Merged from all hosts
    nodes: Record<string, Node>;     // Includes deleted tasks
    barriers: Barrier[];
}

interface Node {
    task: PlannedTask; // id, host, type, state, deps, reapplyOnDepChange
    after: string[];   // Scheduler edges, including delete ordering
    dependents: string[];
}

// `then` starts once every task in `wait` has resolved.
// Failure in `wait` skips `then`.
interface Barrier {
    wait: string[];
    then: string[];
}
```

The plan file is a one-line JSON header (`version`, `bunVersion`, `stack`)
followed by the `bun:jsc`-serialized plan. The header lets a Bun mismatch give a
clear error. It's written with mode `0600`, since it holds old task state.

## Phase 1: protocol and remote

- Rewrite `common/event.ts` to the table above.
- `remote/state.ts`: records, `commit`, `delete`, `hash`. Remove `$out`.
- `remote/runner.ts`: replace `Runner` with a small dispatcher that sends
  `hello` on startup and handles `settings` and `plan`. It routes apply events
  by `session` to a map of sessions.
- `remote/session.ts`: `run` must not be awaited by the read loop, or the
  concurrency limit does nothing. Check the hash in `newSession`. Replace input
  and output saving in `applyTask` with `commit`. Reply exactly once per step,
  which fixes the double `done` after errors. For `$noop` cleanup, drop the
  record without loading a handler.
- `remote/index.ts`: remove `Bun.plugin` and the `fatal` send.
- Delete `remote/plan.ts`.
- Pass `reply` and the state dir into the session so tests can drive it.

Verify: unit tests for state against an old-format fixture, hash behaviour,
stale `openSession`, step and cleanup flows, one reply per step.

## Phase 2: task model and builder

- `task/index.ts`: `TaskOptions` becomes `deps` and `reapplyOnDepChange`.
  `after`, `onChanged` and `dependsOn` are removed. `combine`'s `-end` task gets
  the flag.
- `local/task.ts`: drop `localData` from `Task`. The runner builds `{ host }`
  when calling a step, so handler signatures don't change.
- `local/builder.ts`: sources return the task ids they added. A rolling `on()`
  records a block of per-host id groups, skipping hosts with no tasks, which
  fixes the existing `prev` reset. `on()` stops adding `-end` tasks.
- Outputs: `taskType<S, O, R>` adds `.outputs`, a typed proxy.
  `Symbol.toPrimitive` and `toJSON` give `$tunkki{<id>/<path>}`, with both parts
  URI-encoded. At the end of `loadTasks`, after all sources and before
  `validateTasks`, the builder replaces proxies with tokens and adds each
  referenced task to `deps`.
- `local/validate.ts`: check `deps` and references, including self-references.
- Rename options in `task/nebula/index.ts`, `task/podman/index.ts` and test
  fixtures, nothing else. `netavarkSetup` keeps its restart by setting the flag
  on its service.

Verify: builder tests for ids, blocks with gaps, tokens in template strings,
proxy stringifying after `connectNebula`-style mutation.

## Phase 3: planning

- New `local/outputs.ts`: `substituteState(state, lookup)`. A whole-value token
  keeps its type; an embedded token stringifies primitives and errors on
  objects. It reports unresolved tokens rather than leaving them silently.
- `diffTasks` in `local/plan.ts`, per task:
  - no old record: `created`
  - different `handler`: `replaced`
  - different resolved input: `updated`
  - unresolved token: `updated`
  - otherwise `unchanged`
- Compare inputs after `JSON.parse(JSON.stringify(...))`, so `Uint8Array` content
  matches what's stored.
- **Live-state rule:** if a task references an output of an otherwise unchanged
  task whose record has no `output`, that task becomes `updated`. Old records
  have no outputs, and without this the consumer would fail at apply.
- Cascade from `created`, `updated` and `replaced` through `dependents`. Results
  that aren't already definite go to `maybe`.
- Fix `dependents.add(id)` and the missing spreads noted in the current
  `plan()`.
- Deletes, using old `deps`:
  - Anything whose old `deps` include X finishes before X is cleaned up.
  - A delete with a kept task among its transitive old dependents waits for it.
  - Other deletes on a host form a barrier before that host's creates, updates
    and replaces.
- Rolling blocks become barriers between consecutive hosts.
- Detect cycles across `after` and barriers. A rolling block can deadlock with a
  cross-host dep, so this has to include both. The current code claims to check
  cycles but doesn't.
- Fail if a needed handler isn't registered, listing ids. Exempt `$noop`.
- `reapply` marks every task `updated`. `destroy` diffs against no tasks.
- `writePlan` and `readPlan`.

Verify: table-driven unit tests with fake `PlanResult`s, including an
old-format fixture with rolling `-end` records.

## Phase 4: scheduling and apply

- `local/scheduler.ts`: driven by `Plan`. Run set is everything except
  `unchanged`. `done` and `unchanged` release dependents; `error` and `skipped`
  cascade skip. Barriers apply on top. Each scheduled task reports whether any
  direct dep finished `done`.
- New `local/apply.ts`, replacing `local/runner.ts` and `TargetPool.execute`:
  1. Open sessions on all hosts, abort all on any stale hash.
  2. Bundle per-host handlers with `Bun.build` and send `loadHandlers`.
  3. For each ready task, in order:
     - If `deleted` or `replaced`, first send `run` with `state: undefined` and
       the old handler.
     - Resolve tokens from this run's outputs, then `plan.old`. An unresolved
       token fails the task.
     - Mark it `unchanged` with no RPC if the input matches, unless it's
       `reapply` or the flag is set and a direct dep finished `done`.
     - Otherwise run steps. Step 0's `oldState` comes from `plan.old`.
     - `$noop` tasks have no steps and go straight to `commit`.
  4. After the last step, send `commit`.
  5. Send `refresh` commits, close sessions, wait for `sessionClosed`.
- `local/task.ts`: `bundleHandlers`, cached per type. Remove the `$delete` hack.
  Bundles are made at apply and are never stored in the plan file. That's safe
  because plan and apply use the same code, and `taskType()` registers handlers
  at import, so `apply --plan-file` has them without running `loadTasks`.

Verify: unit tests with fake connections for no-RPC `unchanged`, flag
behaviour, flag passing through `combine`, barrier failure, replace order,
failed step not committed, `undefined` from a non-final step fails the task.
Bundling was tested manually on four real handlers
in a compiled binary, including `nebula.endpoint` (34 KB).

## Phase 5: CLI and public API

- `index.ts`: `connect()` handles `hello` and `settings` and no longer loads
  tasks. `TargetPool.plan(stack, mode)` loads tasks and returns one `Plan`.
  `TargetPool.execute(plan, callback)` accepts a fresh or loaded plan.
- `parse.ts`, `help.ts`: `--plan-file` on `plan` and `apply`.
- `plan`: write the file if given.
- `apply`: with `--plan-file`, skip planning and `loadTasks`, look up hosts by
  id, and fail clearly on a missing host or wrong stack.
- `destroy`: same pipeline with `mode: 'destroy'`.
- `output.ts`: `printPlan` renders from `Plan` alone, with resolved values where
  known and the `maybe` category. `noopIds` comes from records and tasks, so
  deleted `$noop`s are hidden.
- `tasks.ts`: show `deps`.

Verify: `tsc --noEmit` has no errors outside `test/e2e`, parser unit tests pass.

## Phase 6: tests

Rewrite unit tests alongside each phase. `command-render`, `podman-helpers` and
`systemd-serialize` should need little change.

Delete `test/e2e`, keeping useful helpers from `helpers.ts`. Keep `test/host.ts`
and the Lima setup. Write new scenarios from this design:

- Lifecycle: create, no-op, update, delete, destroy.
- Plan file across two processes; stale hash; missing host.
- Rolling: order, failure halts the block, hosts with no tasks in the block,
  change on host 1 doesn't appear on host 2, unchanged tasks send no `run`.
- Delete order, rename with same remote path, type change.
- `reapplyOnDepChange`, directly and through `combine`.
- Outputs: same host, across hosts, embedded in a string, unresolved. No in-tree
  task type exposes outputs yet, so these use a task type defined in the tests.
- Failed multi-step task retries on the next run.
- Nebula, for its remote, local, remote step order.

Run once by hand against a real stack, using an agent built from 31b08fd, the
last commit before the rework:

1. Deploy with the old version.
2. Upgrade. The first plan shows no visible changes; `-end` records are removed.
3. Apply, confirm `deps` are backfilled.
4. Roll back. The old version works from the same state file.

## Phase 7: docs

Update `docs/deploy.md`, including apply-time decisions and the plan-file flow.
Delete this file.

## Accepted limitations

- Concurrent applies to one stack are not locked. The hash only catches an apply
  that finished before the session opened. Don't add a lock: `flock` isn't in
  Bun or `node:fs`, `bun:ffi` is experimental, and musl hosts may be needed.
- A failed dependent's forced reapply isn't retried; use `--reapply`.
- Deletes in rolling blocks are not rolled.
- Renames cause brief downtime, because cleanup runs first.
- Code changes between plan and apply are unsupported. The same goes for local
  inputs read at apply: if a `files.put` local file or `podman.secret` env value
  changes after plan, the new value is deployed under the planned checksum or
  hash, and the next plan won't notice.
- After a rollback, removing a task whose type never ran on the old version
  fails until that type is deployed once with the old version.
