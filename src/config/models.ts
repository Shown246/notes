import type { Connection } from 'mongoose';
import { userSchema } from '../modules/users/user.model.js';
import { noteSchema } from '../modules/notes/note.model.js';
import { postSchema } from '../modules/posts/post.model.js';

// Bind every model to the explicitly selected connection, never the global one.
export function getModels(connection: Connection) {
  return {
    User: connection.model('User', userSchema),
    Note: connection.model('Note', noteSchema),
    Post: connection.model('Post', postSchema)
  };
}
