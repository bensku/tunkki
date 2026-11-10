# Deployment pipeline
Here, 'local' means the tunkki CLI running on machine doing the deployment.
Hosts that are deployed to run 'remote's: the tunkki agent at
`/opt/tunkki/tunkki`.

Remotes are thin. They store state and execute steps they are told to. Local
does all planning, ordering and comparison.

## Connect
Local connects to the agent on every host. If a human might be at the
terminal, it connects to one host at a time, so that it is clear which host
e.g. a security key touch is for.

Connectors may report when they have authenticated. Authentication may need
the user, so it has no timeout. The `ssh` connector learns of it from a line
that the remote shell prints to stderr before starting the agent. It also
points `SSH_ASKPASS` to a helper that reports requests to touch a security key,
since OpenSSH only prints them when stderr is a terminal. Other askpass
prompts go to the usual askpass program.

Once authenticated, the agent says `hello` with its protocol version, and
local refuses agents that have unsupported version. Local then sends
`settings`.

## Compute desired state
Local runs the deploy script's `on(...)` blocks for every host, imperatively
creating the declarative state we'll plan towards: tasks, their inputs and
their `deps`. Each rolling `on(...)` block also records which tasks it added
on each host, in host order.

Tasks can use outputs of other tasks (what their last step returned) through
fields of the task objects that task types return, e.g. `endpoint.ip`. Fields
the task type itself defines, such as `id`, take precedence over outputs with
same names. Output fields are proxies that turn into tokens like
`$tunkki{h1.endpoint/ip}` once all tasks are loaded. The task whose output is
used is added to `deps` automatically.

## Plan
Local asks every remote for the state of the stack. Each replies with its
state file, `/opt/tunkki/<stack>/state/current.json`, and its sha256 hash.
The state file maps task ids to records of the task type (`handler`), the
input it was last applied with (`state`), its `output` and its `deps`.

Local compares each task to its record:

- No record: **created**.
- Different task type: **replaced**. The old one is cleaned up with its old
  type, then the new one is applied.
- Different input, after substituting known outputs: **updated**. A token
  whose output isn't known yet also counts as a difference.
- Otherwise **unchanged**.

Records without a task are **deleted**.

When outputs of tasks are used as inputs into other tasks, tasks that need
no changes in reality may be marked as updated. This is unavoidable, but apply
phase will not rerun these unnecessarily.

Then local decides the order:

- A task runs after its `deps`.
- A deleted task is cleaned up after the tasks that used it, according to the
  stored `deps`, have finished. If a task that is kept used it, even through
  other tasks, the deleted task also waits for that.
- Other deleted tasks are cleaned up before anything is created, updated or
  replaced on the same host, so that e.g. a renamed task doesn't remove the
  file its new self just wrote. This may cause brief downtime if the user is
  careless with their deletes, but better than e.g. naming conflicts.
- In a rolling `on(...)` block, a host's tasks start once the previous host's
  tasks have finished. Hosts without tasks in the block are skipped.

Dependency cycles, including ones through rolling blocks, fail the plan. So do
task types without a registered handler.

The plan can be shown to the user, saved with `plan --plan-file=foo.plan` and
applied later with `apply --plan-file=foo.plan`, even from another process.
Plan files contain stored state, so they are only readable by their owner.
They must be applied by the same Bun version and the same deploy script.

## Apply
Local opens an apply session on every remote, giving the state hash that it
planned against. If any host's state has changed since, nothing is applied.
Local then bundles the task handlers each host needs and sends them as data
URLs. Remotes import them from memory and never store them.

Tasks start when the plan's ordering allows. If a task fails, the tasks that
wait for it are skipped. For each task, local:

1. Cleans up the old task if it was deleted or replaced.
2. Substitutes outputs, preferring those produced during this apply. An output
   that is still unknown fails the task.
3. Skips the task if its input is still the same as stored. It is applied
   anyway if the plan is from `--reapply`, or if it sets `reapplyOnDepChange`
   and one of its `deps` was actually applied. Combined tasks pass this on
   through their `-end` task.
4. Runs the steps: local ones itself, remote ones by asking the remote. Each
   step gets the previous step's return value. Only the last step may return
   nothing.
5. Asks the remote to commit the task's record. A failed task is not committed,
   so it is retried on the next apply.

Finally, local commits refreshed records and closes the sessions. Remotes
report commits that failed when closing.

Concurrent applies to the same stack are currently not prevented,
since Bun has poor native support for file locking.
