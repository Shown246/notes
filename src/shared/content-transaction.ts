import type { ClientSession, Connection, Types } from 'mongoose';
import { getModels } from '../config/models.js';
import { AppError } from './errors.js';

// The driver retries transient transaction errors and uncertain commits. Never
// run concurrent operations on the supplied session or side effects outside it.
export function withContentTransaction<T>(
  connection: Connection, write: (session: ClientSession) => Promise<T>
): Promise<T> {
  return connection.transaction(write);
}

// Account deletion must write/delete this same parent before cascading. Keep
// every child write on this session; transaction retries recheck the parent.
export function withParentContentWrite<T>(
  connection: Connection,
  parent: { _id: Types.ObjectId; tokenVersion: number },
  write: (session: ClientSession) => Promise<T>
): Promise<T> {
  return withContentTransaction(connection, async (session) => {
    const result = await getModels(connection).User.updateOne(
      { _id: parent._id, tokenVersion: parent.tokenVersion },
      { $inc: { contentRevision: 1 } }, { session }
    );
    if (result.matchedCount !== 1) {
      throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
    }
    return write(session);
  });
}
