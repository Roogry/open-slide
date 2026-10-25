import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderEvent } from '../provider.ts';
import {
  createCursorMapper,
  cursorPrintArgs,
  cursorSignInError,
  describeCursorTool,
  findCursorCli,
  isCursorAuthFailure,
  parseCursorAuth,
  parseCursorModelList,
} from './cursor.ts';

const CWD = '/ws/project';

function collect() {
  const events: ProviderEvent[] = [];
  const mapper = createCursorMapper((e) => events.push(e), CWD);
  return { events, mapper };
}

describe('findCursorCli', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('prefers cursor-agent and accepts agent only when it points at a Cursor install', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'open-slide-cursor-'));
    const bin = path.join(dir, 'bin');
    const install = path.join(dir, 'share', 'cursor-agent', 'cursor-agent');
    await mkdir(bin, { recursive: true });
    await mkdir(path.dirname(install), { recursive: true });
    await writeFile(install, '#!/bin/sh\n');
    await chmod(install, 0o755);
    await symlink(install, path.join(bin, 'agent'));

    expect(findCursorCli({ ...process.env, PATH: bin })?.command).toBe('agent');

    await symlink(install, path.join(bin, 'cursor-agent'));
    expect(findCursorCli({ ...process.env, PATH: bin })?.command).toBe('cursor-agent');
  });

  it('ignores an unrelated agent binary', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'open-slide-cursor-'));
    const bin = path.join(dir, 'bin');
    await mkdir(bin, { recursive: true });
    const agent = path.join(bin, 'agent');
    await writeFile(agent, '#!/bin/sh\n');
    await chmod(agent, 0o755);
    expect(findCursorCli({ ...process.env, PATH: bin })).toBeNull();
  });
});

describe('parseCursorAuth', () => {
  it('reads the documented status JSON and the signed-out text', () => {
    const json = JSON.stringify({
      status: 'authenticated',
      isAuthenticated: true,
      userInfo: { email: 'a@example.com' },
    });
    expect(parseCursorAuth(`log line\n${json}\n`, '', 0)).toBe(true);
    expect(parseCursorAuth(JSON.stringify({ isAuthenticated: false }), '', 0)).toBe(false);
    expect(parseCursorAuth('', 'Not authenticated. Run `agent login`.', 1)).toBe(false);
    expect(parseCursorAuth('Logged in as a@example.com', '', 0)).toBe(true);
    expect(parseCursorAuth('', '', 0)).toBe(false);
    expect(isCursorAuthFailure('Authentication required')).toBe(true);
  });
});

describe('parseCursorModelList', () => {
  it('keeps the CLI default and parses a text table or a JSON list', () => {
    expect(
      parseCursorModelList(`Available models

auto - Auto (current)
composer-2.5 - Composer 2.5
not a model
`),
    ).toEqual([
      { id: '', label: 'Default', efforts: [] },
      { id: 'auto', label: 'Auto', efforts: [] },
      { id: 'composer-2.5', label: 'Composer 2.5', efforts: [] },
    ]);

    expect(
      parseCursorModelList(
        JSON.stringify({
          models: [
            { id: 'gpt-5', displayName: 'GPT-5' },
            { slug: 'sonnet-4' },
            { label: 'missing id' },
          ],
        }),
      ),
    ).toEqual([
      { id: '', label: 'Default', efforts: [] },
      { id: 'gpt-5', label: 'GPT-5', efforts: [] },
      { id: 'sonnet-4', label: 'sonnet-4', efforts: [] },
    ]);

    expect(parseCursorModelList('nope')).toEqual([{ id: '', label: 'Default', efforts: [] }]);
  });
});

describe('cursorPrintArgs', () => {
  it('streams JSON in print mode and does not pass reasoning effort', () => {
    expect(
      cursorPrintArgs({ cwd: CWD, model: null, resume: null, prompt: 'Draft a deck' }),
    ).toEqual([
      '--print',
      '--output-format',
      'stream-json',
      '--stream-partial-output',
      '--trust',
      '--force',
      '--workspace',
      CWD,
      'Draft a deck',
    ]);
    expect(
      cursorPrintArgs({
        cwd: CWD,
        model: 'composer-2.5',
        resume: 'sess-1',
        prompt: 'Again',
      }),
    ).toContain('--model');
    expect(
      cursorPrintArgs({ cwd: CWD, model: 'composer-2.5', resume: '--force', prompt: 'x' }),
    ).not.toContain('--resume');
  });
});

describe('describeCursorTool', () => {
  it('summarises read, edit and shell calls with workspace-relative paths', () => {
    expect(
      describeCursorTool({ readToolCall: { args: { path: `${CWD}/slides/deck/index.tsx` } } }, CWD),
    ).toEqual({ name: 'read', title: 'Read', detail: 'slides/deck/index.tsx' });
    expect(
      describeCursorTool({ shellToolCall: { args: { command: 'pnpm   test' } } }, CWD).detail,
    ).toBe('pnpm test');
    expect(describeCursorTool({ function: { name: 'Mystery', arguments: { a: 1 } } }, CWD)).toEqual(
      { name: 'Mystery', title: 'Mystery', detail: '{"a":1}' },
    );
  });
});

describe('createCursorMapper', () => {
  it('appends only streaming deltas and skips the duplicate flushes', () => {
    const { events, mapper } = collect();
    mapper.handle({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    mapper.handle({
      type: 'assistant',
      timestamp_ms: 1,
      message: { content: [{ type: 'text', text: 'Hel' }] },
    });
    mapper.handle({
      type: 'assistant',
      timestamp_ms: 2,
      message: { content: [{ type: 'text', text: 'lo' }] },
    });
    mapper.handle({
      type: 'assistant',
      timestamp_ms: 3,
      model_call_id: 'mc-1',
      message: { content: [{ type: 'text', text: 'Hello' }] },
    });
    mapper.handle({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello' }] },
    });
    mapper.handle({
      type: 'tool_call',
      subtype: 'started',
      call_id: 't1',
      tool_call: { editToolCall: { args: { path: 'slides/deck/index.tsx' } } },
    });
    mapper.handle({
      type: 'tool_call',
      subtype: 'completed',
      call_id: 't1',
      tool_call: {
        editToolCall: { args: { path: 'slides/deck/index.tsx' }, result: { success: {} } },
      },
    });
    mapper.handle({
      type: 'tool_call',
      subtype: 'completed',
      call_id: 't2',
      tool_call: {
        shellToolCall: {
          args: { command: 'false' },
          result: { success: { exitCode: 1 } },
        },
      },
    });
    mapper.handle({
      type: 'result',
      subtype: 'success',
      duration_ms: 50,
      is_error: false,
      session_id: 'sess-1',
      result: 'Hello',
    });

    const textStart = events.find((e) => e.type === 'text-start');
    expect(textStart && 'id' in textStart && textStart.id).toBeTruthy();
    const textId = textStart && 'id' in textStart ? textStart.id : '';
    expect(events).toEqual([
      { type: 'session-id', id: 'sess-1' },
      { type: 'text-start', id: textId },
      { type: 'text-delta', id: textId, text: 'Hel' },
      { type: 'text-delta', id: textId, text: 'lo' },
      { type: 'text-end', id: textId, text: 'Hello' },
      {
        type: 'tool-start',
        id: 't1',
        name: 'edit',
        title: 'Edit',
        detail: 'slides/deck/index.tsx',
      },
      { type: 'tool-end', id: 't1', ok: true },
      { type: 'tool-start', id: 't2', name: 'shell', title: 'Run command', detail: 'false' },
      { type: 'tool-end', id: 't2', ok: false },
      { type: 'session-id', id: 'sess-1' },
      { type: 'result', durationMs: 50, costUsd: null },
    ]);
    expect(mapper.resultSeen).toBe(true);
  });

  it('reads questions from a finished assistant message and reports a failed turn', () => {
    const { events, mapper } = collect();
    const block = JSON.stringify([
      {
        header: 'Pages',
        question: 'How many pages?',
        options: [{ label: '3-5' }],
      },
    ]);
    mapper.handle({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: `A few questions.\n<open-slide-questions>${block}</open-slide-questions>`,
          },
        ],
      },
    });
    mapper.handle({ type: 'result', subtype: 'error', is_error: true, result: 'boom' });
    expect(events.map((e) => e.type)).toEqual([
      'text-start',
      'text-end',
      'questions',
      'error',
      'result',
    ]);
    expect(events.find((e) => e.type === 'text-end')).toMatchObject({ text: 'A few questions.' });
    expect(events.find((e) => e.type === 'error')).toMatchObject({ text: 'boom' });
    expect(cursorSignInError('cursor-agent')).toContain('cursor-agent login');
  });
});
