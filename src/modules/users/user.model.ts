import { Schema } from 'mongoose';
import type { InferSchemaType } from 'mongoose';
import { emailSchema, normalizeEmail, normalizeInterests } from '../../shared/normalization.js';
import { applyWritePolicy } from '../../shared/model-policy.js';

export const userSchema = new Schema({
  name: { type: String, required: true, trim: true, minlength: 1, maxlength: 100 },
  email: { type: String, required: true, set: normalizeEmail,
    validate: (value: string) => emailSchema.safeParse(value).success },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ['user', 'admin'], default: 'user', required: true },
  interests: { type: [String], default: [], required: true, castNonArrays: false,
    set: normalizeInterests, validate: (value: string[]) => value.length <= 10 },
  tokenVersion: { type: Number, default: 0, required: true, min: 0, validate: Number.isSafeInteger, select: false },
  contentRevision: { type: Number, default: 0, required: true, validate: Number.isSafeInteger, select: false }
}, { collection: 'users', timestamps: true, versionKey: false, strict: 'throw', autoIndex: false, autoCreate: false });

userSchema.index({ email: 1 }, { unique: true, name: 'users_email_unique' });
// Supports the report's leading range predicate, including cursor pages.
userSchema.index({ interests: 1 }, { name: 'users_interests_asc' });
// Array mutation on a document (for example interests.push()) does not run the
// whole-array setter until the next validation. Keep saves and insertMany safe.
userSchema.pre('validate', function () {
  // Preserve any setter/cast error rather than replacing it with the default [].
  if (this.$isValid('interests')) this.interests = normalizeInterests(this.interests);
});
applyWritePolicy(userSchema);
export type User = InferSchemaType<typeof userSchema>;
