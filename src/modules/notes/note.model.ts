import { Schema } from 'mongoose';
import type { InferSchemaType } from 'mongoose';
import { applyWritePolicy } from '../../shared/model-policy.js';

export const noteSchema = new Schema({
  ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  title: { type: String, required: true, trim: true, minlength: 1, maxlength: 200 },
  // Empty content is valid, so String's nonempty `required` validator is unsuitable.
  content: { type: String, required: true, default: '', maxlength: 20_000,
    validate: (value: unknown) => typeof value === 'string' }
}, { collection: 'notes', timestamps: true, versionKey: false, strict: 'throw', autoIndex: false, autoCreate: false });

// Per-path override; preserve ordinary nonempty String validation on other fields.
Object.assign(noteSchema.path('content'), { checkRequired: (value: unknown) => typeof value === 'string' });

noteSchema.index({ ownerId: 1, _id: -1 }, { name: 'notes_owner_id_desc' });
applyWritePolicy(noteSchema);
export type Note = InferSchemaType<typeof noteSchema>;
