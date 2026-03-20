import { Router } from 'express';
import { getAllTags, getTagById, createTag, deleteTag } from '../store.js';

export const tagsRouter = Router();

tagsRouter.get('/', (_req, res) => {
  res.json(getAllTags());
});

tagsRouter.get('/:id', (req, res) => {
  const tag = getTagById(req.params.id);
  if (!tag) {
    res.status(404).json({ error: 'Tag not found' });
    return;
  }
  res.json(tag);
});

tagsRouter.post('/', (req, res) => {
  const { name, color } = req.body;
  if (!name || typeof name !== 'string') {
    res.status(400).json({ error: 'Name is required' });
    return;
  }
  if (!color || typeof color !== 'string') {
    res.status(400).json({ error: 'Color is required' });
    return;
  }
  const tag = createTag(name, color);
  res.status(201).json(tag);
});

tagsRouter.delete('/:id', (req, res) => {
  const deleted = deleteTag(req.params.id);
  if (!deleted) {
    res.status(404).json({ error: 'Tag not found' });
    return;
  }
  res.status(204).send();
});
