/**
 * The catalogue sync: fetch the feed, write MySQL, rebuild the Elasticsearch indexes.
 *
 * This used to be the body of scripts/seed.ts. It is a service now because it has three callers
 * that must not drift — the cron, `POST /sync`, and the seed script — and a job whose behaviour
 * depends on which entry point invoked it is a job nobody can reason about. The `trigger` field
 * on the run row is the only thing that differs between them.
 *
 * Both stores are written by one function on purpose: populating MySQL and indexing
 * Elasticsearch separately is how you end up with a search index describing a catalogue that no
 * longer exists.
 *
 * Idempotent — safe to run repeatedly. Products upsert on their source id; each product's child
 * rows (images, tags, reviews) are replaced wholesale, because the source gives them no stable
 * ids of their own to match on.
 */

import {
  describeSchemaError, fetchCategories, fetchProducts,
  type SourceCategory, type SourceProduct,
} from '../clients/catalogFeed.client.js';
import { config } from '../config/env.js';
import { withTransaction } from '../config/database.js';
import type { Category } from '../models/common.types.js';
import {
  emptyCounts, type SyncRun, type SyncRunCounts, type SyncTrigger,
} from '../models/db/syncRun.model.js';
import { toCategoryDocument } from '../models/es/category.document.js';
import { toSearchDocument } from '../models/es/product.document.js';
import * as categoryRepository from '../repositories/db/category.repository.js';
import * as productRepository from '../repositories/db/product.repository.js';
import * as syncRunRepository from '../repositories/db/syncRun.repository.js';
import * as tagRepository from '../repositories/db/tag.repository.js';
import * as categorySearchRepository from '../repositories/es/category.repository.js';
import * as productSearchRepository from '../repositories/es/product.repository.js';
import { conflict, errorMessage } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('sync');

export interface SyncOptions {
  trigger: SyncTrigger;
  /** Run even when both stores already hold data. Defaults to SEED_FORCE. */
  force?: boolean;
}

/**
 * The in-flight guard.
 *
 * A module-level flag, which is exactly as far as it goes: it stops the cron firing on top of a
 * manual trigger *in this process*, and it would not stop two replicas syncing at once. That
 * needs a lock in MySQL, and this app runs one container. Said out loud here because the failure
 * mode — two runs rebuilding the same index — is quiet and expensive.
 */
let inFlight: Promise<SyncRun> | null = null;

export const isSyncRunning = (): boolean => inFlight !== null;

/** Whether a sync could start right now — the cheap check the API makes before opening a row. */
function assertNotRunning(): void {
  if (inFlight) throw conflict('A catalogue sync is already running. Wait for it to finish.');
}

/** Open the row and set the work going. Throws 409 rather than opening a second one. */
async function begin(options: SyncOptions): Promise<{ run: SyncRun; done: Promise<SyncRun> }> {
  assertNotRunning();
  const run = await syncRunRepository.startRun(options.trigger);
  const done = execute(run, options).finally(() => { inFlight = null; });
  inFlight = done;
  return { run, done };
}

/**
 * Start a sync and wait for it. What the cron and the script use.
 *
 * Never throws for a failed *sync*: a run that dies is recorded on its row and returned with
 * `status: 'failed'`, because every caller wants the record rather than an exception — the cron
 * would otherwise take the process down, and the script needs the counts to report. It does
 * throw for a refused *start* (409), which is a different thing and not a run at all.
 */
export async function runSync(options: SyncOptions): Promise<SyncRun> {
  const { done } = await begin(options);
  return done;
}

/**
 * Start a sync and return its row immediately, without waiting.
 *
 * What `POST /sync` uses: a full rebuild outlives a sensible request timeout, so the caller gets
 * the run id back and polls `GET /sync/runs/:id` for the progress the row is accumulating.
 */
export async function startSync(options: SyncOptions): Promise<SyncRun> {
  const { run, done } = await begin(options);
  // The rejection is impossible — `execute` records failures rather than throwing — but an
  // unobserved promise would still crash the process if that ever stopped being true.
  done.catch((err: unknown) => { log.error(`sync ${run.id} threw: ${describeSchemaError(err)}`); });
  return run;
}

async function execute(run: SyncRun, { force }: SyncOptions): Promise<SyncRun> {
  const counts = emptyCounts();
  const shouldForce = force ?? config.sync.force;

  try {
    if (!shouldForce) {
      await syncRunRepository.recordProgress(run.id, { stage: 'checking' });
      const state = await currentState();
      // Every store must be populated to count as synced — otherwise a half-populated stack
      // (MySQL full, an index empty) would skip and serve an empty catalogue or an empty nav.
      if (state.productCount > 0 && state.indexedProducts > 0 && state.indexedCategories > 0) {
        log.info(`already populated (${state.productCount} in MySQL, ${state.indexedProducts} `
          + `products and ${state.indexedCategories} categories in Elasticsearch) — skipping`);
        return await close(run.id, 'skipped', 'done');
      }
      log.info(`incomplete state (mysql=${state.productCount}, es products=`
        + `${state.indexedProducts}, es categories=${state.indexedCategories}) — syncing`);
    }

    await syncRunRepository.recordProgress(run.id, { stage: 'fetching' });
    log.info(`fetching from ${config.sync.sourceUrl}`);
    const [products, sourceCategories] = await Promise.all([fetchProducts(), fetchCategories()]);
    counts.productsFetched = products.length;
    await syncRunRepository.recordProgress(run.id, { counts });
    log.info(`fetched ${products.length} products`);

    const categoryBySlug = buildCategoryMap(products, sourceCategories);

    await syncRunRepository.recordProgress(run.id, { stage: 'writing-mysql' });
    // All MySQL writes in one transaction: a half-applied sync would leave products referencing
    // categories that were rolled back.
    await withTransaction(async (conn) => {
      const categoryIds = await categoryRepository.upsertCategories(conn, categoryBySlug.values());
      const tagIds = await tagRepository.upsertTags(
        conn,
        products.flatMap((product) => product.tags ?? []),
      );
      counts.categoriesUpserted = categoryIds.size;
      counts.tagsUpserted = tagIds.size;
      log.info(`upserted ${categoryIds.size} categories, ${tagIds.size} tags`);

      for (const product of products) {
        await productRepository.upsertProduct(conn, product, categoryIds, tagIds);
      }
      counts.productsUpserted = products.length;
      log.info(`upserted ${products.length} products (+ images, tags, reviews)`);
    });
    await syncRunRepository.recordProgress(run.id, { counts });

    await syncRunRepository.recordProgress(run.id, { stage: 'indexing-products' });
    // Both indexes are rebuilt rather than updated in place: mappings are effectively immutable,
    // so a change to a definition only takes effect on a fresh index. Cheap at this size, and it
    // guarantees the running indexes match the definitions in the code.
    log.info('rebuilding Elasticsearch indexes');
    await Promise.all([
      productSearchRepository.ensureProductsIndex({ recreate: true }),
      categorySearchRepository.ensureCategoriesIndex({ recreate: true }),
    ]);

    for (let i = 0; i < products.length; i += config.sync.batchSize) {
      const batch = products.slice(i, i + config.sync.batchSize).map((product) => toSearchDocument({
        ...product,
        // The same map MySQL was populated from — see buildCategoryMap.
        category: (product.category ? categoryBySlug.get(product.category) : null) ?? null,
      }));
      counts.productsIndexed += await productSearchRepository.bulkIndexProducts(batch);
    }
    await syncRunRepository.recordProgress(run.id, { counts });
    log.info(`indexed ${counts.productsIndexed} products into '${config.elasticsearch.productsIndex}'`);

    await syncRunRepository.recordProgress(run.id, { stage: 'indexing-categories' });
    // Read back out of MySQL rather than counted from `products` in memory: the counts then come
    // from the same GROUP BY the table would answer with, so the two stores cannot disagree
    // about a number that a nav renders. It is also the only way the index learns about a
    // category holding no products — one that exists in the table but appears on no product.
    const categoryDocuments = (await categoryRepository.findCategories()).map(toCategoryDocument);
    counts.categoriesIndexed = await categorySearchRepository.bulkIndexCategories(categoryDocuments);
    await syncRunRepository.recordProgress(run.id, { counts });
    log.info(`indexed ${counts.categoriesIndexed} categories into '${config.elasticsearch.categoriesIndex}'`);

    return await close(run.id, 'succeeded', 'done', counts);
  } catch (err) {
    const message = describeSchemaError(err);
    log.error(`sync ${run.id} FAILED: ${message}`);
    // Recording the failure must not be able to fail in turn. A throw from here would escape
    // `execute` entirely and leave the row saying `running` forever — which is how a bad
    // duration_ms once turned a one-line SQL problem into a run that never closed.
    try {
      await syncRunRepository.recordProgress(run.id, { counts });
      return await close(run.id, 'failed', await stageOf(run.id), counts, message);
    } catch (bookkeeping: unknown) {
      log.error(`sync ${run.id} could not record its own failure: ${errorMessage(bookkeeping)}`);
      // The in-memory truth, so the caller still gets a run it can report on. The row is left for
      // failStaleRuns to close at the next boot.
      return { ...run, status: 'failed', counts, error: message };
    }
  }
}

/** Close the row and hand back what it now says, so callers report the stored truth. */
async function close(
  id: number,
  status: 'succeeded' | 'skipped' | 'failed',
  stage: SyncRun['stage'],
  counts?: SyncRunCounts,
  error?: string,
): Promise<SyncRun> {
  if (counts) await syncRunRepository.recordProgress(id, { counts });
  await syncRunRepository.finishRun(id, { status, stage, ...(error ? { error } : {}) });
  const run = await syncRunRepository.findRunById(id);
  if (!run) throw new Error(`sync run ${id} vanished while it was being closed`);
  return run;
}

/** The stage a row is currently sitting at — read back so a failure keeps where it got to. */
async function stageOf(id: number): Promise<SyncRun['stage']> {
  const run = await syncRunRepository.findRunById(id);
  return run?.stage ?? 'starting';
}

interface StoreState {
  productCount: number;
  indexedProducts: number;
  indexedCategories: number;
}

async function currentState(): Promise<StoreState> {
  const [productCount, indexedProducts, indexedCategories] = await Promise.all([
    productRepository.countProducts(),
    productSearchRepository.countIndexedProducts(),
    categorySearchRepository.countIndexedCategories(),
  ]);
  return { productCount, indexedProducts, indexedCategories };
}

const titleCase = (slug: string): string => slug
  .split('-')
  .map((word) => (word ? word[0]!.toUpperCase() + word.slice(1) : word))
  .join(' ');

/**
 * The canonical slug -> {slug, name, url} map, built once and used for BOTH stores, so the
 * category name in Elasticsearch is the same string as the one in MySQL. Deriving it separately
 * on each side is how a filter starts matching in one store and not the other.
 */
function buildCategoryMap(
  products: SourceProduct[],
  sourceCategories: SourceCategory[] | null,
): Map<string, Category> {
  const bySlug = new Map<string, Category>();
  for (const category of sourceCategories ?? []) {
    bySlug.set(category.slug, {
      slug: category.slug,
      name: category.name ?? titleCase(category.slug),
      url: category.url ?? null,
    });
  }
  // A category a product references but the endpoint didn't list still needs a row, or the
  // product's foreign key drops to NULL and it vanishes from category filters.
  for (const product of products) {
    if (product.category && !bySlug.has(product.category)) {
      bySlug.set(product.category, {
        slug: product.category,
        name: titleCase(product.category),
        url: null,
      });
    }
  }
  return bySlug;
}

/** Recent runs, newest first — optionally just one day's. */
export async function listRuns(options: syncRunRepository.ListRunsOptions): Promise<SyncRun[]> {
  return syncRunRepository.listRuns(options);
}

export async function getRun(id: number): Promise<SyncRun | null> {
  return syncRunRepository.findRunById(id);
}

export async function getLastSuccessfulRun(): Promise<SyncRun | null> {
  return syncRunRepository.findLastSuccessfulRun();
}
