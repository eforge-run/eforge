import { describe, it, expect, beforeEach } from 'vitest';
import { clearAll, createTag, getAllTags, getTagById, deleteTag } from '../src/store.js';

describe('Tags Store', () => {
  beforeEach(() => {
    clearAll();
  });

  it('creates a tag', () => {
    const tag = createTag('urgent', '#ff0000');
    expect(tag.name).toBe('urgent');
    expect(tag.color).toBe('#ff0000');
    expect(tag.id).toBeDefined();
    expect(tag.createdAt).toBeDefined();
  });

  it('lists all tags', () => {
    createTag('urgent', '#ff0000');
    createTag('personal', '#00ff00');
    const tags = getAllTags();
    expect(tags).toHaveLength(2);
  });

  it('gets a tag by id', () => {
    const created = createTag('work', '#0000ff');
    const found = getTagById(created.id);
    expect(found).toEqual(created);
  });

  it('returns undefined for missing tag', () => {
    expect(getTagById('999')).toBeUndefined();
  });

  it('deletes a tag', () => {
    const tag = createTag('delete-me', '#000000');
    expect(deleteTag(tag.id)).toBe(true);
    expect(getAllTags()).toHaveLength(0);
  });

  it('returns false when deleting missing tag', () => {
    expect(deleteTag('999')).toBe(false);
  });
});
