import { Router } from 'express';
import { getAllNotes, getNoteById, createNote, updateNote, deleteNote } from '../store.js';
import { validateTitle } from '../utils/validate.js';
import { truncate } from '../utils/format.js';

export const notesRouter = Router();

notesRouter.get('/', (_req, res) => {
  const notes = getAllNotes().map((note) => ({
    ...note,
    title: truncate(note.title, 100),
  }));
  res.json(notes);
});

notesRouter.get('/:id', (req, res) => {
  const note = getNoteById(req.params.id);
  if (!note) {
    res.status(404).json({ error: 'Note not found' });
    return;
  }
  res.json(note);
});

notesRouter.post('/', (req, res) => {
  const { title, content } = req.body;
  const titleError = validateTitle(title);
  if (titleError) {
    res.status(400).json({ error: titleError });
    return;
  }
  if (content !== undefined && typeof content !== 'string') {
    res.status(400).json({ error: 'Content must be a string' });
    return;
  }
  const note = createNote(title, content ?? '');
  res.status(201).json(note);
});

notesRouter.patch('/:id', (req, res) => {
  const { title, content } = req.body;
  if (title !== undefined) {
    const titleError = validateTitle(title);
    if (titleError) {
      res.status(400).json({ error: titleError });
      return;
    }
  }
  if (content !== undefined && typeof content !== 'string') {
    res.status(400).json({ error: 'Content must be a string' });
    return;
  }
  const note = updateNote(req.params.id, { title, content });
  if (!note) {
    res.status(404).json({ error: 'Note not found' });
    return;
  }
  res.json(note);
});

notesRouter.delete('/:id', (req, res) => {
  const deleted = deleteNote(req.params.id);
  if (!deleted) {
    res.status(404).json({ error: 'Note not found' });
    return;
  }
  res.status(204).send();
});
