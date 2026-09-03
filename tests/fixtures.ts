/**
 * pytest-style fixtures for `node:test`.
 *
 * `node:test` gives you `before`/`beforeEach` hooks and nothing else — no way to say "this test
 * needs a seeded catalogue" and have it appear. That gap is what this file closes. A fixture is
 * declared once with a factory, requested by calling it, and resolved lazily: a test file that
 * never asks for the catalogue never fetches one.
 *
 * What carries over from pytest:
 *
 *   - **Lazy resolution.** The factory runs on first request, not at import.
 *   - **Caching by scope.** A `session` fixture is built once and shared; a `function` fixture is
 *     rebuilt for every test that asks.
 *   - **Finalizers.** `ctx.addFinalizer(fn)` is pytest's code-after-`yield`, run in reverse order
 *     of registration so teardown unwinds the way setup wound up.
 *   - **Dependency between fixtures.** A factory receives `ctx.use(other)` and can build on it.
 *
 * What does not, and why: `node:test` runs each *file* in its own process, so `session` scope
 * means "once per file", not once per suite. That is closer to pytest's `module` scope, and it is
 * the reason a fixture must be cheap enough to build per file — or idempotent, like `stack`.
 */

import { after, afterEach } from 'node:test';

export type Finalizer = () => void | Promise<void>;

/** What a factory is handed: teardown registration, and access to other fixtures. */
export interface FixtureContext {
  addFinalizer(fn: Finalizer): void;
  use<U>(other: Fixture<U>): Promise<U>;
}

export interface Fixture<T> {
  (): Promise<T>;
  readonly fixtureName: string;
  /** Drop the cached value and run its finalizers — mostly for a test that needs a clean one. */
  reset(): Promise<void>;
}

export type Scope = 'session' | 'function';

interface Entry {
  value: Promise<unknown>;
  finalizers: Finalizer[];
}

const sessionEntries = new Map<string, Entry>();
const functionFinalizers: Finalizer[] = [];
const declared = new Set<string>();

/**
 * Declare a fixture.
 *
 * The name is required and must be unique — it is what a failure blames. A factory that throws
 * reports as "fixture 'catalogue' failed: …" rather than as a bare assertion from whichever test
 * happened to ask first.
 */
export function fixture<T>(
  fixtureName: string,
  factory: (ctx: FixtureContext) => Promise<T> | T,
  { scope = 'session' }: { scope?: Scope } = {},
): Fixture<T> {
  if (declared.has(fixtureName)) {
    throw new Error(`Duplicate fixture '${fixtureName}' — names must be unique.`);
  }
  declared.add(fixtureName);

  const build = async (finalizers: Finalizer[]): Promise<T> => {
    const ctx: FixtureContext = {
      addFinalizer: (fn) => { finalizers.push(fn); },
      use: (other) => other(),
    };
    try {
      return await factory(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`fixture '${fixtureName}' failed: ${message}`, { cause: err });
    }
  };

  const resolve = async (): Promise<T> => {
    if (scope === 'function') return build(functionFinalizers);

    const cached = sessionEntries.get(fixtureName);
    // The promise is cached, not the value: two tests asking at once must not both run the
    // factory, which for `stack` would mean two readiness probes and for a data-creating
    // fixture would mean two rows.
    if (cached) return cached.value as Promise<T>;

    const finalizers: Finalizer[] = [];
    const value = build(finalizers);
    sessionEntries.set(fixtureName, { value, finalizers });
    return value;
  };

  const use = resolve as Fixture<T>;
  return Object.assign(use, {
    fixtureName,
    async reset(): Promise<void> {
      const entry = sessionEntries.get(fixtureName);
      if (!entry) return;
      sessionEntries.delete(fixtureName);
      await runFinalizers(entry.finalizers);
    },
  });
}

/**
 * A fixture that hands back a builder rather than a value — pytest's factory-as-fixture.
 *
 * Function-scoped by definition: the point is that each test makes its own objects, and anything
 * the builder registers is cleaned up after that test.
 */
export function factoryFixture<Builder extends (...args: never[]) => unknown>(
  fixtureName: string,
  make: (ctx: FixtureContext) => Builder,
): Fixture<Builder> {
  // The builder's own signature is preserved rather than widened to `T | Promise<T>`: a
  // synchronous builder should not force every call site to await a string.
  return fixture(fixtureName, (ctx) => make(ctx), { scope: 'function' });
}

/** Reverse order, and one failure does not skip the rest — a leaked resource is worse. */
async function runFinalizers(finalizers: Finalizer[]): Promise<void> {
  const problems: unknown[] = [];
  for (const finalize of [...finalizers].reverse()) {
    try {
      await finalize();
    } catch (err) {
      problems.push(err);
    }
  }
  finalizers.length = 0;
  if (problems.length > 0) {
    throw new AggregateError(problems, `${problems.length} fixture finalizer(s) failed`);
  }
}

/** Tear down every `function`-scoped fixture. Wired to `afterEach` by `registerFixtureHooks`. */
export async function teardownFunctionScope(): Promise<void> {
  await runFinalizers(functionFinalizers);
}

/** Tear down every `session`-scoped fixture. Wired to `after`. */
export async function teardownSessionScope(): Promise<void> {
  const entries = [...sessionEntries.values()];
  sessionEntries.clear();
  const problems: unknown[] = [];
  for (const entry of entries.reverse()) {
    try {
      await runFinalizers(entry.finalizers);
    } catch (err) {
      problems.push(err);
    }
  }
  if (problems.length > 0) throw new AggregateError(problems, 'session teardown failed');
}

/**
 * Install the teardown hooks in the calling test file.
 *
 * conftest.ts calls this at import, so any file importing a fixture gets cleanup automatically —
 * the same bargain `conftest.py` makes, and the reason no test has to remember it.
 */
export function registerFixtureHooks(): void {
  afterEach(teardownFunctionScope);
  after(teardownSessionScope);
}
