// Public surface of @agent-dream/core. Owned by the orchestrator.
export * from './types.ts';

// store/ — memory folder, pages, history, lock, config
export { MemoryStore } from './store/store.ts';
export {
  parsePage,
  serializePage,
  isValidPageName,
  slugify,
  extractLinks,
  threadPageName,
} from './store/frontmatter.ts';
export { createHistory, type History } from './store/history.ts';
export { acquireLock } from './store/lock.ts';
export { loadConfig } from './store/config.ts';

// quality/ — redaction, lint, search, similarity
export { redact } from './quality/redact.ts';
export { lintMemory, indexStats } from './quality/lint.ts';
export { searchPages, searchTranscripts } from './quality/search.ts';
export { similarity, normalizeForQuote } from './quality/similarity.ts';

// transcripts/ — adapters, filtering, chunking, evidence
export { ClaudeCodeAdapter } from './transcripts/claude-code.ts';
export { CodexAdapter } from './transcripts/codex.ts';
export { OpencodeAdapter } from './transcripts/opencode.ts';
export { defaultAdapters } from './transcripts/registry.ts';
export { filterMessages } from './transcripts/filter.ts';
export { findCandidates } from './transcripts/candidates.ts';
export { chunkMessages, estimateTokens, renderMessage, wrapUntrusted } from './transcripts/chunk.ts';
export { parseMsgRange, checkQuote } from './transcripts/evidence.ts';
export { normalizePath, samePath } from './transcripts/paths.ts';

// engine/ — the dream job state machine and the service facade
export { DreamService } from './engine/service.ts';
