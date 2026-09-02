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

### Endpoints

| Endpoint | Store | Notes |
|---|---|---|
| `GET /categories` | MySQL | All categories with product counts. `?source=es` for the ES aggregation |
| `GET /products` | Elasticsearch | Paginated list. `?source=db` to serve from MySQL instead |
| `GET /products?query=mascara` | Elasticsearch | Full-text search (`?q=` also accepted) |
| `GET /products?category=beauty` | Elasticsearch | Filter by category slug; combines with `query` |
| `GET /products/:id` | MySQL | One product with images, tags, reviews, dimensions |
| `GET /health` | both | `200` healthy, `503` degraded, with per-dependency detail |

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
npm run build        # -> dist/ (plus schema.sql, copied next to its reader)
npm start            # node dist/src/server.js
```

---

## Thought process and trade-offs

### Two stores, one job each

MySQL is the **system of record**: normalised, foreign keys, the authoritative answer.
Elasticsearch is a **read model**: denormalised, disposable, rebuildable from MySQL at any time.

That split decides every routing question:

- **`/products/:id` reads MySQL.** The record a client acts on should come from the source of
  truth, not from a copy that may be a moment behind. It also wants the full relational picture
  (every review, every image), which is exactly what a search index deliberately doesn't hold.
- **`/products` (list, search, filter) reads Elasticsearch.** Text relevance, fuzzy matching and
  faceting are what it's for. The equivalent in MySQL is `LIKE '%term%'` — a table scan wearing a
  feature's clothes.
- **`/categories` reads MySQL.** The table can report a category with **zero** products; an ES
  terms aggregation cannot, because an empty bucket doesn't exist. For a storefront nav that
  difference matters.

`?source=db|es` exposes the alternative on both collection endpoints. That's not indecision — it
makes divergence between the two stores observable from the API, which is the failure mode this
architecture actually has. One of the tests asserts the two sources report identical category
counts.

### Types at the boundaries, Zod at the edges

Two different jobs, deliberately not conflated:

**TypeScript** carries the shapes *inside* the process. `ListProductsOptions` is the contract
between a validator and the service it feeds; `Product`, `SearchDocument` and the `Row`
interfaces in `product.model.ts` are the contract between the stores and everything above them.
Those are compile-time only — a renamed column breaks the build instead of quietly producing
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

1. **No authentication or rate limiting.** Every endpoint is public and read-only. Real usage
   would need at least an API key and a limiter.
2. **Elasticsearch security is disabled.** No TLS, no credentials — appropriate for a local demo
   stack, not for anything else.
3. **No write endpoints.** The catalogue is read-only; the only writer is the seed script. Adding
   `POST /products` would raise the question this design currently dodges: dual writes to MySQL
   and ES need an outbox or CDC to stay consistent, not two `await`s in a request handler.
4. **Deep paging uses `from`/`skip`.** Fine to 10k, wrong beyond it — `search_after` is the
   correct tool for a large catalogue.
5. **The ES index can go stale.** Nothing re-indexes on its own; if MySQL changed underneath, you
   re-run the seed. A production system would drive this off the binlog.
6. **Secrets are in `docker-compose.yml`.** Convenient for a one-command demo, wrong for
   deployment — they belong in a secret manager.
7. **Tests need the stack running.** They're integration tests by choice: the ES query DSL and
   the SQL *are* the logic here, and a mocked Elasticsearch would happily confirm that a broken
   query is well-formed. The trade-off is that they're not runnable in a bare CI job without
   `docker compose up` first.
8. **`?source=db` can't do full-text.** It rejects `query=` rather than quietly degrading to a
   `LIKE`, which would be slow and would return different results from the same endpoint.

---

## Layout

Conventional Express layering — a request flows **routes → controllers → services → models**,
and each layer knows only the one beneath it.

```
docker-compose.yml          mysql + elasticsearch + api, health-gated
Dockerfile
docker-entrypoint.sh        seeds, then serves
package.json  tsconfig.json
.env.example  .gitignore  .dockerignore
│
├── src/
│   ├── app.ts                      Express assembly (middleware, routes)
│   ├── server.ts                   binds the port, graceful shutdown
│   │
│   ├── config/
│   │   ├── env.ts                  environment, parsed by a Zod schema
│   │   ├── database.ts             MySQL pool, transactions, schema apply
│   │   └── elasticsearch.ts        ES client + readiness
│   │
│   ├── routes/                     path -> controller, nothing else
│   │   ├── product.routes.ts
│   │   ├── category.routes.ts
│   │   └── health.routes.ts
│   │
│   ├── controllers/                validate, delegate, respond
│   │   ├── product.controller.ts
│   │   └── category.controller.ts
│   │
│   ├── services/                   business logic: which store answers what
│   │   ├── product.service.ts
│   │   └── category.service.ts
│   │
│   ├── models/                     data access + schemas
│   │   ├── schema.sql              MySQL DDL
│   │   ├── product.types.ts        the domain shapes both stores map onto
│   │   ├── product.model.ts        MySQL queries
│   │   ├── product.index.ts        ES mapping + document shaping
│   │   └── productSearch.model.ts  ES queries
│   │
│   ├── middleware/
│   │   ├── error.middleware.ts     the one place an error becomes a response
│   │   └── logger.middleware.ts    one line per completed request
│   │
│   ├── validators/                 request -> typed, bounded options
│   │   ├── common.validator.ts     Zod parameter primitives + error mapping
│   │   ├── product.validator.ts
│   │   └── category.validator.ts
│   │
│   ├── utils/
│   │   ├── logger.ts
│   │   ├── response.ts             the { data, meta } / { error } envelope
│   │   └── errors.ts               AppError + asyncHandler
│   │
│   └── scripts/
│       └── seed.ts                 fetch -> MySQL -> Elasticsearch
│
├── dist/                           compiled output (git-ignored)
│
└── tests/
    ├── helpers.ts
    ├── product.test.ts
    └── category.test.ts
```

**Two deviations from the template**, both because inventing the files would mean shipping dead
code:

- **No `user.*` files.** This is a read-only catalogue with no user domain. The layering is
  identical, so adding one is mechanical: a route, a controller, a service, a model.
- **No `auth.middleware.ts`.** Nothing to authenticate yet — every endpoint is public and
  read-only. It would be an empty function nobody calls.

`models/` also holds the Elasticsearch mapping alongside the SQL DDL: both are schema
definitions, and keeping them side by side is what makes it obvious they describe the same
entity in two stores.
