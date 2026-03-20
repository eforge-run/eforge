# API Reference

## Notes

### List Notes

`GET /notes`

Response:
```json
[
  {
    "id": "1",
    "title": "My Note",
    "body": "Note content here",
    "created": "2024-01-15T10:30:00.000Z"
  }
]
```

### Create Note

`POST /notes`

Request body:
```json
{
  "title": "My Note",
  "body": "Note content here"
}
```

Response (201):
```json
{
  "id": "1",
  "title": "My Note",
  "body": "Note content here",
  "created": "2024-01-15T10:30:00.000Z"
}
```

### Get Note

`GET /notes/:id`

Response:
```json
{
  "id": "1",
  "title": "My Note",
  "body": "Note content here",
  "created": "2024-01-15T10:30:00.000Z"
}
```

### Update Note

`PATCH /notes/:id`

Request body:
```json
{
  "title": "Updated Title"
}
```

Response:
```json
{
  "id": "1",
  "title": "Updated Title",
  "body": "Note content here",
  "created": "2024-01-15T10:30:00.000Z"
}
```

### Delete Note

`DELETE /notes/:id`

Response: 204 No Content

## Tags

### List Tags

`GET /tags`

Response:
```json
[
  {
    "id": "1",
    "label": "urgent",
    "color": "#ff0000"
  }
]
```

### Create Tag

`POST /tags`

Request body:
```json
{
  "label": "urgent",
  "color": "#ff0000"
}
```

Response (201):
```json
{
  "id": "1",
  "label": "urgent",
  "color": "#ff0000"
}
```
