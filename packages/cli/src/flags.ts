/**
 * Valid values of the `--mode`/`--isolation` flags, derived from the
 * `@caesar/protocol` schemas rather than copied out literally: adding a
 * variant to the protocol (`TaskModeSchema`/`IsolationSchema`) propagates
 * here without a manual fix, which a pair of hand-copied arrays never
 * guaranteed (task 10, B2 — `role.ts` and `run.ts` each defined this very
 * pair until now, identically, on their own side).
 *
 * `"auto"` does not exist on the protocol side: it is a sentinel specific to
 * the delegation policy (`@caesar/core`, `config.ts`, `default_isolation`),
 * added here explicitly rather than derived.
 *
 * This *shape* validation (a raw string coming from `commander`) stays
 * deliberately specific to the CLI, never in `@caesar/core`: see the header
 * of `resolveDelegation` (`packages/core/src/delegation.ts`), whose inputs
 * are already typed when it is called.
 */
import { IsolationSchema, TaskModeSchema } from "@caesar/protocol";
import type { Isolation, TaskMode } from "@caesar/protocol";
import { NETWORK_REQUESTS } from "@caesar/core";
import type { NetworkRequest } from "@caesar/core";

export const TASK_MODES: readonly TaskMode[] = TaskModeSchema.options;
export const ISOLATIONS: readonly (Isolation | "auto")[] = [...IsolationSchema.options, "auto"];

/**
 * `--network`. Like `"auto"` for isolation, these three values do not exist
 * on the protocol side: the `Task` only carries a resolved boolean. They
 * live in `@caesar/core` (`network.ts`), from which they are derived here.
 */
export const NETWORK_REQUEST_VALUES: readonly NetworkRequest[] = NETWORK_REQUESTS;
