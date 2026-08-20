/* SPDX-License-Identifier: Apache-2.0 */
import { existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { readAgentAccessProfile } from './agentAccess.js';

const DEFAULT_PROFILE_PATH = join(homedir(), 'Library', 'Application Support', 'Subcast', 'agent-access.json');
const RECIPES = ['generic-archive-pack', 'creator-brief', 'meeting-notes'] as const;
const LANGUAGES = ['zh-CN', 'en'] as const;

type FetchLike = typeof fetch;
type Recipe = typeof RECIPES[number];
type Language = typeof LANGUAGES[number];

export interface SubcastMcpOptions {
  fetchImpl?: FetchLike;
  profilePath?: string;
}

function textResult(payload: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    ...(isError ? { isError: true } : {}),
  };
}

function errorCode(err: unknown): string {
  return err instanceof Error && /^[A-Z0-9_]+$/.test(err.name) ? err.name : 'SUBCAST_MCP_FAILED';
}

function profilePath(options: SubcastMcpOptions): string {
  return options.profilePath ?? process.env.SUBCAST_AGENT_PROFILE ?? DEFAULT_PROFILE_PATH;
}

async function requestJson(options: SubcastMcpOptions, path: string, init: RequestInit = {}): Promise<unknown> {
  const profile = readAgentAccessProfile(profilePath(options));
  const response = await (options.fetchImpl ?? fetch)(`${profile.baseUrl}${path}`, {
    ...init,
    headers: {
      'x-subcast-agent-token': profile.token,
      ...init.headers,
    },
  });
  if (!response.ok) {
    const err = new Error(`SUBCAST_HTTP_${response.status}`);
    err.name = `SUBCAST_HTTP_${response.status}`;
    throw err;
  }
  return response.json();
}

async function startStream(options: SubcastMcpOptions, path: string, language?: Language): Promise<void> {
  const profile = readAgentAccessProfile(profilePath(options));
  const response = await (options.fetchImpl ?? fetch)(`${profile.baseUrl}${path}`, {
    headers: {
      'x-subcast-agent-token': profile.token,
      ...(language ? { 'accept-language': language } : {}),
    },
  });
  if (!response.ok) {
    const err = new Error(`SUBCAST_HTTP_${response.status}`);
    err.name = `SUBCAST_HTTP_${response.status}`;
    throw err;
  }
  await response.body?.cancel();
}

async function exportPack(options: SubcastMcpOptions, input: {
  hash: string;
  recipe: Recipe;
  language: Language;
  outputPath: string;
  overwrite: boolean;
}): Promise<{ bytes: number }> {
  if (!isAbsolute(input.outputPath)) {
    const err = new Error('OUTPUT_PATH_MUST_BE_ABSOLUTE');
    err.name = 'OUTPUT_PATH_MUST_BE_ABSOLUTE';
    throw err;
  }
  const target = resolve(input.outputPath);
  if (!existsSync(dirname(target))) {
    const err = new Error('OUTPUT_DIRECTORY_NOT_FOUND');
    err.name = 'OUTPUT_DIRECTORY_NOT_FOUND';
    throw err;
  }
  if (existsSync(target) && !input.overwrite) {
    const err = new Error('OUTPUT_ALREADY_EXISTS');
    err.name = 'OUTPUT_ALREADY_EXISTS';
    throw err;
  }

  const profile = readAgentAccessProfile(profilePath(options));
  const response = await (options.fetchImpl ?? fetch)(`${profile.baseUrl}/api/agent/export`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-subcast-agent-token': profile.token,
    },
    body: JSON.stringify({ hash: input.hash, recipe: input.recipe, language: input.language }),
  });
  if (!response.ok) {
    const err = new Error(`SUBCAST_HTTP_${response.status}`);
    err.name = `SUBCAST_HTTP_${response.status}`;
    throw err;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  writeFileSync(target, bytes, { flag: input.overwrite ? 'w' : 'wx', mode: 0o600 });
  return { bytes: bytes.length };
}

async function waitForMedia(options: SubcastMcpOptions, input: {
  hash: string;
  recipe: Recipe;
  language: Language;
  timeoutSeconds: number;
}): Promise<unknown> {
  const deadline = Date.now() + input.timeoutSeconds * 1_000;
  let status: unknown;
  do {
    const query = new URLSearchParams({ recipe: input.recipe, language: input.language });
    status = await requestJson(options, `/api/agent/media/${encodeURIComponent(input.hash)}?${query}`);
    const phase = typeof status === 'object' && status !== null ? (status as { phase?: string }).phase : undefined;
    if (phase !== 'transcribe_pending' && phase !== 'insights_pending') return status;
    if (Date.now() >= deadline) return status;
    await sleep(1_000);
  } while (Date.now() < deadline);
  return status;
}

export function createSubcastMcpServer(options: SubcastMcpOptions = {}): McpServer {
  const server = new McpServer({ name: 'subcast', version: '0.5.2' });

  server.registerTool('subcast_import_media', {
    title: 'Import local media into Subcast',
    description: 'Import a user-approved local audio/video path. The tool never returns the source path or filename.',
    inputSchema: {
      path: z.string().min(1),
      recipe: z.enum(RECIPES).default('generic-archive-pack'),
      language: z.enum(LANGUAGES).default('zh-CN'),
    },
    annotations: { destructiveHint: false },
  }, async ({ path, recipe, language }) => {
    try {
      const result = await requestJson(options, '/api/agent/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path, recipe, language }),
      });
      return textResult(result);
    } catch (err) {
      return textResult({ ok: false, code: errorCode(err) }, true);
    }
  });

  server.registerTool('subcast_get_media_status', {
    title: 'Get Subcast media readiness',
    description: 'Return the next safe Subcast action for an imported media hash.',
    inputSchema: {
      hash: z.string().min(12),
      recipe: z.enum(RECIPES).default('generic-archive-pack'),
      language: z.enum(LANGUAGES).default('zh-CN'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ hash, recipe, language }) => {
    try {
      const query = new URLSearchParams({ recipe, language });
      return textResult(await requestJson(options, `/api/agent/media/${encodeURIComponent(hash)}?${query}`));
    } catch (err) {
      return textResult({ ok: false, code: errorCode(err) }, true);
    }
  });

  server.registerTool('subcast_start_transcription', {
    title: 'Start Subcast transcription',
    description: 'Start or attach to a local transcription job. Poll media status afterwards.',
    inputSchema: { hash: z.string().min(12) },
    annotations: { destructiveHint: false },
  }, async ({ hash }) => {
    try {
      await startStream(options, `/api/transcribe?hash=${encodeURIComponent(hash)}`);
      return textResult({ ok: true, started: true });
    } catch (err) {
      return textResult({ ok: false, code: errorCode(err) }, true);
    }
  });

  server.registerTool('subcast_start_insights', {
    title: 'Start Subcast AI Insights',
    description: 'Start or attach to a local AI Insights job for the requested output language.',
    inputSchema: {
      hash: z.string().min(12),
      language: z.enum(LANGUAGES).default('zh-CN'),
    },
    annotations: { destructiveHint: false },
  }, async ({ hash, language }) => {
    try {
      await startStream(options, `/api/insights?hash=${encodeURIComponent(hash)}`, language);
      return textResult({ ok: true, started: true });
    } catch (err) {
      return textResult({ ok: false, code: errorCode(err) }, true);
    }
  });

  server.registerTool('subcast_wait_for_media', {
    title: 'Wait for Subcast processing',
    description: 'Poll media readiness until processing completes, fails, or the timeout expires.',
    inputSchema: {
      hash: z.string().min(12),
      recipe: z.enum(RECIPES).default('generic-archive-pack'),
      language: z.enum(LANGUAGES).default('zh-CN'),
      timeoutSeconds: z.number().int().min(1).max(60).default(30),
    },
    annotations: { readOnlyHint: true },
  }, async ({ hash, recipe, language, timeoutSeconds }) => {
    try {
      return textResult(await waitForMedia(options, { hash, recipe, language, timeoutSeconds }));
    } catch (err) {
      return textResult({ ok: false, code: errorCode(err) }, true);
    }
  });

  server.registerTool('subcast_export_media_pack', {
    title: 'Export a Subcast media pack',
    description: 'Write a completed media pack ZIP to a user-approved absolute output path. Existing files are never overwritten unless requested.',
    inputSchema: {
      hash: z.string().min(12),
      recipe: z.enum(RECIPES).default('generic-archive-pack'),
      language: z.enum(LANGUAGES).default('zh-CN'),
      outputPath: z.string().min(1),
      overwrite: z.boolean().default(false),
    },
    annotations: { destructiveHint: true },
  }, async ({ hash, recipe, language, outputPath, overwrite }) => {
    try {
      const result = await exportPack(options, { hash, recipe, language, outputPath, overwrite });
      return textResult({ ok: true, recipe, bytes: result.bytes });
    } catch (err) {
      return textResult({ ok: false, code: errorCode(err) }, true);
    }
  });

  return server;
}

export async function runSubcastMcp(): Promise<void> {
  const server = createSubcastMcpServer();
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runSubcastMcp().catch((err) => {
    console.error(`[subcast-mcp] ${errorCode(err)}`);
    process.exitCode = 1;
  });
}
