import type { Connection, Types } from 'mongoose';
import type { z } from 'zod';
import { getModels } from '../../config/models.js';
import type { CurrentUser } from '../../middleware/auth.js';
import { withParentContentWrite } from '../../shared/content-transaction.js';
import { pageFromRows } from '../../shared/cursor.js';
import { noteDetailProjection, noteSummaryProjection, toNoteDto, toNoteSummaryDto } from '../../shared/dto.js';
import { AppError } from '../../shared/errors.js';
import { cursorScopes, objectIdPage, ownNotesPage } from '../../shared/pagination.js';
import type { createNoteSchema, updateNoteSchema } from './note.validation.js';

const notFound = () => new AppError(404, 'NOTE_NOT_FOUND', 'Note not found');

export function createNoteService(connection: Connection, queryTimeoutMs: number) {
  const { Note } = getModels(connection);
  async function list(page: ReturnType<typeof objectIdPage>) {
    const rows = await Note.find(page.predicate).select(noteSummaryProjection)
      .sort(page.sort).limit(page.fetchLimit).maxTimeMS(queryTimeoutMs).lean();
    return pageFromRows(rows.map(toNoteSummaryDto), page.limit, page.scope, 'objectId', (row) => row.id);
  }
  async function detail(predicate: { _id: Types.ObjectId; ownerId?: Types.ObjectId }) {
    const note = await Note.findOne(predicate).select(noteDetailProjection).maxTimeMS(queryTimeoutMs).lean();
    if (!note) throw notFound();
    return toNoteDto(note);
  }
  return {
    async create(user: CurrentUser, input: z.output<typeof createNoteSchema>) {
      return withParentContentWrite(connection, user, async (session) => {
        const [note] = await Note.create([{ ownerId: user._id, title: input.title, content: input.content }], { session });
        return toNoteDto(note!);
      });
    },
    listOwn: (ownerId: Types.ObjectId, query: unknown) => list(ownNotesPage(query, ownerId)),
    listAll: (query: unknown) => list(objectIdPage(query, cursorScopes.adminNotes)),
    readOwn: (ownerId: Types.ObjectId, noteId: Types.ObjectId) => detail({ _id: noteId, ownerId }),
    readAny: (noteId: Types.ObjectId) => detail({ _id: noteId }),
    async update(ownerId: Types.ObjectId, noteId: Types.ObjectId, input: z.output<typeof updateNoteSchema>) {
      const fields: { title?: string; content?: string } = {};
      if (input.title !== undefined) fields.title = input.title;
      if (input.content !== undefined) fields.content = input.content;
      const note = await Note.findOneAndUpdate({ _id: noteId, ownerId }, { $set: fields },
        { returnDocument: 'after', maxTimeMS: queryTimeoutMs }).select(noteDetailProjection).lean();
      if (!note) throw notFound();
      return toNoteDto(note);
    },
    async delete(ownerId: Types.ObjectId, noteId: Types.ObjectId) {
      const note = await Note.findOneAndDelete({ _id: noteId, ownerId }, { maxTimeMS: queryTimeoutMs })
        .select({ _id: 1 }).lean();
      if (!note) throw notFound();
    }
  };
}
