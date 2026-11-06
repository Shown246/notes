import type { Connection, PipelineStage, Types } from 'mongoose';
import { getModels } from '../../config/models.js';
import { AppError } from '../../shared/errors.js';
import type { interestPage } from '../../shared/pagination.js';

export const interestPreviewLimit = 5;

export function interestPipeline(page: ReturnType<typeof interestPage>): PipelineStage[] {
  // Normalized interests are nonempty strings. The first match can use the
  // multikey index to skip users without any remaining memberships. Repeat it
  // after unwind: a matching user can also have interests before the cursor.
  const remaining = { interests: { $gt: page.afterInterest ?? '' } };
  return [
    { $match: remaining },
    { $unwind: '$interests' },
    { $match: remaining },
    { $group: {
      _id: '$interests',
      userCount: { $sum: 1 },
      usersPreview: { $topN: {
        n: interestPreviewLimit,
        sortBy: { _id: -1 },
        output: { id: '$_id', name: '$name' }
      } }
    } },
    { $sort: { _id: 1 } },
    { $limit: page.fetchLimit },
    { $project: {
      _id: 0, interest: '$_id', userCount: 1, usersPreview: 1,
      hasMoreUsers: { $gt: ['$userCount', interestPreviewLimit] }
    } }
  ];
}

export function interestAggregateOptions(reportTimeoutMs: number) {
  return { allowDiskUse: true, maxTimeMS: reportTimeoutMs, collation: { locale: 'simple' } };
}

export function allInterestsPipeline(): PipelineStage[] {
  return [
    { $match: { interests: { $gt: '' } } },
    { $unwind: '$interests' },
    { $sort: { interests: 1, _id: -1 } },
    { $group: {
      _id: '$interests', userCount: { $sum: 1 },
      users: { $push: { id: '$_id', name: '$name' } }
    } },
    { $sort: { _id: 1 } },
    { $project: { _id: 0, interest: '$_id', userCount: 1, users: 1 } }
  ];
}

interface CompleteInterestRow {
  interest: string; userCount: number; users: { id: Types.ObjectId; name: string }[];
}

interface InterestRow {
  interest: string; userCount: number;
  usersPreview: { id: Types.ObjectId; name: string }[]; hasMoreUsers: boolean;
}

export function createInterestRepository(connection: Connection, reportTimeoutMs: number) {
  const { User } = getModels(connection);
  async function run<T extends object>(pipeline: PipelineStage[]) {
    try {
      const cursor = User.collection.aggregate<T>(pipeline, interestAggregateOptions(reportTimeoutMs));
      return await cursor.toArray();
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 50) {
        throw new AppError(503, 'REPORT_TIMEOUT', 'Report exceeded its execution time budget');
      }
      throw error;
    }
  }
  return {
    async all() {
      try {
        return await run<CompleteInterestRow>(allInterestsPipeline());
      } catch (error: unknown) {
        if (typeof error === 'object' && error !== null && 'code' in error &&
            [10334, 146, 292].includes(Number(error.code))) {
          throw new AppError(413, 'REPORT_TOO_LARGE', 'Complete report exceeds database size or memory limits; use the paginated report');
        }
        throw error;
      }
    },
    async list(page: ReturnType<typeof interestPage>) {
      return await run<InterestRow>(interestPipeline(page));
    }
  };
}
