import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { GemHost, ceidOf } from './host.js';
import { renderReport } from './report.js';
import { loadModel } from './model.js';
import { secsText, type SecsItem } from './codec.js';
import { type HsmsTimers } from './hsms.js';

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });
const err = (s: string) => ({ content: [{ type: 'text' as const, text: s }], isError: true });

// ponytail: exported so the unit test can stub globalThis.fetch; no HTTP client abstraction beyond this.
export async function postFeedback(slug: string, body: unknown): Promise<{ ok: boolean; status?: number }> {
  const r = await fetch(`https://scadathings.com/api/feedback/${encodeURIComponent(slug)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  return r.ok ? { ok: true } : { ok: false, status: r.status };
}

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({ name: 'secs-gem-host', version: '0.2.0' });
  let host: GemHost | null = null;

  server.registerTool('connect', {
    description: 'Open an HSMS-SS connection to SECS/GEM equipment and select it. Active by default; set passive to listen instead. Timers are in seconds.',
    inputSchema: {
      host: z.string().describe('equipment IP or hostname'),
      port: z.number().int().describe('equipment HSMS port'),
      deviceId: z.number().int().optional(),
      passive: z.boolean().optional(),
      linktestSec: z.number().optional(),
      t3: z.number().optional(), t5: z.number().optional(), t6: z.number().optional(),
      t7: z.number().optional(), t8: z.number().optional(),
      model: z.string().optional().describe('path to a model JSON for startup steps 6-8'),
    },
  }, async a => {
    host?.disconnect();
    // ponytail: drop undefined entries so GemHost's DEFAULT_TIMERS merge still supplies the fallbacks.
    const timers = Object.fromEntries(
      Object.entries({ t3: a.t3, t5: a.t5, t6: a.t6, t7: a.t7, t8: a.t8 }).filter(([, v]) => v !== undefined),
    ) as Partial<HsmsTimers>;
    host = new GemHost({
      host: a.host, port: a.port, deviceId: a.deviceId ?? 0, passive: a.passive,
      linktestSec: a.linktestSec,
      timers,
      model: a.model ? loadModel(a.model) : undefined,
    });
    try {
      await host.connect();
    } catch (e) {
      host = null;
      return err(`connect failed: ${(e as Error).message}`);
    }
    return text(`connected to ${a.host}:${a.port}, HSMS state ${host.status().state}`);
  });

  server.registerTool('disconnect', {
    description: 'Send Separate.req and close the HSMS connection.',
    inputSchema: {},
  }, async () => {
    host?.disconnect();
    host = null;
    return text('disconnected');
  });

  server.registerTool('send', {
    description: 'Send one SECS-II message. An odd function sets the W-bit and waits for the reply; the reply body comes back as SML and as an item tree.',
    inputSchema: {
      stream: z.number().int(),
      function: z.number().int(),
      body: z.any().optional().describe('item tree, e.g. {"type":"L","children":[{"type":"A","value":"START"}]}'),
      wbit: z.boolean().optional(),
    },
  }, async a => {
    if (!host) return err('not connected: call connect first');
    try {
      const rsp = await host.send(a.stream, a.function, (a.body ?? null) as SecsItem | null, a.wbit ?? a.function % 2 === 1);
      if (!rsp) return text(`sent S${a.stream}F${a.function} (no reply expected)`);
      return text(JSON.stringify({
        got: `S${rsp.stream}F${rsp.function}`,
        systemBytes: rsp.systemBytes,
        sml: rsp.body ? secsText(rsp.body) : '',
        body: rsp.body,
      }, null, 2));
    } catch (e) {
      return err((e as Error).message);
    }
  });

  server.registerTool('startup', {
    description: 'Run a GEM conformance report and return it as JSON plus the rendered table. kind "startup" (default) runs the 10 E30 startup steps; kind "state" runs the 6 E30 state rules and must be used on a fresh connection, before anything else is sent.',
    inputSchema: { kind: z.enum(['startup', 'state']).optional() },
  }, async a => {
    if (!host) return err('not connected: call connect first');
    const state = a.kind === 'state';
    const r = state ? await host.stateReport() : await host.startup();
    return { content: [
      { type: 'text' as const, text: JSON.stringify(r, null, 2) },
      { type: 'text' as const, text: renderReport(r, state ? 'E30 state rules' : 'E30 startup') },
    ] };
  });

  server.registerTool('events', {
    description: 'Drain the S6F11 / S5F1 messages received since the last call.',
    inputSchema: {},
  }, async () => {
    if (!host) return err('not connected: call connect first');
    const evs = host.drainEvents().map(m => ({
      sf: `S${m.stream}F${m.function}`,
      ceid: m.stream === 6 ? ceidOf(m) : null,
      systemBytes: m.systemBytes,
      sml: m.body ? secsText(m.body) : '',
      body: m.body,
    }));
    return text(JSON.stringify(evs, null, 2));
  });

  server.registerTool('status', {
    description: 'HSMS state, whether communication is established, how many events are queued, and any conformance flags raised.',
    inputSchema: {},
  }, async () => text(JSON.stringify(
    host ? host.status() : { state: 'NOT CONNECTED', connected: false, commEstablished: false, queued: 0, flags: [] },
    null, 2,
  )));

  server.registerTool('scadathings_feedback', {
    description: 'Report to scadathings.com whether an article helped solve a SECS/GEM problem, or flag it as wrong or outdated. Use after you actually relied on an article.',
    inputSchema: {
      slug: z.string().describe('article slug, e.g. "secs-gem-s1f13-establish-communications"'),
      helped: z.boolean().describe('true if the article solved the problem'),
      note: z.string().max(500).optional().describe('what was wrong, or what it solved'),
      agent: z.string().optional().describe('agent or model name'),
    },
  }, async a => {
    try {
      return text(JSON.stringify(await postFeedback(a.slug, { helped: a.helped, note: a.note, agent: a.agent })));
    } catch (e) {
      return err(`feedback failed: ${(e as Error).message}`);
    }
  });

  // An MCP client that closes stdin means "stop": drop the link and exit rather than linger.
  const bye = () => { host?.disconnect(); process.exit(0); };
  process.stdin.on('close', bye).on('end', bye);

  await server.connect(new StdioServerTransport());
}
