import type { Schema } from 'mongoose';

// Query updates otherwise skip schema validators by default. Seeds should use
// create/insertMany; bulkWrite updates and pipelines bypass these guarantees.
export function applyWritePolicy(schema: Schema): void {
  schema.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace'], function () {
    const update = this.getUpdate();
    if (Array.isArray(update)) throw new Error('Update pipelines are not supported');
    this.setOptions({ runValidators: true });
    if (!update) return;
    for (const [operator, fields] of Object.entries(update)) {
      if (operator.startsWith('interests.')) throw new Error('Replace the complete interests array');
      if (!operator.startsWith('$')) continue;
      if (!['$set', '$setOnInsert', '$unset', '$inc'].includes(operator)) {
        throw new Error('Unsupported model update operator');
      }
      if (fields && typeof fields === 'object') {
        for (const [path, value] of Object.entries(fields)) {
          if (path.startsWith('interests.')) throw new Error('Replace the complete interests array');
          if (operator === '$inc' &&
              (!['tokenVersion', 'contentRevision'].includes(path) || !Number.isSafeInteger(value) || Number(value) < 0)) {
            throw new Error('Invalid internal counter increment');
          }
        }
      }
    }
  });
  schema.pre('bulkWrite', function () {
    throw new Error('Use validated create, insertMany, or query writes instead of bulkWrite');
  });
}
