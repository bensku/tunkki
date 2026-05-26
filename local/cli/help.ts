export const ROOT_HELP = `Usage: <script> <command> [flags]

Commands:
  plan              Show what would change on the targeted hosts
  apply             Plan, confirm, and execute changes on the hosts
  destroy           Plan and execute deletion of every task in the stack
  tasks             List the tasks registered for each host (no remote calls)
  install-agent     Upload the tunkki agent binary to each host

Global flags:
  -v, --verbose     Library log level: info (-v) or debug (-vv)
  -q, --quiet       Suppress non-essential output and library logs
      --no-color    Disable ANSI colors even on a TTY
      --json        Emit a single JSON document instead of pretty output
  -h, --help        Show help for the command

Run "<script> <command> --help" for command-specific flags.
`;

export const COMMAND_HELP: Record<string, string> = {
    plan: `Usage: <script> plan [flags]

Show the diff between the desired state (this script) and what each host
currently has on disk. Does not change anything.

Flags:
      --target <key=val>   Filter hosts by tag (repeatable, OR semantics)
      --stack <name>       Override the stack name passed to deploy()
      --reapply            Plan every task as changed, even if state matches
`,
    apply: `Usage: <script> apply [flags]

Plan the changes, prompt for confirmation, and execute on each host.

Flags:
      --target <key=val>   Filter hosts by tag (repeatable)
      --stack <name>       Override the stack name passed to deploy()
      --reapply            Re-run every task, even if state matches
  -y, --yes                Skip the confirmation prompt
`,
    destroy: `Usage: <script> destroy [flags]

Delete every task in the stack from each host. Tells the runner the stack is
empty, so the resulting plan is all-deletions.

Flags:
      --target <key=val>   Filter hosts by tag (repeatable)
      --stack <name>       Override the stack name passed to deploy()
  -y, --yes                Skip the confirmation prompt
`,
    tasks: `Usage: <script> tasks [flags]

List the tasks the script has registered for each host. Local-only; does not
talk to the agent.

Flags:
      --target <key=val>   Filter hosts by tag (repeatable)
      --host <id>          Sugar for --target host=<id>
`,
    'install-agent': `Usage: <script> install-agent [flags]

Upload the agent binary to /opt/tunkki/tunkki on each host using the
connector's upload transport.

Flags:
      --target <key=val>   Filter hosts by tag (repeatable)
`,
};
