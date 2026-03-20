import express from 'express';
import { notesRouter } from './routes/notes.js';
import { tagsRouter } from './routes/tags.js';

export const app = express();

app.use(express.json());
app.use('/notes', notesRouter);
app.use('/tags', tagsRouter);
