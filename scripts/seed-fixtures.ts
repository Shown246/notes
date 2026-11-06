import { Types } from 'mongoose';
import type { Connection } from 'mongoose';
import { ensureIndexes } from '../src/config/indexes.js';
import { getModels } from '../src/config/models.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { passwordSchema } from '../src/modules/auth/auth.validation.js';
import { withContentTransaction } from '../src/shared/content-transaction.js';

const fixtureId = (kind: number, index: number) => new Types.ObjectId(
  `de900000${kind.toString(16).padStart(8, '0')}${index.toString(16).padStart(8, '0')}`
);

// Fixed IDs make repeated explicit runs additive. Never reset passwords, overwrite
// edits, remove content, or seed an Admin. All fixture writes commit together.
export async function seedDemo(connection: Connection, password: unknown) {
  const secret = passwordSchema.parse(password);
  await ensureIndexes(connection);
  const passwordHash = await hashPassword(secret);
  const { User, Note, Post } = getModels(connection);
  await withContentTransaction(connection, async (session) => {
    for (let i = 1; i <= 12; i++) {
      const ownerId = fixtureId(1, i);
      const email = `demo${String(i).padStart(2, '0')}@example.test`;
      const existing = await User.findById(ownerId).session(session);
      if (existing && existing.email !== email) throw new Error('Fixture ID collision');
      if (!existing) await User.create([{
        _id: ownerId, name: `Demo User ${i}`, email, passwordHash, role: 'user',
        interests: i === 12 ? [] : [' Chess ', 'chess', `topic-${String(i).padStart(2, '0')}`, `hobby-${String(i).padStart(2, '0')}`]
      }], { session });
      // Touch the parent before creating children, as normal application writes do.
      await User.updateOne({ _id: ownerId }, { $inc: { contentRevision: 1 } }, { session });
      for (let j = 1; j <= 7; j++) {
        const index = i * 100 + j;
        const noteId = fixtureId(2, index);
        const note = await Note.findById(noteId).session(session);
        if (note && !note.ownerId.equals(ownerId)) throw new Error('Fixture ID collision');
        if (!note) await Note.create([{
          _id: noteId, ownerId, title: `Demo ${i} note ${j}`, content: 'Synthetic private note for the reviewer walkthrough.'
        }], { session });
        const postId = fixtureId(3, index);
        const post = await Post.findById(postId).session(session);
        if (post && !post.authorId.equals(ownerId)) throw new Error('Fixture ID collision');
        if (!post) await Post.create([{
          _id: postId, authorId: ownerId, title: `Demo ${i} post ${j}`, body: 'Synthetic shared post for author and global pagination.'
        }], { session });
      }
    }
  });
}
