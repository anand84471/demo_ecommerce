/**
 * Request validation, tested at the function rather than over HTTP.
 *
 * The API tests already prove a bad parameter becomes a 400. What they cannot show is the
 * *parsed* result — that `?q=` and `?query=` collapse to one field, that a default is applied,
 * that `order` narrows to a literal union. Those are the contract the service layer relies on.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { config } from '../../src/config/env.js';
import { validateListProducts, validateProductId } from '../../src/validators/product.validator.js';
import { validateListRuns, validateRunId, validateTriggerSync } from '../../src/validators/sync.validator.js';
import { AppError } from '../../src/utils/errors.js';

/** The 400 a validator throws, with its details — asserted on more than once. */
function badRequestFrom(run: () => unknown): AppError {
  try {
    run();
  } catch (err) {
    assert.ok(err instanceof AppError, `expected AppError, got ${String(err)}`);
    assert.equal(err.status, 400);
    return err;
  }
  throw new assert.AssertionError({ message: 'expected the validator to reject, it accepted' });
}

describe('validateListProducts', () => {
  it('applies the configured paging defaults when nothing is asked for', () => {
    const options = validateListProducts({});
    assert.equal(options.limit, config.paging.defaultLimit);
    assert.equal(options.skip, 0);
    assert.equal(options.text, undefined);
  });

  it('collapses ?query= and ?q= into one field', () => {
    assert.equal(validateListProducts({ query: 'mascara' }).text, 'mascara');
    assert.equal(validateListProducts({ q: 'mascara' }).text, 'mascara');
    // `query` wins when both are sent, rather than the pair silently becoming one of them.
    assert.equal(validateListProducts({ query: 'monopod', q: 'mascara' }).text, 'monopod');
  });

  it('parses numbers as numbers and narrows enums to literals', () => {
    const options = validateListProducts({
      minPrice: '9.99', maxPrice: '20', limit: '5', skip: '10', sort: 'price', order: 'DESC',
    });
    assert.strictEqual(options.minPrice, 9.99);
    assert.strictEqual(options.limit, 5);
    assert.equal(options.sort, 'price');
    assert.equal(options.order, 'desc', 'order is matched case-insensitively');
  });

  it('treats an empty parameter as no opinion', () => {
    // `?limit=` is a caller with nothing to say, not a caller sending garbage.
    assert.equal(validateListProducts({ limit: '' }).limit, config.paging.defaultLimit);
    assert.equal(validateListProducts({ category: '' }).category, undefined);
  });

  it('rejects an unknown parameter and names what is allowed', () => {
    // A typo'd ?catagory= that silently returned the whole catalogue is worse than an error:
    // the caller believes a filter applied.
    const err = badRequestFrom(() => validateListProducts({ catagory: 'beauty' }));
    assert.match(err.message, /Unknown query parameter/);
    assert.match(err.message, /category/, 'the allowed list should come from the schema');
  });

  it('rejects a limit above the configured cap', () => {
    const err = badRequestFrom(() => validateListProducts({ limit: String(config.paging.maxLimit + 1) }));
    assert.match(err.message, /limit/);
  });

  it('rejects a paging window deeper than Elasticsearch allows', () => {
    const err = badRequestFrom(() => validateListProducts({ skip: String(config.paging.maxWindow), limit: '20' }));
    assert.match(err.message, /window/i);
  });

  it('rejects a repeated parameter instead of picking one', () => {
    // Express parses ?category=a&category=b into an array; taking the last would apply a filter
    // the caller did not ask for.
    const err = badRequestFrom(() => validateListProducts({ category: ['beauty', 'furniture'] }));
    assert.match(err.message, /exactly once/);
  });

  it('rejects a non-integer where an integer is required', () => {
    // `Number('12abc')` and `parseInt` would both accept something here; the validator must not.
    badRequestFrom(() => validateListProducts({ limit: '12abc' }));
    badRequestFrom(() => validateListProducts({ limit: '1.5' }));
  });

  it('carries one detail entry per failed parameter', () => {
    const err = badRequestFrom(() => validateListProducts({ limit: 'abc', minPrice: 'cheap' }));
    assert.ok(err.details && err.details.length >= 2, 'a client should be able to render field by field');
    assert.deepEqual(
      [...new Set(err.details.map((d) => d.field))].sort(),
      ['limit', 'minPrice'],
    );
  });
});

describe('validateProductId', () => {
  it('accepts a positive integer', () => {
    assert.strictEqual(validateProductId('42'), 42);
  });

  it('rejects anything else', () => {
    for (const raw of ['abc', '0', '-1', '1.5', '', undefined]) {
      badRequestFrom(() => validateProductId(raw));
    }
  });
});

describe('validateListRuns', () => {
  it('defaults to the most recent 20 across every day', () => {
    const options = validateListRuns({});
    assert.equal(options.limit, 20);
    assert.equal(options.date, undefined);
  });

  it('accepts a real calendar day', () => {
    assert.equal(validateListRuns({ date: '2026-09-03' }).date, '2026-09-03');
  });

  it('rejects a well-formed date that is not a day', () => {
    // 2026-02-31 matches YYYY-MM-DD. Answering an empty list for it would look like "no runs
    // that day" rather than "that day does not exist".
    const err = badRequestFrom(() => validateListRuns({ date: '2026-02-31' }));
    assert.match(err.message, /not a real date/);
  });

  it('rejects a date in the wrong shape', () => {
    for (const raw of ['03-09-2026', '2026/09/03', 'yesterday']) {
      badRequestFrom(() => validateListRuns({ date: raw }));
    }
  });
});

describe('validateRunId / validateTriggerSync', () => {
  it('parses a run id', () => {
    assert.strictEqual(validateRunId('7'), 7);
    badRequestFrom(() => validateRunId('abc'));
  });

  it('treats force as a boolean spelled out, not as truthiness', () => {
    assert.equal(validateTriggerSync({}).force, undefined, 'absent means "use the configured default"');
    assert.equal(validateTriggerSync({ force: 'true' }).force, true);
    assert.equal(validateTriggerSync({ force: 'false' }).force, false);
    // `?force=yes` must not quietly become false and run the wrong thing.
    badRequestFrom(() => validateTriggerSync({ force: 'yes' }));
  });
});
