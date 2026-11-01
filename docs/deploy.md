# Deployment pipeline
Here, 'local' means the tunkki CLI running on machine doing the deployment.
Hosts that are deployed to run 'remote's.

## Compute desired state
Local runs deploy functions, imperatively creating the declarative state we'll
plan towards. In other words: we figure out all tasks and their inputs.

## Remote plans
Local sends each remote its desired state: the tasks and their inputs.
Each remote compares this to state stored on its disk, then replies with
differences.

Once all remotes have replied, local has list of all created/deletes tasks
and *some* changed tasks. At this point, we do not yet know to how many
*other* tasks these changes cascade to.

## Cascade changes
Local builds a dependency graph/tree of all tasks.
Then, it marks dependents of changed tasks as changed recursively.
While doing so, local computes so-called *replacements* that are used to allow
outputs of tasks being used as inputs.

Once all (potential) changes are known, we have a plan! It can be presented
to user, serialized or, finally, applied.

## Apply changes
Local creates an apply session to all remotes, and begins sending changes as
directed by the plan. Remotes execute handlers concurrently, up to a configured
concurrent task limit. Dependencies are handled entirely on local side!
