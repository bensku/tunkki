import type { Connection } from './connection';
import type { Task } from './task';

export interface Plan {
    unchanged: string[];
    created: string[];
    updated: string[];
    deleted: string[];

    /**
     * Old inputs (state) for all tasks. Use these to visualize differences
     * between the current and desired state. DO NOT use this for actual apply
     * process!
     */
    oldInputs: Record<string, unknown>;

    /**
     * Old outputs of all tasks. If current output is not available, refer to
     * these when building replacements for Run events.
     */
    oldOutputs: Record<string, unknown>;
    
    /**
     * Nodes that describe the dependency graph, i.e. in which ORDER the above
     * changes to this plan should be applied.
     */
    nodes: NodeMap;
}

/**
 * Connects to given remotes and plans how the given tasks would be applied
 * to them. No changes on hosts are performed.
 * @param conns Connections to remotes.
 * @param tasks List of ALL tasks.
 * @returns A plan that can be shown to user and applied on hosts.
 */
export async function plan(conns: Connection[], tasks: Task[]): Promise<Plan> {
    // Build a DAG of dependencies, erroring on cycles, between tasks
    const nodes = buildDepGraph(tasks);

    // Ask remotes which tasks are new or have changed inputs
    const results = await Promise.all(conns.map((conn) =>
        getChanges(
            conn,
            tasks.filter((task) => task.host === conn.host.id),
        ),
    ));
    const changed = results.flatMap(res => res.changeSet.changed);
    const created = results.flatMap(res => res.changeSet.created);
    const deleted = results.flatMap(res => res.changeSet.deleted);
    // Record old states. Applying the plan will might need them for input values
    const oldInputs: Record<string, unknown> = {};
    const oldOutputs: Record<string, unknown> = {};
    for (const res of results) {
        Object.assign(oldInputs, res.oldInputs);
        Object.assign(oldOutputs, res.oldOutputs);
    }

    // Figure out what ELSE changes might've cascaded to due to explicit dependencies, inputs-as-outputs, etc.
    const maybeChanged = new Set<string>();
    const markChanged = (id: string) => {
        if (maybeChanged.has(id)) {
            return; // Already marked as changed
        }
        maybeChanged.add(id);

        // Recursively mark dependents as changed
        const node = nodes[id];
        if (!node) {
            throw new Error(); // Shouldn't ever happen, we check for this in buildDepGraph(...)!
        }
        for (const dep of node.dependents) {
            markChanged(dep);
        }
    }
    for (const id of changed) {
        markChanged(id);
    }
    
    // Construct executable (and viewable) plan
    const allChanged = new Set([...maybeChanged, created, deleted]);
    const unchanged = tasks.map(task => task.id).filter(id => !allChanged.has(id));

    return {
        unchanged,
        created,
        updated: [...maybeChanged],
        deleted,
        oldInputs,
        oldOutputs,
        nodes,
    }
}

interface Node {
    task: Task;

    /**
     * Tasks that must have executed before this node.
     */
    after: Set<string>;

    /**
     * Tasks that need this node to have executed before they can execute.
     */
    dependents: Set<string>;

    /**
     * Specs for building replacements if this task is sent tio apply.
     * 
     * Keys are string values that the remote will search for. Values are
     * PATHS in outputs record (path[0] is searched from outputs, then oldOutputs).
     */
    replacements: Record<string, string[]>;
}
type NodeMap = Record<string, Node>;
type TaskMap = Record<string, Task>;

function buildDepGraph(tasks: Task[]) {
    // Make nodes for tasks
    const nodes: NodeMap = {}
    for (const task of tasks) {
        nodes[task.id] = {
            task,
            after: getDependencies(task),
            dependents: new Set(),
            replacements: {},
        }
    }

    // Identify dependents (back-edges)
    for (const node of Object.values(nodes)) {
        for (const id of node.after) {
            const afterNode = nodes[id];
            if (!afterNode) {
                throw new Error(`task ${node.task.id} depends on nonexistent task ${afterNode}`);
            }
            afterNode.dependents.add(id);
        }
    }

    return nodes;
}

function getDependencies(task: Task): Set<string> {
    const deps = new Set(task.deps); // Explicit dependencies
    
    // Recursively search for references to tasks in inputs
    // While we're at it, build replacement templates too so we only need to recurse through state once
    const findReferences = (obj: unknown) => {
        // TODO
    }
    findReferences(task.state);
    
    return deps;
}

async function getChanges(conn: Connection, tasks: Task[]) {
    const taskMap: TaskMap = {};
    for (const task of tasks) {
        taskMap[task.id] = task;
    }

    // Request plan
    await conn.send({
        type: 'plan',
        incoming: taskMap,
    });
    // Wait for response
    const res = await conn.receiveOne();
    if (res.type !== 'planResult') {
        throw new Error(`plan failed, unexpected event ${res.type}`);
    }

    return res;
}

