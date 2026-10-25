import type { AgentProvider } from '../provider.ts';
import type { AgentProviderId } from '../types.ts';
import { createClaudeProvider } from './claude.ts';
import { createCodexProvider } from './codex.ts';
import { createCursorProvider } from './cursor.ts';

export function createProviders(): Record<AgentProviderId, AgentProvider> {
  return {
    claude: createClaudeProvider(),
    codex: createCodexProvider(),
    cursor: createCursorProvider(),
  };
}
