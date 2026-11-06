import { z } from 'zod';

export const createPostSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  body: z.string().min(1).max(10_000)
});
