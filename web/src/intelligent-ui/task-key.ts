/**
 * Core's key rules (T-56, core/src/task_keys.rs), in one place for the
 * contracts, the Jobs form and the Project key editor. Only the canonical
 * uppercase form is a key; Core refuses any other.
 */

/** A task's key: `T-<n>`, the global number every task keeps, or a Project's
 * key and the task's number there, such as `YN-3`. */
export const TASK_KEY = /^(?:T|[A-Z][A-Z0-9]{1,9})-[1-9][0-9]{0,9}$/;

/** A Project's key: an uppercase letter, then 1–9 uppercase letters or
 * digits. `T` alone is never one, so `T-<n>` always means the global number. */
export const PROJECT_KEY = /^[A-Z][A-Z0-9]{1,9}$/;
