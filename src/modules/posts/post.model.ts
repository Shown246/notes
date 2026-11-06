import { Schema } from 'mongoose';
import type { InferSchemaType } from 'mongoose';
import { applyWritePolicy } from '../../shared/model-policy.js';

export const postSchema = new Schema({
  authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  title: { type: String, required: true, trim: true, minlength: 1, maxlength: 200 },
  body: { type: String, required: true, minlength: 1, maxlength: 10_000 }
}, { collection: 'posts', timestamps: true, versionKey: false, strict: 'throw', autoIndex: false, autoCreate: false });

postSchema.index({ authorId: 1, _id: -1 }, { name: 'posts_author_id_desc' });
applyWritePolicy(postSchema);
export type Post = InferSchemaType<typeof postSchema>;
