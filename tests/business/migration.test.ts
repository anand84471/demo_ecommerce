import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { extractUpSection } from '../../src/config/database.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(here, '..', '..', 'db', 'migrations');

/**
 * The one parser whose failure mode is destructive: feeding a dbmate file's `-- migrate:down`
 * block to the seed would create the schema and then drop it. These run without a stack, unlike
 * the rest of the suite.
 */
describe('dbmate migration parsing', () => {
  it('keeps the up block and discards the down block', () => {
    const up = extractUpSection([
      '-- a comment',
      '-- migrate:up',
      'CREATE TABLE t (id INT);',
      '-- migrate:down',
      'DROP TABLE t;',
    ].join('\n'));

    assert.match(up, /CREATE TABLE/);
    assert.doesNotMatch(up, /DROP TABLE/);
  });

  it('treats a file with no directive as all-up', () => {
    // An ordinary .sql file dropped into the directory should still apply.
    assert.match(extractUpSection('CREATE TABLE t (id INT);'), /CREATE TABLE/);
  });

  it('ignores the directive words when they appear mid-line', () => {
    // As they do in the prose above the real migrations.
    const up = extractUpSection('-- the -- migrate:down block is dropped\nCREATE TABLE t (id INT);');
    assert.match(up, /CREATE TABLE/);
  });

  it('drops no table when applying the real migrations', async () => {
    const files = (await fs.readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith('.sql'));
    assert.ok(files.length > 0, 'no migrations found');

    for (const file of files) {
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      assert.doesNotMatch(
        extractUpSection(sql),
        /\bDROP\s+TABLE\b/i,
        `${file}: a DROP survived into the section the seed applies`,
      );
    }
  });
});
