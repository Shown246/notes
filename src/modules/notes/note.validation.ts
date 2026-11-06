import { z } from 'zod';

const title = z.string().trim().min(1).max(200);
const content = z.string().max(20_000);

export const createNoteSchema = z.strictObject({ title, content });
export const updateNoteSchema = z.strictObject({ title: title.optional(), content: content.optional() })
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field');
