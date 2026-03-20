# Module M4 — Knowledge Base

## Purpose
Provide agents and humans with a shared, structured knowledge store accessible across the organisation.

## Storage Options

| Option | Description | Priority |
|--------|-------------|----------|
| Google Drive | Org folders and subfolders | P1 (MVP) |
| OneDrive | Microsoft alternative | P2 |
| Dropbox | Third option | P2 |
| Private server | Self-hosted | P3 |
| Local machine | Physical drive | P3 |

## Structure
```
Org Knowledge Base
├── 00-Index/           # Navigation and MOCs
├── 01-Projects/        # Per-project docs
├── 02-Architecture/    # ADRs and technical decisions
├── 03-Research/        # Research and competitive analysis
├── 04-Meetings/        # Meeting notes
├── 05-Templates/       # Reusable templates
└── 06-Archive/         # Completed / deprecated
```
(Mirrors 7Ei_OS Obsidian vault structure for consistency)

## File Support
- Markdown (.md) — native support, rendered in-app
- Google Docs, Sheets, Slides — via Drive API
- PDF — view only (MVP)
- Images — via Drive

## Obsidian Sync
- Optional plugin: sync .md files with an Obsidian vault
- Via MCP server or direct file sync
- Wikilinks and tags preserved

## Vector Search (Pinecone)
- Embed documents on upload/update
- Semantic search across the knowledge base
- Agents use this for RAG (Retrieval Augmented Generation)
- MVP: keyword search only; Pinecone in Phase 4

## Agent Permissions
| Action | Default |
|--------|--------|
| Read any file | Auto-approved |
| Write/update file | Auto-approved |
| Delete file | Orchestrator approval |
| Share externally | Human approval |

## MVP Scope
- Google Drive OAuth connection
- Browse org folder tree
- Open and read .md and Google Docs
- Create and update .md files
- Agents can read/write with permission check
