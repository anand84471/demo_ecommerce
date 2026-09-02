/**
 * Elasticsearch client — the search read model.
 *
 * A sibling of database.ts rather than a subordinate of it: this app has two datastores, and
 * hiding one inside the other's module would misrepresent the architecture.
 */

import { Client } from '@elastic/elasticsearch';

import { config } from './env.js';
import { errorMessage } from '../utils/errors.js';

let client: Client | undefined;

export function getEsClient(): Client {
  if (!client) {
    client = new Client({ node: config.elasticsearch.node });
  }
  return client;
}

/**
 * Resolves once the cluster reports green or yellow, or throws after the retry budget.
 *
 * Yellow is the healthy steady state for a single node — it never reaches green because there is
 * nowhere to put a replica — so waiting for green would hang forever.
 */
export async function waitForElasticsearch({ attempts = 40, delayMs = 2000 } = {}): Promise<void> {
  for (let i = 1; i <= attempts; i += 1) {
    try {
      await getEsClient().cluster.health({ wait_for_status: 'yellow', timeout: '5s' });
      return;
    } catch (err) {
      if (i === attempts) {
        throw new Error(`Elasticsearch not reachable after ${attempts} attempts: ${errorMessage(err)}`);
      }
      await new Promise((resolve) => { setTimeout(resolve, delayMs); });
    }
  }
}

export async function closeEsClient(): Promise<void> {
  if (client) {
    await client.close();
    client = undefined;
  }
}
