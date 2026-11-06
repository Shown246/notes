export interface SingleResponse<T> { data: T }
export interface Pagination { limit: number; hasMore: boolean; nextCursor: string | null }
export interface ListResponse<T> { data: T[]; pagination: Pagination }
export interface UserDto {
  id: string;
  name: string;
  email: string;
  role: 'user' | 'admin';
  interests: string[];
  createdAt: string;
  updatedAt: string;
}

// Inclusion projections work for ordinary reads AND native aggregation $project.
export const userProjection = {
  _id: 1, name: 1, email: 1, role: 1, interests: 1, createdAt: 1, updatedAt: 1
} as const;
export const userPreviewProjection = { _id: 1, name: 1 } as const;
export const noteSummaryProjection = { _id: 1, ownerId: 1, title: 1, createdAt: 1, updatedAt: 1 } as const;
export const noteDetailProjection = { ...noteSummaryProjection, content: 1 } as const;
export const postProjection = { _id: 1, authorId: 1, title: 1, body: 1, createdAt: 1, updatedAt: 1 } as const;

interface ContentRow {
  _id: { toString(): string }; title: string; createdAt: Date; updatedAt: Date;
}
export interface NoteSummaryDto {
  id: string; ownerId: string; title: string; createdAt: string; updatedAt: string;
}
export interface NoteDto extends NoteSummaryDto { content: string }
export interface PostDto {
  id: string; authorId: string; title: string; body: string; createdAt: string; updatedAt: string;
}
export interface InterestGroupDto {
  interest: string; userCount: number; usersPreview: { id: string; name: string }[]; hasMoreUsers: boolean;
}
export function toInterestGroupDto(group: {
  interest: string; userCount: number; usersPreview: { id: { toString(): string }; name: string }[];
}): InterestGroupDto {
  return {
    interest: group.interest, userCount: group.userCount,
    usersPreview: group.usersPreview.slice(0, 5).map((user) => ({ id: user.id.toString(), name: user.name })),
    hasMoreUsers: group.userCount > 5
  };
}
export function toUserPreviewDto(user: { _id: { toString(): string }; name: string }) {
  return { id: user._id.toString(), name: user.name };
}
export function toNoteSummaryDto(note: ContentRow & { ownerId: { toString(): string } }): NoteSummaryDto {
  return {
    id: note._id.toString(), ownerId: note.ownerId.toString(), title: note.title,
    createdAt: note.createdAt.toISOString(), updatedAt: note.updatedAt.toISOString()
  };
}
export function toNoteDto(note: ContentRow & { ownerId: { toString(): string }; content: string }): NoteDto {
  return { ...toNoteSummaryDto(note), content: note.content };
}
export function toPostDto(post: ContentRow & { authorId: { toString(): string }; body: string }): PostDto {
  return {
    id: post._id.toString(), authorId: post.authorId.toString(), title: post.title, body: post.body,
    createdAt: post.createdAt.toISOString(), updatedAt: post.updatedAt.toISOString()
  };
}

// Allowlist serialization: extra storage fields cannot leak through object spreading.
export function toUserDto(user: {
  _id: { toString(): string }; name: string; email: string; role: 'user' | 'admin';
  interests: string[]; createdAt: Date; updatedAt: Date;
}): UserDto {
  return {
    id: user._id.toString(), name: user.name, email: user.email, role: user.role,
    interests: [...user.interests], createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString()
  };
}
