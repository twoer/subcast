/* SPDX-License-Identifier: Apache-2.0 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { writeAgentAccessProfile } from '../agentAccess';
import { createSubcastMcpServer } from '../subcastMcp';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content[0]?.text ?? '';
}

describe('Subcast MCP server', () => {
  it('exposes scoped media tools and keeps source paths and tokens out of results', async () => {
    const root = mkdtempSync(join(tmpdir(), 'subcast-mcp-'));
    roots.push(root);
    const profilePath = writeAgentAccessProfile({
      home: root,
      baseUrl: 'http://127.0.0.1:51301',
      token: 'private-agent-token',
    });
    const outputPath = join(root, 'creator-pack.zip');
    const calls: Array<{ url: string; token: string | null; body: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      const url = String(input);
      calls.push({
        url,
        token: headers.get('x-subcast-agent-token'),
        body: typeof init?.body === 'string' ? init.body : '',
      });
      if (url.endsWith('/api/agent/export')) return new Response(Buffer.from('zip bytes'));
      return Response.json({ ok: true, hashPrefix: 'aaaaaaaaaaaa', phase: 'bundle_ready', nextAction: 'export_bundle' });
    };
    const server = createSubcastMcpServer({ profilePath, fetchImpl });
    const client = new Client({ name: 'subcast-mcp-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      'subcast_export_media_pack',
      'subcast_get_media_status',
      'subcast_import_media',
      'subcast_start_insights',
      'subcast_start_transcription',
      'subcast_wait_for_media',
    ]);

    const imported = await client.callTool({
      name: 'subcast_import_media',
      arguments: { path: '/private/source/board-meeting.mp4', recipe: 'creator-brief', language: 'en' },
    });
    expect(text(imported)).not.toContain('/private/source');
    expect(text(imported)).not.toContain('private-agent-token');

    const exported = await client.callTool({
      name: 'subcast_export_media_pack',
      arguments: { hash: 'a'.repeat(64), recipe: 'creator-brief', language: 'en', outputPath },
    });
    expect(text(exported)).toContain('"recipe":"creator-brief"');
    expect(text(exported)).not.toContain(outputPath);
    expect(readFileSync(outputPath, 'utf8')).toBe('zip bytes');
    expect(calls.every((call) => call.token === 'private-agent-token')).toBe(true);
    expect(calls.some((call) => call.body.includes('board-meeting.mp4'))).toBe(true);

    await client.close();
    await server.close();
  });
});
