export const ROOT_HELP = `Usage: tunkki-nebula <command> [flags]

Manage a Nebula network as a JSON file. Load it in your deploy script
with nebula.loadNetwork, which resolves CA paths relative to the JSON
file (cwd-agnostic):

    import { nebula } from '@bensku/tunkki/task/util';
    const network = await nebula.loadNetwork(
        import.meta.resolve('./network.json'),
    );
    nebula.endpoint('host-endpoint', { network, /* ... */ });

Commands:
  init <file>                Create a new network.json with a fresh signing CA
  new-ca <file>              Generate a new signing CA, keep the old one trusted
  distrust-ca <file> [sel]   Remove a CA from trustedCAs (cannot remove signingCA)
  lighthouse add <file> ...  Add a lighthouse (auto-allocates VPN IP by default)
  lighthouse remove <file>   Remove a lighthouse by VPN IP or underlay address
  static-ip <file>           Generate a random fixed IP outside dynamicIpArea

Global flags:
      --no-color    Disable ANSI colors even on a TTY
      --json        Emit a single JSON document instead of pretty output
  -h, --help        Show help for the command

Run "tunkki-nebula <command> --help" for command-specific flags.
`;

export const COMMAND_HELP: Record<string, string> = {
    init: `Usage: tunkki-nebula init <file> [flags]

Create a fresh network.json at <file>. The CA cert/key are written under
<file-dir>/cas/<ca-name>.{crt,key}.

Flags:
      --prefix <CIDR>          Network prefix (default: random ULA /48)
      --dynamic-area <CIDR>    Subprefix for auto-assigned endpoint IPs
                               (default: top half of --prefix)
      --ca-name <name>         CA file stem (default: signing-<YYYY-MM-DD>)
      --ca-duration <dur>      CA validity, nebula-cert format (default: 876000h)
`,
    'new-ca': `Usage: tunkki-nebula new-ca <file> [flags]

Generate a new signing CA inside <file-dir>/cas/. The previous signingCA
remains in trustedCAs so existing endpoints keep working until they are
re-signed on the next apply. Use distrust-ca afterwards to finish the
rotation.

Flags:
      --ca-name <name>         CA file stem (default: signing-<YYYY-MM-DD>)
      --ca-duration <dur>      CA validity, nebula-cert format (default: 876000h)
`,
    'distrust-ca': `Usage: tunkki-nebula distrust-ca <file> [selector] [flags]

Remove a CA from trustedCAs. The selector matches the CA's file stem
(e.g. "signing-2026-01-15") or its cert path as written in the JSON.
Refuses to remove the current signingCA.

The cert/key files are left on disk; clean them up manually once you are
sure they are no longer needed.

Flags:
      --name <name>            Match only against the CA's file stem
      --cert <path>            Match only against the CA's cert path
      --expired                Remove all expired CAs (skip selector)
      --all                    Allow removing multiple matching CAs
`,
    lighthouse: `Usage: tunkki-nebula lighthouse <add|remove> <file> ...

Subcommands:
  add <file> <underlayAddr> [--ip <addr>]
      Add a lighthouse. If --ip is omitted, allocates a random IP inside
      the network prefix but outside dynamicIpArea, avoiding collisions
      with existing lighthouses.

  remove <file> <selector> [--ip|--underlay] [--all]
      Remove a lighthouse. The selector matches against either vpnIp or
      underlayAddr; use --ip or --underlay to restrict the match.
`,
    'static-ip': `Usage: tunkki-nebula static-ip <file> [flags]

Generate one or more random fixed IPs inside the network prefix but
outside dynamicIpArea, avoiding collisions with existing lighthouses.
Useful for assigning static IPs by hand. The network file is not
modified.

Flags:
      --count <n>              Number of IPs to generate (default: 1)
`,
};
