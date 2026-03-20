import { describe, it, expect, beforeEach } from 'vitest';
import { clearAll, createNote, getAllNotes, getNoteById, updateNote, deleteNote } from '../src/store.js';

describe('Notes Store', () => {
  beforeEach(() => {
    clearAll();
  });

  it('creates a note', () => {
    const note = createNote('My Note', 'Some content');
    expect(note.title).toBe('My Note');
    expect(note.content).toBe('Some content');
    expect(note.id).toBeDefined();
    expect(note.createdAt).toBeDefined();
    expect(note.updatedAt).toBeDefined();
  });

  it('lists all notes', () => {
    createNote('First', 'content 1');
    createNote('Second', 'content 2');
    const notes = getAllNotes();
    expect(notes).toHaveLength(2);
  });

  it('gets a note by id', () => {
    const created = createNote('Test', 'test content');
    const found = getNoteById(created.id);
    expect(found).toEqual(created);
  });

  it('returns undefined for missing note', () => {
    expect(getNoteById('999')).toBeUndefined();
  });

  it('updates a note title', () => {
    const note = createNote('Update me', 'original');
    const updated = updateNote(note.id, { title: 'Updated' });
    expect(updated?.title).toBe('Updated');
    expect(updated?.content).toBe('original');
  });

  it('updates a note content', () => {
    const note = createNote('Title', 'old content');
    const updated = updateNote(note.id, { content: 'new content' });
    expect(updated?.content).toBe('new content');
    expect(updated?.title).toBe('Title');
  });

  it('returns undefined when updating missing note', () => {
    expect(updateNote('999', { title: 'nope' })).toBeUndefined();
  });

  it('deletes a note', () => {
    const note = createNote('Delete me', 'bye');
    expect(deleteNote(note.id)).toBe(true);
    expect(getAllNotes()).toHaveLength(0);
  });

  it('returns false when deleting missing note', () => {
    expect(deleteNote('999')).toBe(false);
  });
});
