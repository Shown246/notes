import type { Connection } from 'mongoose';
import { pageFromRows } from '../../shared/cursor.js';
import { toInterestGroupDto } from '../../shared/dto.js';
import { interestPage } from '../../shared/pagination.js';
import { createInterestRepository } from './interest.repository.js';

export function createInterestService(connection: Connection, reportTimeoutMs: number) {
  const repository = createInterestRepository(connection, reportTimeoutMs);
  return {
    async all() {
      const rows = await repository.all();
      return { data: rows.map((row) => ({
        interest: row.interest, userCount: row.userCount,
        users: row.users.map((user) => ({ id: user.id.toString(), name: user.name }))
      })) };
    },
    async list(query: unknown) {
      const page = interestPage(query);
      const rows = await repository.list(page);
      return pageFromRows(rows.map(toInterestGroupDto), page.limit, page.scope, 'interest', (row) => row.interest);
    }
  };
}
