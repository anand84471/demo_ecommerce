# Demo E-commerce API

A REST API over the [dummyjson.com](https://dummyjson.com/products) catalogue, built on
**TypeScript + Express**, with **MySQL** as the system of record and **Elasticsearch** as the
search read model. Requests are validated with **Zod**. Everything runs from one command.

---

## Running it

```bash
docker compose up
```

That's the whole setup. It builds the API image, starts MySQL and Elasticsearch, waits for both
to report *healthy*, seeds the catalogue into MySQL, indexes it into Elasticsearch, and serves on
**http://localhost:3000**.

First run takes a couple of minutes (image pulls + Elasticsearch boot). Afterwards it's seconds.

```bash
curl localhost:3000/health          # dependency status
curl localhost:3000/                # endpoint index
```

### Keeping the catalogue fresh

The sync — fetch the feed, write MySQL, rebuild both indexes — is one function in
`services/sync.service.ts` with three ways to reach it, so none of them can drift from the others:

```bash
docker compose exec api npm run seed        # once, from a shell
curl -X POST localhost:3000/sync            # on demand; 202 + a run id to poll
                                            # and 03:00 daily, from the in-process cron
```

Every run writes a row to `sync_runs` **as it goes**, not once at the end, so a run that dies
halfway says how far it got:

```bash
curl "localhost:3000/sync/runs?date=$(date -u +%F)"
```

```json
{ "id": 2, "trigger": "api", "status": "succeeded", "stage": "done", "durationMs": 1334,
  "counts": { "productsFetched": 194, "productsUpserted": 194, "productsIndexed": 194,
              "categoriesIndexed": 24 }, "error": null }
```

`status` distinguishes `succeeded` from `skipped` — a run that found both stores already
populated and did nothing. A week of `skipped` means the freshness check is wrong, which a week of
`succeeded` would hide. The cron is on inside compose and off in a bare `npm start`: a process
that calls a third-party feed on a timer should be asked for, not inherited.

### Endpoints

Every read is served by Elasticsearch. MySQL is the system of record behind the index — the store
a write would go to — and is never on a request path.

| Endpoint | Notes |
|---|---|
| `GET /categories` | All categories with product counts. Takes no parameters |
| `GET /products` | Paginated list (`?limit&skip&sort&order`) |
| `GET /products?query=mascara` | Full-text search (`?q=` also accepted) |
| `GET /products?category=beauty` | Filter by `category`, `tag`, `minPrice`, `maxPrice`; combines with `query` |
| `GET /products/:id` | One product with images, tags, reviews, dimensions |
| `POST /sync` | Trigger a catalogue sync. `202` with the run to poll; `?force=true` skips the freshness check |
| `GET /sync/status` | Is a sync running, what the cron is set to, and the last one that succeeded |
| `GET /sync/runs` | Sync history, newest first. `?date=YYYY-MM-DD&limit=` |
| `GET /sync/runs/:id` | One run — its stage and counters, live while it is running |
| `GET /health` | `200` healthy, `503` degraded, with per-dependency detail |

Extras on `/products`: `limit`, `skip`, `sort` (`relevance|id|title|price|rating|stock`),
`order`, `tag`, `minPrice`, `maxPrice`.

```bash
curl "localhost:3000/products?query=mascara"
curl "localhost:3000/products?category=beauty&limit=5"
curl "localhost:3000/products?query=lipstick&category=beauty&sort=price&order=asc"
curl "localhost:3000/products/1"
```

Responses are `{ data, meta }` — `meta` carries `total`, `limit`, `skip` and **which store
answered**, so the split is visible from the outside.

### Re-seeding and tests

```bash
docker compose exec api npm run seed         # idempotent; skips if already populated
docker compose exec api npm run seed:force   # re-fetch and rewrite
npm install && npm test                      # compile, then run the integration tests
npm run test:docker                          # same suite in a container, if your Node is older
```

### Working on it locally

TypeScript is compiled ahead of time rather than run through a loader, so what runs in the
container is what the compiler checked:

```bash
npm install
npm run typecheck    # tsc --noEmit, no output written
npm run build        # -> dist/ (plus db/migrations, copied in for the seed to apply)
npm start            # node dist/src/server.js
```

---

## Thought process and trade-offs

### Two stores, one job each

MySQL is the **system of record**: normalised, foreign keys, the store a create or an update would
go to. Elasticsearch is the **read model**: denormalised, disposable, rebuilt by the seed.

The division is absolute, and that is the point — **Elasticsearch answers every read; MySQL is
only written to.** There is no `?source=` switch and no per-endpoint routing decision, because a
store the API sometimes reads is a store the API depends on for latency. With reads confined to
the index, a slow join or a write-side lock cannot surface as a slow catalogue.

Two indexes carry it:

- **`products`** — one document per product, *fully precomputed*. Category, tags, images,
  dimensions, meta and the reviews themselves are folded in at index time, so a request is
  answered by a single document with no join and no second trip. `GET /products/:id` is therefore
  a lookup into the same index rather than a separate data path, which is what guarantees a list
  card and a detail page see identical fields.
- **`categories`** — built from the `categories` table, not aggregated out of the product
  documents. A terms aggregation has no bucket for a category holding **zero** products, so an
  unstocked category used to vanish from the nav, and `url` was always null. Reading the table at
  index time fixes both: every row, its `url`, and a count from the same `GROUP BY` MySQL runs.

The cost of this is **staleness**, and it is paid deliberately: a product edited in MySQL is wrong
in the API until the next index. See the limitations below.

### Types at the boundaries, Zod at the edges

Two different jobs, deliberately not conflated:

**TypeScript** carries the shapes *inside* the process. `ListProductsOptions` is the contract
between a validator and the service it feeds; `SearchDocument` in `models/es/`, and the `Row` and
`Write` interfaces in `models/db/`, are the contract between the stores and everything above
them. Those are compile-time only — a renamed column breaks the build instead of quietly producing
`undefined` in a response.

**Zod** guards the three places data actually arrives from outside, where a type annotation would
be a wish rather than a check:

- **`req.query`** — every parameter is declared once in `validators/`, with its type, bounds,
  allowed values and default, and the inferred static type is what the service receives. Unknown
  parameters are rejected by `z.strictObject`, and the "Allowed: …" list in that error is read
  off the schema, so it cannot fall out of date. Cross-parameter rules (the paging window) are
  schema-level refinements — pydantic's model validator, without the decorator.
- **The environment** — `config/env.ts` parses `process.env` through a schema, so `MAX_LIMIT=1oo`
  fails at boot with the variable named instead of silently falling back to 100.
- **The dummyjson feed** — `scripts/seed.ts` validates the payload before writing it to two
  stores. It is permissive about values (every field but the id may be missing) and strict about
  structure, and unknown fields are dropped so the seed survives the source adding one.

Validation errors answer with `{ error: { status, message, details } }`, where `details` names
every parameter that failed rather than only the first.

### Schema

Normalised into `categories`, `products`, `product_images`, `tags`, `product_tags`,
`product_reviews`. Decisions worth naming:

- **The source's product id is the primary key.** It's stable, so a re-seed updates in place
  instead of duplicating the catalogue.
- **`DECIMAL` for money, not `FLOAT`.** Binary floating point drifts under comparison and
  summation, and price is exactly where that surfaces in a report.
- **Dimensions are inline columns**, not a table — they're 1:1 and always present, so a joined
  table could only ever hold one row per product.
- **Tags are a proper many-to-many.** They're a shared vocabulary (138 tags across 194 products);
  a JSON column would make "products with this tag" un-indexable.
- **`ON DELETE SET NULL` from products to categories**, not `CASCADE`. Deleting a category should
  orphan its products for re-filing, never delete the catalogue.
- **The schema is applied by the seed script**, not `docker-entrypoint-initdb.d`. That directory
  only runs on a first-time init of an empty volume, so a schema change silently wouldn't apply
  to anyone who already had one.

### Elasticsearch mapping

- A custom analyzer (lowercase → ASCII-fold → English stopwords → stemmer) so *mascaras* finds
  *Mascara* and *creme* finds *crème*.
- `title` is indexed twice: stemmed for recall, and `title.exact` un-stemmed so a literal title
  match outranks a stemmed near-miss.
- Search is `best_fields` across `title^4, brand^3, tags^2, category.name^2, description`, with
  a phrase boost on `title.exact`. A product is normally identified by *one* field saying it
  strongly, not by terms scattered across several — which is why not `cross_fields`.
- Fuzziness is `AUTO` with `prefix_length: 1`, so typos are recovered without three-letter words
  matching everything.
- `category.slug` and `tags.keyword` are keywords with a lowercase normalizer: exact matching for
  filters, case-insensitive for callers.
- `dynamic: 'strict'` — an unexpected field is an error, not a silently un-searchable field.
- Filters go in `filter` context, not `must`: they're yes/no conditions that shouldn't skew
  relevance, and ES caches them.

### Seeding

One script populates both stores, because they must not drift — populating them separately is how
you get a search index describing a catalogue that no longer exists. MySQL writes happen in a
single transaction; the ES index is dropped and rebuilt (mappings are effectively immutable, so a
mapping change only takes effect on a fresh index — cheap at this size and guaranteed to match
the code). Re-running is idempotent: products upsert on their id, and child rows are replaced
wholesale because the source gives reviews and images no stable ids to match on.

### Operational details

- The API waits for **healthy**, not merely *started* — both dependencies accept TCP connections
  well before they can serve queries, and that race is the usual reason a compose file works on
  one machine and not another.
- A seeding failure logs loudly but **doesn't kill the API**. Crash-looping hides the reason
  behind a restart spinner; a live API still answers `/health` and returns a clearly-empty list.
- Paging is capped at a 10,000-row window, which is where Elasticsearch refuses `from + size`.
  Better an explicit `400` explaining it than an opaque ES error surfacing as a `500`.
- Unknown query parameters are **rejected**. A typo'd `?catagory=beauty` that silently returns
  the entire catalogue is worse than an error.
- Errors are JSON with the shape `{ error: { status, message } }`; 5xx messages are generic, with
  detail in the logs, so driver strings don't leak to clients.
- The container runs as a non-root user and shuts down gracefully on `SIGTERM` (listener first,
  then pools), so `docker compose down` isn't a burst of connection errors.

---

## Known limitations

These are deliberate scope cuts, not oversights.

1. **No authentication or rate limiting.** Every read endpoint is public. `POST /sync` is the one
   endpoint that changes anything, and it takes an optional shared secret — set
   `SYNC_TRIGGER_TOKEN` and it requires an `X-Sync-Token` header. Unset, it is open, which is fine
   on a laptop and is not fine on anything with a public address: a sync drops and rebuilds both
   indexes. Real usage would need a proper API key and a limiter.
2. **Elasticsearch security is disabled.** No TLS, no credentials — appropriate for a local demo
   stack, not for anything else.
3. **No per-resource write endpoints.** MySQL is the write store, but nothing writes to it except
   the sync. Adding `POST /products` raises the question this design currently dodges: a write to
   MySQL plus an index update needs an outbox or CDC to stay consistent, not two `await`s in a
   request handler.
4. **The sync's in-flight guard is per-process.** A module-level flag stops the cron firing on top
   of a manual trigger inside one container; it would not stop two replicas syncing at once. That
   wants a lock in MySQL. The failure mode is quiet and expensive — two runs rebuilding the same
   index — which is why it is written down here and in `sync.service.ts` rather than assumed.
5. **Deep paging uses `from`/`skip`.** Fine to 10k, wrong beyond it — `search_after` is the
   correct tool for a large catalogue.
6. **The indexes can go stale, and reads have no fallback.** The cron re-syncs on a schedule
   (03:00 daily by default), which bounds staleness rather than removing it: an edit made at 03:05
   is invisible for a day unless someone calls `POST /sync`. Because every read goes to
   Elasticsearch, stale documents are what the API serves and an unreachable cluster is a full
   read outage — there is no degrading to MySQL. A production system would drive indexing off the
   binlog rather than re-fetching the world on a timer.
7. **Secrets are in `docker-compose.yml`.** Convenient for a one-command demo, wrong for
   deployment — they belong in a secret manager.
8. **Tests need the stack running.** They're integration tests by choice: the ES query DSL and
   the SQL *are* the logic here, and a mocked Elasticsearch would happily confirm that a broken
   query is well-formed. The trade-off is that they're not runnable in a bare CI job without
   `docker compose up` first.
9. **Reviews are stored, not searchable.** They are mapped `enabled: false` — carried in the
   document for display, with `reviewCount` as the sortable summary. Searching review text would
   want them `nested` and re-indexed.

---

## Layout

Conventional Express layering — a request flows **routes → controllers → services →
repositories**, and each layer knows only the one beneath it. `models/` sits to the side of that
chain rather than at the end of it: it holds shapes and schemas, and the repositories are what
actually talk to a store.

```
docker-compose.yml          mysql + elasticsearch + api, health-gated
Dockerfile
docker-entrypoint.sh        seeds, then serves
package.json  tsconfig.json
.env.example  .gitignore  .dockerignore
│
├── db/
│   └── migrations/                 dbmate format, applied in filename order
│       ├── 20260902185246_initial_schema.sql
│       ├── 20260903060451_sync_runs.sql
│       └── 20260903061434_sync_runs_millisecond_precision.sql
│
├── src/
│   ├── app.ts                      Express assembly (middleware, routes)
│   ├── server.ts                   binds the port, graceful shutdown
│   │
│   ├── config/
│   │   ├── env.ts                  environment, parsed by a Zod schema
│   │   ├── database.ts             MySQL pool, transactions, migration apply
│   │   └── elasticsearch.ts        ES client + readiness
│   │
│   ├── routes/                     path -> controller, nothing else
│   │   ├── product.routes.ts
│   │   ├── category.routes.ts
│   │   ├── sync.routes.ts
│   │   └── health.routes.ts
│   │
│   ├── controllers/                validate, delegate, respond
│   │   ├── product.controller.ts
│   │   ├── category.controller.ts
│   │   └── sync.controller.ts
│   │
│   ├── services/                   business logic
│   │   ├── product.service.ts
│   │   ├── category.service.ts
│   │   └── sync.service.ts         the catalogue sync — feed -> MySQL -> Elasticsearch
│   │
│   ├── jobs/
│   │   └── sync.job.ts             the cron that calls it
│   │
│   ├── clients/
│   │   └── catalogFeed.client.ts   the upstream feed, and the schema guarding it
│   │
│   ├── repositories/               store access: SQL, query DSL, index lifecycle
│   │   ├── db/                     MySQL — write-only, plus the indexer's category read
│   │   │   ├── product.repository.ts
│   │   │   ├── category.repository.ts
│   │   │   ├── tag.repository.ts
│   │   │   └── syncRun.repository.ts
│   │   └── es/                     Elasticsearch — every read the API serves
│   │       ├── product.repository.ts
│   │       └── category.repository.ts
│   │
│   ├── models/                     shapes and schemas only — no queries
│   │   ├── common.types.ts         the shapes both stores agree on
│   │   ├── db/                     one model per table, named after it
│   │   │   ├── category.model.ts   categories       (+ row -> domain)
│   │   │   ├── product.model.ts    products
│   │   │   ├── productImage.model.ts   product_images
│   │   │   ├── tag.model.ts            tags
│   │   │   ├── productTag.model.ts     product_tags
│   │   │   ├── productReview.model.ts  product_reviews
│   │   │   └── syncRun.model.ts        sync_runs
│   │   └── es/
│   │       ├── product.document.ts   mapping, document shape, document shaping
│   │       └── category.document.ts
│   │
│   ├── middleware/
│   │   ├── error.middleware.ts     the one place an error becomes a response
│   │   └── logger.middleware.ts    one line per completed request
│   │
│   ├── validators/                 request -> typed, bounded options
│   │   ├── common.validator.ts     Zod parameter primitives + error mapping
│   │   ├── product.validator.ts
│   │   ├── category.validator.ts
│   │   └── sync.validator.ts
│   │
│   ├── utils/
│   │   ├── logger.ts
│   │   ├── response.ts             the { data, meta } / { error } envelope
│   │   └── errors.ts               AppError + asyncHandler
│   │
│   └── scripts/
│       └── seed.ts                 runs the sync once, from a shell
│
├── dist/                           compiled output (git-ignored)
│
└── tests/
    ├── helpers.ts
    ├── product.test.ts
    ├── category.test.ts
    ├── sync.test.ts
    └── migration.test.ts        the migration parser; needs no running stack
```

**Two deviations from the template**, both because inventing the files would mean shipping dead
code:

- **No `user.*` files.** This is a read-only catalogue with no user domain. The layering is
  identical, so adding one is mechanical: a route, a controller, a service, a repository
  and its model.
- **No `auth.middleware.ts`.** Nothing to authenticate yet — every endpoint is public and
  read-only. It would be an empty function nobody calls.

**`models/` and `repositories/` split along the same line, twice.** Each is divided by store —
`db/` for MySQL, `es/` for Elasticsearch — so the pair of files describing one entity in one store
sit together: `models/db/product.model.ts` says what a product row is, and
`repositories/db/product.repository.ts` is the only file that writes one. The SQL DDL and the
Elasticsearch mapping are both schema definitions, and keeping them in sibling folders is what
makes it obvious they describe the same entity twice.

**`models/db/` has one file per table**, including the join table and the two child tables, and
including `products` — which nothing reads, since Elasticsearch answers every request. Each
declares a `Row` mirroring the DDL column for column, and, where the seed writes to that table, a
`Write` giving the caller's side of it: camelCase, optional where the source feed is optional, and
carrying slugs rather than the surrogate ids the foreign keys use. The mapping between the two
vocabularies happens in exactly one place, the repository.

**The DDL itself is not in `src/`.** `db/migrations/` sits at the root because it is not
TypeScript and not the application — it is the database's own history, and it outlives any one
version of the code that reads it.

The files are in **dbmate's format**: a `YYYYMMDDHHMMSS_name.sql` filename, and the statements
split into `-- migrate:up` and `-- migrate:down` blocks.

```sql
-- migrate:up
CREATE TABLE IF NOT EXISTS categories (…);

-- migrate:down
DROP TABLE IF EXISTS categories;
```

`dbmate up` would run the directory unchanged, and a reviewer gets a layout they already know.
What is deliberately *not* dbmate is the **runner**: `applyMigrations` in `config/database.ts`
reads the directory itself, in filename order, applying each file's up block — which keeps the
whole stack to one `docker compose up`, with no second binary to install and no `DATABASE_URL` to
assemble. Extracting the up block is load-bearing rather than cosmetic, since the other half of
each file is `DROP TABLE`; `tests/migration.test.ts` is there to keep it that way.

The timestamp prefix is what makes the directory listing and the intended order the same thing,
and it is why two people adding migrations on separate branches do not collide the way a `002_`
counter would.

There is no `schema_migrations` ledger yet, because every up statement is
`CREATE TABLE IF NOT EXISTS` and so re-running the whole directory on each seed is free. The first
migration that is not idempotent — a column rename, a backfill — is the point at which one is
needed, and the point at which handing the directory to dbmate itself becomes the cheaper answer.

Repositories are modules of exported functions rather than classes, imported under a namespace
(`import * as productRepository from '…/es/product.repository.js'`), which matches the rest of the
codebase and is what lets the same function name — `findCategories` — mean the MySQL read in one
file and the Elasticsearch read in another without either having to be renamed.
