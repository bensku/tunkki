interface FirewallRuleBase {
    port: number | 'any';
    proto?: 'tcp' | 'udp' | 'icmp' | 'any';
    localCidr?: string;
}

interface FirewallGroupsRule extends FirewallRuleBase {
    group: string;
    host?: never;
    cidr?: never;
}

interface FirewallHostRule extends FirewallRuleBase {
    host: string | 'any';
    group?: never;
    cidr?: never;
}

interface FirewallCidrRule extends FirewallRuleBase {
    cidr: string;
    host?: never;
    group?: never;
}

export type FirewallRule = FirewallGroupsRule | FirewallHostRule | FirewallCidrRule;

/**
 * Firewall declarations is close-to-Nebula format.
 */
export interface NebulaFirewall {
    outbound: FirewallRule[];
    inbound: FirewallRule[];
}

/**
 * Firewall declarations in a simpler format that merges outbound and inbound.
 */
export type SimpleFirewall = [
    'in' | 'out', // Direction
    number | 'any', // Port or any to allow all ports
    string | 'any', // Group to allow or any for all groups
][];

export type Firewall = NebulaFirewall | SimpleFirewall;

export function formatFirewallRule(rule: FirewallRule) {
    return {
        port: rule.port,
        proto: rule.proto ?? 'any',
        group: rule.group,
        host: rule.host,
        local_cidr: rule.localCidr,
        cidr: rule.cidr,
    };
}
