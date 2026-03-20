# ADR-003 — Knowledge Base Storage

**Date:** 2026-03-20  
**Status:** Accepted

## Context

Knowledge Base must be modular — users choose their backend. v1 targets Google Drive. Future: OneDrive, Dropbox, local machine, private server.

## Decision

Abstract storage behind a **Storage Adapter interface**:

```typescript
interface StorageAdapter {
  listFolder(path: string): Promise<FileNode[]>
  readFile(id: string): Promise<string>
  writeFile(id: string, content: string): Promise<void>
  uploadFile(path: string, content: Buffer): Promise<FileNode>
}
```

v1 ships `GoogleDriveAdapter`. Other adapters added per sprint without changing the rest of the system.

## Consequences

- All Knowledge Base code depends only on the interface, never on a specific provider
- Google Drive OAuth handled via Google Sign-In (separate scope from auth)
- Obsidian MCP integration reads from the same interface, outputs to vault format
