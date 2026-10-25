import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import readline from 'node:readline';
import { findSpawnableCli } from '../detect.ts';
import { extractQuestionBlock, TEXT_QUESTIONS_INSTRUCTION } from '../prompt.ts';
import {
  type AgentProvider,
  clipDetail,
  type LocatedCli,
  type ProviderEvent,
  type ProviderRunOptions,
  ProviderUnavailableError,
  relativeToCwd,
} from '../provider.ts';
import type { AgentModelOption } from '../types.ts';

const AUTH_TIMEOUT_MS = 8_000;
const MODELS_TIMEOUT_MS = 12_000;

const CURSOR_DEFAULT_MODEL: AgentModelOption = { id: '', label: 'Default', efforts: [] };

// Official install links both names at the same binary. `cursor-agent` is the
// legacy name; `agent` is the current one and only counts when it resolves
// into a Cursor install, so an unrelated `agent` on PATH is left alone.
export function findCursorCli(env: NodeJS.ProcessEnv = process.env): LocatedCli | null {
  const named = findSpawnableCli('cursor-agent', env);
  if (named) return { command: 'cursor-agent', file: named };
  const agent = findSpawnableCli('agent', env);
  if (!agent) return null;
  let real = agent;
  try {
    real = realpathSync(agent);
  } catch {}
  if (!/cursor-agent/i.test(real) && !/cursor-agent/i.test(agent)) return null;
  return { command: 'agent', file: agent };
}

export function cursorSignInError(command: string): string {
  return `Cursor is not signed in. Run \`${command} login\` in a terminal and try again. The panel reuses that login and does not ask for an API key.`;
}

export function isCursorAuthFailure(text: string): boolean {
  return /not authenticated|not logged in|authentication required|please (log|sign) in|sign in to cursor/i.test(
    text,
  );
}

// `status --format json` is the documented auth check. The shape is not
// published, so a boolean `isAuthenticated` wins, then a status string, then
// the text the CLI prints when nobody is signed in.
export function parseCursorAuth(stdout: string, stderr: string, code: number | null): boolean {
  const blob = `${stdout}\n${stderr}`.trim();
  const jsonStart = blob.indexOf('{');
  const jsonEnd = blob.lastIndexOf('}');
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    try {
      const json = JSON.parse(blob.slice(jsonStart, jsonEnd + 1)) as Record<string, unknown>;
      if (typeof json.isAuthenticated === 'boolean') return json.isAuthenticated;
      if (json.status === 'authenticated') return true;
      if (typeof json.status === 'string' && /unauth|logged.?out|signed.?out/i.test(json.status)) {
        return false;
      }
      if (json.userInfo && typeof json.userInfo === 'object') return true;
    } catch {}
  }
  if (isCursorAuthFailure(blob)) return false;
  return code === 0 && /authenticated|logged in|signed in|@/.test(blob);
}

const MODEL_ID_RE = /^[\w.:[\]-]{1,80}$/;

function rememberModel(
  models: AgentModelOption[],
  seen: Set<string>,
  id: string,
  label: string,
): void {
  const cleanId = id.trim();
  const cleanLabel = label.trim().replace(/\s+\(current\)\s*$/i, '');
  if (!MODEL_ID_RE.test(cleanId) || seen.has(cleanId)) return;
  seen.add(cleanId);
  models.push({ id: cleanId, label: cleanLabel || cleanId, efforts: [] });
}

function modelsFromJson(value: unknown, models: AgentModelOption[], seen: Set<string>): boolean {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? ((value as { models?: unknown; data?: unknown }).models ??
        (value as { data?: unknown }).data)
      : null;
  if (!Array.isArray(list)) return false;
  for (const entry of list) {
    if (typeof entry === 'string') {
      rememberModel(models, seen, entry, entry);
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const id = record.id ?? record.slug ?? record.name;
    const label = record.displayName ?? record.display_name ?? record.label ?? id;
    if (typeof id === 'string')
      rememberModel(models, seen, id, typeof label === 'string' ? label : id);
  }
  return true;
}

// `--list-models` has no documented schema. Accept a JSON list or the text
// table the CLI prints (`id - Label`, `Label (id)`, or a bare slug).
export function parseCursorModelList(output: string): AgentModelOption[] {
  const models: AgentModelOption[] = [];
  const seen = new Set<string>();
  const trimmed = output.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      modelsFromJson(JSON.parse(trimmed), models, seen);
    } catch {}
  }
  if (models.length === 0) {
    for (const line of output.split('\n')) {
      const raw = line
        .trim()
        .replace(/^[-*•]\s*/, '')
        .replace(/^\d+[.)]\s*/, '');
      if (!raw || /available models|usage:|tip:|^model(s)?$/i.test(raw)) continue;
      const dash = /^([\w.:[\]-]+)\s+[-–—:]\s+(.+)$/.exec(raw);
      if (dash) {
        rememberModel(models, seen, dash[1], dash[2]);
        continue;
      }
      const labelParen = /^(.+?)\s+\(([\w.:[\]-]+)\)$/.exec(raw);
      if (labelParen && labelParen[1].trim() !== labelParen[2]) {
        rememberModel(models, seen, labelParen[2], labelParen[1]);
        continue;
      }
      const idParen = /^([\w.:[\]-]+)\s+\((.+)\)$/.exec(raw);
      if (idParen) {
        rememberModel(models, seen, idParen[1], idParen[2]);
        continue;
      }
      const columns = raw.split(/\s{2,}|\t/).filter(Boolean);
      if (columns.length >= 2 && MODEL_ID_RE.test(columns[0])) {
        rememberModel(models, seen, columns[0], columns.slice(1).join(' '));
        continue;
      }
      if (raw === 'auto' || (MODEL_ID_RE.test(raw) && /[-0-9]/.test(raw))) {
        rememberModel(models, seen, raw, raw);
      }
    }
  }
  return [CURSOR_DEFAULT_MODEL, ...models.filter((m) => m.id !== '')];
}

type CursorToolBody = {
  args?: Record<string, unknown>;
  result?: unknown;
};

type CursorStreamEvent = {
  type?: string;
  subtype?: string;
  session_id?: string;
  call_id?: string;
  timestamp_ms?: number;
  model_call_id?: string;
  is_error?: boolean;
  duration_ms?: number;
  result?: unknown;
  message?: { content?: { type?: string; text?: string }[] };
  tool_call?: Record<string, CursorToolBody | { name?: string; arguments?: unknown }>;
};

const TOOL_TITLES: Record<string, string> = {
  readToolCall: 'Read',
  writeToolCall: 'Write',
  editToolCall: 'Edit',
  deleteToolCall: 'Delete',
  shellToolCall: 'Run command',
  grepToolCall: 'Search',
  globToolCall: 'Search',
  lsToolCall: 'List',
  webSearchToolCall: 'Web search',
  webFetchToolCall: 'Fetch',
  semSearchToolCall: 'Search',
  todoToolCall: 'Plan',
  taskToolCall: 'Subagent',
};

function toolDetail(key: string, args: Record<string, unknown>, cwd: string): string | null {
  switch (key) {
    case 'readToolCall':
    case 'writeToolCall':
    case 'editToolCall':
    case 'deleteToolCall':
    case 'lsToolCall':
      return relativeToCwd(cwd, args.path);
    case 'shellToolCall':
      return clipDetail(args.command);
    case 'grepToolCall':
    case 'globToolCall':
    case 'semSearchToolCall':
      return clipDetail(args.pattern ?? args.globPattern ?? args.glob_pattern ?? args.query);
    case 'webSearchToolCall':
      return clipDetail(args.query ?? args.searchTerm);
    case 'webFetchToolCall':
      return clipDetail(args.url);
    case 'taskToolCall':
      return clipDetail(args.description ?? args.prompt);
    default:
      return clipDetail(args.path ?? args.command ?? args.query ?? null);
  }
}

export function describeCursorTool(
  toolCall: Record<string, unknown>,
  cwd: string,
): { name: string; title: string; detail: string | null } {
  const fn = toolCall.function;
  if (fn && typeof fn === 'object') {
    const record = fn as { name?: unknown; arguments?: unknown };
    const name = typeof record.name === 'string' && record.name ? record.name : 'tool';
    return { name, title: name, detail: clipDetail(record.arguments) };
  }
  for (const [key, value] of Object.entries(toolCall)) {
    if (!value || typeof value !== 'object') continue;
    const args = (value as CursorToolBody).args ?? {};
    const title = TOOL_TITLES[key] ?? key.replace(/ToolCall$/, '');
    return { name: key.replace(/ToolCall$/, '') || key, title, detail: toolDetail(key, args, cwd) };
  }
  return { name: 'tool', title: 'Tool', detail: null };
}

function toolSucceeded(toolCall: Record<string, unknown>): boolean {
  for (const value of Object.values(toolCall)) {
    if (!value || typeof value !== 'object' || !('result' in value)) continue;
    const result = (value as CursorToolBody).result;
    if (!result || typeof result !== 'object') return true;
    const record = result as Record<string, unknown>;
    if ('error' in record || 'failure' in record || 'rejected' in record) return false;
    const success = record.success;
    if (success && typeof success === 'object') {
      const exit = (success as { exitCode?: unknown }).exitCode;
      if (typeof exit === 'number' && exit !== 0) return false;
    }
    return true;
  }
  return true;
}

function assistantText(event: CursorStreamEvent): string {
  const content = event.message?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text ?? '')
    .join('');
}

// Print mode with `--stream-partial-output` emits three assistant shapes.
// Only a delta (timestamp, no model_call_id) is new text; the other two
// repeat text already streamed.
export function createCursorMapper(emit: (event: ProviderEvent) => void, cwd: string) {
  let counter = 0;
  const nextId = () => `c-${Date.now().toString(36)}-${(counter++).toString(36)}`;
  let textId: string | null = null;
  let textAcc = '';
  let resultSeen = false;
  const openTools = new Set<string>();

  const endText = () => {
    if (!textId) return;
    const asked = extractQuestionBlock(textAcc);
    const text = asked ? asked.text : textAcc;
    emit({ type: 'text-end', id: textId, text });
    if (asked) emit({ type: 'questions', questions: asked.questions });
    textId = null;
    textAcc = '';
  };

  const pushComplete = (text: string) => {
    const asked = extractQuestionBlock(text);
    const body = asked ? asked.text : text;
    if (body.trim()) {
      const id = nextId();
      emit({ type: 'text-start', id });
      emit({ type: 'text-end', id, text: body });
    }
    if (asked) emit({ type: 'questions', questions: asked.questions });
  };

  return {
    get resultSeen() {
      return resultSeen;
    },
    handle(event: CursorStreamEvent): void {
      if (!event || typeof event !== 'object') return;
      if (event.type === 'system' && event.subtype === 'init') {
        if (event.session_id) emit({ type: 'session-id', id: event.session_id });
        return;
      }
      if (event.type === 'assistant') {
        const text = assistantText(event);
        const hasTs = typeof event.timestamp_ms === 'number';
        const duplicateFlush = hasTs && event.model_call_id != null;
        if (duplicateFlush) return;
        if (hasTs) {
          if (!text) return;
          if (!textId) {
            textId = nextId();
            emit({ type: 'text-start', id: textId });
          }
          textAcc += text;
          emit({ type: 'text-delta', id: textId, text });
          return;
        }
        if (textId) return;
        if (text.trim()) pushComplete(text);
        return;
      }
      if (event.type === 'tool_call' && event.tool_call) {
        endText();
        const id = event.call_id || nextId();
        if (event.subtype === 'started') {
          if (openTools.has(id)) return;
          openTools.add(id);
          const described = describeCursorTool(event.tool_call, cwd);
          emit({ type: 'tool-start', id, ...described });
          return;
        }
        if (event.subtype === 'completed') {
          if (!openTools.has(id)) {
            const described = describeCursorTool(event.tool_call, cwd);
            emit({ type: 'tool-start', id, ...described });
          }
          openTools.delete(id);
          emit({ type: 'tool-end', id, ok: toolSucceeded(event.tool_call) });
        }
        return;
      }
      if (event.type === 'result') {
        endText();
        resultSeen = true;
        if (event.session_id) emit({ type: 'session-id', id: event.session_id });
        if (event.is_error || (event.subtype && event.subtype !== 'success')) {
          const text =
            typeof event.result === 'string' && event.result
              ? event.result
              : `Cursor stopped: ${event.subtype ?? 'error'}`;
          emit({ type: 'error', text });
        }
        emit({
          type: 'result',
          durationMs: typeof event.duration_ms === 'number' ? event.duration_ms : null,
          costUsd: null,
        });
      }
    },
  };
}

// Headless print mode applies file edits only with `--force`, and it has no
// channel for the per-command approval Claude uses. Reasoning effort is a
// model-parameter bracket, not a flag every model accepts, so it is not sent.
export function cursorPrintArgs(opts: {
  cwd: string;
  model: string | null;
  resume: string | null;
  prompt: string;
}): string[] {
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--stream-partial-output',
    '--trust',
    '--force',
    '--workspace',
    opts.cwd,
  ];
  if (opts.model) args.push('--model', opts.model);
  if (opts.resume && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(opts.resume)) {
    args.push('--resume', opts.resume);
  }
  args.push(opts.prompt);
  return args;
}

type Captured = { code: number | null; stdout: string; stderr: string };

function execCursor(file: string, args: string[], timeoutMs: number): Promise<Captured> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch {
      resolve({ code: null, stdout: '', stderr: '' });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: null, stdout, stderr });
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = (stdout + chunk.toString('utf8')).slice(-64_000);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4_000);
    });
    const finish = (code: number | null) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
  });
}

async function cursorIsSignedIn(cli: LocatedCli): Promise<boolean> {
  const { code, stdout, stderr } = await execCursor(
    cli.file,
    ['status', '--format', 'json'],
    AUTH_TIMEOUT_MS,
  );
  return parseCursorAuth(stdout, stderr, code);
}

async function readCursorModels(cli: LocatedCli): Promise<AgentModelOption[]> {
  const { stdout, stderr } = await execCursor(cli.file, ['--list-models'], MODELS_TIMEOUT_MS);
  const models = parseCursorModelList(`${stdout}\n${stderr}`);
  return models.length > 1 ? models : [CURSOR_DEFAULT_MODEL];
}

function streamCursor(
  file: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  onLine: (line: string) => void,
): Promise<Captured> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    let stdout = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        signal,
      });
    } catch (err) {
      reject(err);
      return;
    }
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4_000);
    });
    if (!child.stdout) {
      child.kill();
      reject(new Error('Cursor CLI produced no output stream'));
      return;
    }
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      stdout = (stdout + line).slice(-8_000);
      onLine(line);
    });
    child.on('error', (err) => {
      if (signal.aborted) resolve({ code: null, stdout, stderr });
      else reject(err);
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

export function createCursorProvider(): AgentProvider {
  return {
    id: 'cursor',
    name: 'Cursor',
    sdkPackage: null,
    cliCommand: 'cursor-agent',
    installCommand: 'curl https://cursor.com/install -fsS | bash',
    installCommandWindows: "irm 'https://cursor.com/install?win32=true' | iex",
    askInstruction: TEXT_QUESTIONS_INSTRUCTION,
    canRewind: false,
    disabledSettings: ['effort', 'approval'],
    locateCli: () => findCursorCli(),
    signedIn: cursorIsSignedIn,
    async models(cli) {
      if (!cli) return [CURSOR_DEFAULT_MODEL];
      try {
        return await readCursorModels(cli);
      } catch {
        return [CURSOR_DEFAULT_MODEL];
      }
    },
    async run(opts: ProviderRunOptions): Promise<void> {
      const cli = findCursorCli();
      if (!cli) throw new ProviderUnavailableError(this);
      if (!(await cursorIsSignedIn(cli))) throw new Error(cursorSignInError(cli.command));
      if (opts.signal.aborted) return;

      const prompt = opts.resume ? opts.prompt : `${opts.systemPromptAppend}\n\n${opts.prompt}`;
      const mapper = createCursorMapper(opts.emit, opts.cwd);
      let stderr = '';
      try {
        const captured = await streamCursor(
          cli.file,
          cursorPrintArgs({
            cwd: opts.cwd,
            model: opts.model,
            resume: opts.resume,
            prompt,
          }),
          opts.cwd,
          opts.signal,
          (line) => {
            const trimmed = line.trim();
            if (!trimmed) return;
            try {
              mapper.handle(JSON.parse(trimmed) as CursorStreamEvent);
            } catch {
              stderr = (stderr + trimmed).slice(-4_000);
            }
          },
        );
        stderr = captured.stderr || stderr;
        if (opts.signal.aborted || mapper.resultSeen) return;
        if (isCursorAuthFailure(stderr)) throw new Error(cursorSignInError(cli.command));
        const tail = stderr.trim();
        const code = captured.code == null ? 'unknown' : String(captured.code);
        throw new Error(tail || `Cursor CLI exited with code ${code}`);
      } catch (err) {
        if (opts.signal.aborted || mapper.resultSeen) return;
        throw err;
      }
    },
  };
}
