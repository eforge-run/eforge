import type { Note, Tag } from './types.js';

// --- Notes store ---

const notes: Note[] = [];
let nextNoteId = 1;

export function getAllNotes(): Note[] {
  return [...notes];
}

export function getNoteById(id: string): Note | undefined {
  return notes.find((n) => n.id === id);
}

export function createNote(title: string, content: string): Note {
  const now = new Date().toISOString();
  const note: Note = {
    id: String(nextNoteId++),
    title,
    content,
    createdAt: now,
    updatedAt: now,
  };
  notes.push(note);
  return note;
}

export function updateNote(id: string, updates: Partial<Pick<Note, 'title' | 'content'>>): Note | undefined {
  const note = notes.find((n) => n.id === id);
  if (!note) return undefined;
  if (updates.title !== undefined) note.title = updates.title;
  if (updates.content !== undefined) note.content = updates.content;
  note.updatedAt = new Date().toISOString();
  return note;
}

export function deleteNote(id: string): boolean {
  const index = notes.findIndex((n) => n.id === id);
  if (index === -1) return false;
  notes.splice(index, 1);
  return true;
}

// --- Tags store ---

const tags: Tag[] = [];
let nextTagId = 1;

export function getAllTags(): Tag[] {
  return [...tags];
}

export function getTagById(id: string): Tag | undefined {
  return tags.find((t) => t.id === id);
}

export function createTag(name: string, color: string): Tag {
  const tag: Tag = {
    id: String(nextTagId++),
    name,
    color,
    createdAt: new Date().toISOString(),
  };
  tags.push(tag);
  return tag;
}

export function updateTag(id: string, updates: Partial<Pick<Tag, 'name' | 'color'>>): Tag | undefined {
  const tag = tags.find((t) => t.id === id);
  if (!tag) return undefined;
  if (updates.name !== undefined) tag.name = updates.name;
  if (updates.color !== undefined) tag.color = updates.color;
  return tag;
}

export function deleteTag(id: string): boolean {
  const index = tags.findIndex((t) => t.id === id);
  if (index === -1) return false;
  tags.splice(index, 1);
  return true;
}

// --- Clear all ---

export function clearAll(): void {
  notes.length = 0;
  nextNoteId = 1;
  tags.length = 0;
  nextTagId = 1;
}
