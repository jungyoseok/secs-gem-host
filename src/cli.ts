#!/usr/bin/env node
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { GemHost } from './host.js';
import { renderReport, exitCode } from './report.js';
import { runScenario, renderScenario, type ScenarioStep } from './scenario.js';
import { loadModel } from './model.js';
import { DEFAULT_TIMERS } from './hsms.js';

const USAGE = `secs-gem-host — SECS/GEM host test tool

  secs-gem-host connect <host:port> [options]
  secs-gem-host mcp

Options
  --device-id <n>     HSMS session / device id (default 0)
  --passive           listen instead of connecting (default: active)
  --report            run the E30 startup and print the conformance table; exit 1 on any FAIL
  --scenario <file>   run a JSON scenario after startup
  --model <file>      equipment model for steps 6-8 (default: bundled models/default.json)
  --quiet             do not print the decoded message log
  --linktest <sec>    linktest interval, 0 disables (default 30)
  --t3 --t5 --t6 --t7 --t8 <sec>   HSMS timers in seconds (default ${DEFAULT_TIMERS.t3} ${DEFAULT_TIMERS.t5} ${DEFAULT_TIMERS.t6} ${DEFAULT_TIMERS.t7} ${DEFAULT_TIMERS.t8})
`;

function fail(msg: string): never {
  process.stderr.write(`${msg}\n`);
  process.exit(2);
}

function parseTarget(s: string | undefined): { host: string; port: number } {
  const m = /^\[?([^\]]+)\]?:(\d+)$/.exec(s ?? '');
  if (!m) fail(`expected <host:port>, got ${JSON.stringify(s ?? '')}\n\n${USAGE}`);
  return { host: m[1], port: Number(m[2]) };
}

/** A numeric flag: timers must be a number > 0, ids and intervals a whole number >= 0. */
function numFlag(name: string, raw: string, timer: boolean): number {
  const n = Number(raw);
  const ok = Number.isFinite(n) && (timer ? n > 0 : Number.isInteger(n) && n >= 0);
  if (!ok) fail(`--${name} expects ${timer ? 'a number > 0' : 'a whole number >= 0'}, got ${JSON.stringify(raw)}`);
  return n;
}

/** Read + parse a scenario file before we touch the network, so a typo is a usage error. */
function loadScenario(path: string): ScenarioStep[] {
  try {
    const steps = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (!Array.isArray(steps)) throw new Error('expected a JSON array of steps');
    return steps as ScenarioStep[];
  } catch (e) {
    fail(`cannot read scenario ${path}: ${(e as Error).message}`);
  }
}

async function main(): Promise<void> {
  // parseArgs is strict: an unknown flag throws, and that is a usage error, not a crash.
  const { values, positionals } = (() => {
    try {
      return parseArgs({
        allowPositionals: true,
        options: {
          'device-id': { type: 'string', default: '0' },
          passive: { type: 'boolean', default: false },
          report: { type: 'boolean', default: false },
          scenario: { type: 'string' },
          model: { type: 'string' },
          quiet: { type: 'boolean', default: false },
          linktest: { type: 'string', default: '30' },
          t3: { type: 'string', default: String(DEFAULT_TIMERS.t3) },
          t5: { type: 'string', default: String(DEFAULT_TIMERS.t5) },
          t6: { type: 'string', default: String(DEFAULT_TIMERS.t6) },
          t7: { type: 'string', default: String(DEFAULT_TIMERS.t7) },
          t8: { type: 'string', default: String(DEFAULT_TIMERS.t8) },
          help: { type: 'boolean', default: false, short: 'h' },
        },
      });
    } catch (e) {
      fail(`${(e as Error).message}\n\n${USAGE}`);
    }
  })();

  const cmd = positionals[0];
  if (values.help || !cmd) { process.stdout.write(USAGE); process.exit(cmd ? 0 : 2); }

  if (cmd === 'mcp') {
    const { startMcpServer } = await import('./mcp.js');
    await startMcpServer();
    return;
  }

  if (cmd !== 'connect') fail(`unknown command ${JSON.stringify(cmd)}\n\n${USAGE}`);

  const { host, port } = parseTarget(positionals[1]);
  const steps = values.scenario ? loadScenario(values.scenario) : null;
  const timers = {
    t3: numFlag('t3', values.t3, true), t5: numFlag('t5', values.t5, true),
    t6: numFlag('t6', values.t6, true), t7: numFlag('t7', values.t7, true),
    t8: numFlag('t8', values.t8, true),
  };
  const deviceId = numFlag('device-id', values['device-id'], false);
  const linktestSec = numFlag('linktest', values.linktest, false);

  const gem = new GemHost({
    host, port,
    deviceId,
    passive: values.passive,
    linktestSec,
    timers,
    model: values.model ? loadModel(values.model) : undefined,
    onLog: values.quiet ? undefined : line => process.stdout.write(`${line}\n`),
  });

  try {
    await gem.connect();
  } catch (e) {
    process.stderr.write(`connect failed: ${(e as Error).message}\n`);
    process.exit(1);
  }

  const report = await gem.startup();
  if (values.report) process.stdout.write(`${renderReport(report)}\n`);

  let scenarioCode = 0;
  if (steps) {
    const res = await runScenario(gem, steps);
    process.stdout.write(`${renderScenario(res)}\n`);
    scenarioCode = res.passed === res.total ? 0 : 1;
  }

  if (!values.report && !steps) {
    // Plain `connect`: stay up, print traffic, re-run startup on reconnect.
    gem.autoReconnect(true);
    process.on('SIGINT', () => { gem.disconnect(); process.exit(0); });
    return;
  }

  gem.disconnect();
  process.exit(exitCode(report) || scenarioCode);
}

main().catch(e => {
  process.stderr.write(`${(e as Error).stack ?? e}\n`);
  process.exit(1);
});
