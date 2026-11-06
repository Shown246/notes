import type { Connection } from 'mongoose';
import { getModels } from './models.js';

export async function verifyIndexes(connection: Connection): Promise<void> {
  for (const model of Object.values(getModels(connection))) {
    const actual = await model.collection.listIndexes().toArray();
    const declared = model.schema.indexes();
    if (actual.length !== declared.length + 1 || !actual.some((index) =>
      index.name === '_id_' && JSON.stringify(index.key) === JSON.stringify({ _id: 1 }))) {
      throw new Error('Unexpected index inventory; run npm run db:indexes and review existing indexes');
    }
    for (const [key, options] of declared) {
      const index = actual.find((candidate) => candidate.name === options.name);
      if (!index || JSON.stringify(index.key) !== JSON.stringify(key) ||
          Boolean(index.unique) !== Boolean(options.unique) || index.sparse ||
          index.partialFilterExpression || index.expireAfterSeconds !== undefined || index.hidden ||
          (index.collation && index.collation.locale !== 'simple')) {
        throw new Error('Missing or incompatible index; run npm run db:indexes and review existing indexes');
      }
    }
  }
}

export async function ensureIndexes(connection: Connection): Promise<void> {
  // Additive only. Never syncIndexes/dropIndexes on an existing database.
  for (const model of Object.values(getModels(connection))) await model.createIndexes();
  await verifyIndexes(connection);
}
