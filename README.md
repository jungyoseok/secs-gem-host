# secs-gem-host

The open-source SECS/GEM **host** you point at equipment-side software to see whether it
actually works. One command runs the SEMI E30 host startup sequence and prints a
PASS/FAIL conformance table; the same engine is exposed as an MCP server so an AI agent
can drive it.

```bash
npx secs-gem-host connect 127.0.0.1:5501 --report
```

Node ≥ 20. MIT. No runtime dependency except the MCP SDK.

## Commands

```
secs-gem-host connect <host:port> [options]
secs-gem-host mcp
```

| Option | Meaning |
|---|---|
| `--device-id <n>` | HSMS session / device id (default `0`) |
| `--passive` | listen for the equipment instead of connecting to it; the `<host:port>` positional is the bind address, so use `127.0.0.1:<port>` unless you need other machines to reach it |
| `--report` | run the E30 startup, print the table, exit `1` on any FAIL |
| `--scenario <file>` | run a JSON scenario after startup |
| `--model <file>` | equipment model used by startup steps 6–8 (default: bundled `models/default.json`) |
| `--quiet` | suppress the decoded message log |
| `--linktest <sec>` | linktest interval, `0` disables (default `30`) |
| `--t3 --t5 --t6 --t7 --t8 <sec>` | HSMS timers in **seconds** (E37 defaults `45 10 5 10 5`) |

Plain `connect` stays up, prints every message in and out in SML with a timestamp and a
direction, and re-runs the whole startup after a reconnect — like a real host.

## The E30 startup

| Step | Send | Expect | PASS when |
|---|---|---|---|
| HSMS | Select.req | Select.rsp | status 0 within T6 |
| 1 | S1F13 W | S1F14 | COMMACK 0, MDLN/SOFTREV present |
| 2 | S1F17 W | S1F18 | ONLACK 0 or 2 |
| 3 | S1F3 W (empty) | S1F4 | list, within T3 |
| 4 | S1F11 W (empty) | S1F12 | non-empty SVID list |
| 5 | S2F29 W (empty) | S2F30 | list |
| 6 | S2F33 W (delete all, then define) | S2F34 | DRACK 0 |
| 7 | S2F35 W | S2F36 | LRACK 0 |
| 8 | S2F37 W (CEED true, all) | S2F38 | ERACK 0 |
| 9 | S5F3 W (ALED enable, zero-length ALID = all alarms) | S5F4 | ACKC5 0 |
| 10 | S2F31 W (now) | S2F32 | TIACK 0 |
| idle | Linktest.req every 30 s | Linktest.rsp | within T6 |

The host answers S1F13 with S1F14, S1F1 with S1F2, S5F1 with S5F2, S6F11 with S6F12 and
S6F1 with S6F2, and sends S9F3/S9F5/S9F9 on the standard conditions.

Beyond the per-step result, `--report` flags: `S9Fx received`, `unsolicited <SxFy> before
S1F14`, `reply outside T3 on <SxFy>`, `wrong system bytes on reply <SxFy>`, `W-bit set on
reply <SxFy>`, and `primary with even function <SxFy>`.

## Scenarios

A scenario is a JSON array of steps run after startup. Bodies use the same item-tree shape
as the SECS-II codec API.

```json
[
  { "send": "S2F41", "body": { "type": "L", "children": [
      { "type": "A", "value": "START" },
      { "type": "L", "children": [] }
  ] } },
  { "expect": "S6F11", "ceid": 10001, "within": 5000 },
  { "wait": 1000 },
  { "drop-ack": "S6F11" },
  { "sleep-t3": true }
]
```

| Step | Effect |
|---|---|
| `{"send": "SxFy", "body": ...}` | send a message; an odd function sets the W-bit and waits for the reply |
| `{"expect": "SxFy", "ceid": n, "within": ms}` | wait for a received message, optionally matching a CEID |
| `{"wait": ms}` | pause |
| `{"drop-ack": "SxFy"}` | do not ack the next `SxFy` primary, to exercise the equipment's retry/spool path |
| `{"sleep-t3": true}` | answer the next primary 46 s late, past T3, on purpose |

Exit code is `1` if any scenario step or any startup step failed.

## Item-tree body syntax

```json
{ "type": "L", "children": [
  { "type": "A", "value": "TEXT" },
  { "type": "U4", "value": [1, 2, 3] },
  { "type": "BOOLEAN", "value": [true] },
  { "type": "B", "value": [0, 255] }
] }
```

Types: `L B BOOLEAN A J I1 I2 I4 I8 U1 U2 U4 U8 F4 F8`. Non-list scalar values are arrays;
`A`/`J` take a string.

## MCP server

Register it with Claude Code:

```bash
claude mcp add secs-gem-host -- npx -y secs-gem-host mcp
```

or in `.mcp.json`:

```json
{
  "mcpServers": {
    "secs-gem-host": { "command": "npx", "args": ["-y", "secs-gem-host", "mcp"] }
  }
}
```

Tools: `connect`, `disconnect`, `send`, `startup`, `events`, `status`. `startup` returns
the report object (rows, `passed`, `total`, `flags`) plus the rendered table.

## Equipment model

`--model` takes a JSON file describing what steps 6–8 should define:

```json
{
  "mdln": "GENERIC-1",
  "softrev": "1.0.0",
  "svs": [{ "id": 101, "name": "SV_101", "type": "U2", "units": "", "value": 0 }],
  "reports": [{ "rptid": 10001, "vids": [10001, 10002] }],
  "events": [{ "ceid": 10001, "name": "EVENT_10001", "rptids": [10001] }],
  "alarms": [{ "alid": 1001, "text": "ALARM_1001" }]
}
```

The bundled default follows a common industrial numbering scheme: SVIDs 1–3 for the fixed
GEM variables, `101+` for process values, `10000+` for named SVs and DVs, RPTID and CEID
in parallel from `10001`, ALIDs from `1001`.

### Testing your own equipment: write a model file

The bundled model is a guess. Real equipment has its own ids, and steps 6-8 define reports
and link events by *number* — so with the default model the equipment answers DRACK 4 /
LRACK 4 / ERACK 1 ("that id does not exist here"), which is a mismatch, not a defect.

1. Copy `models/default.json` next to your run (keep it out of any public repo if the ids
   are customer data).
2. Replace `svs`, `reports`, `events` and `alarms` with the equipment's own SVIDs, VIDs,
   RPTIDs, CEIDs and ALIDs. Step 4's `S1F12` namelist prints the SVIDs the equipment
   actually has; the run also flags `model VIDs not in equipment SVID list: <ids>` before
   it sends S2F33. That flag is advisory — a VID that is a DV or an EC is legitimately
   absent from the S1F12 namelist.
3. Run with `--model <file>`.

```bash
node dist/cli.js connect 127.0.0.1:5000 --report --t3 5 --device-id 1 --model site-model.json
```

`--device-id` must match the equipment's configured session id. If it does not, the
equipment answers every primary with S9F1 (unrecognised device id) and every step fails.

## Known findings

Results of running this tool against real equipment implementations.

### secs-gem-simulator EQ1 (2026-09-05)

`node dist/cli.js connect 127.0.0.1:5501 --report --quiet`

```
Step Sent    Expect  Got     Ack  Time(ms)    Result  Note
------------------------------------------------------------------------
1    S1F13   S1F14   -       -    45009/45000 FAIL    T3 (S1F13) timeout
2    S1F17   S1F18   -       -    45018/45000 FAIL    T3 (S1F17) timeout
3    S1F3    S1F4    -       -    45005/45000 FAIL    T3 (S1F3) timeout
4    S1F11   S1F12   -       -    45026/45000 FAIL    T3 (S1F11) timeout
5    S2F29   S2F30   -       -    45005/45000 FAIL    T3 (S2F29) timeout
6    S2F33   S2F34   -       -    45022/45000 FAIL    T3 (S2F33) timeout
7    S2F35   S2F36   -       -    45010/45000 FAIL    T3 (S2F35) timeout
8    S2F37   S2F38   -       -    45020/45000 FAIL    T3 (S2F37) timeout
9    S5F3    S5F4    -       -    45007/45000 FAIL    T3 (S5F3) timeout
10   S2F31   S2F32   -       -    45021/45000 FAIL    T3 (S2F31) timeout
------------------------------------------------------------------------
E30 startup: 0/10 passed
flag: reply outside T3 on S1F13
flag: reply outside T3 on S1F17
flag: reply outside T3 on S1F3
flag: reply outside T3 on S1F11
flag: reply outside T3 on S2F29
flag: reply outside T3 on S2F33
flag: reply outside T3 on S2F35
flag: reply outside T3 on S2F37
flag: reply outside T3 on S5F3
flag: reply outside T3 on S2F31
exit=1
```

Every row is the same failure, so it is one finding, not ten.

- Step 1 — the simulator did not send S1F14; the host waited the full T3 and gave up.
- Steps 2–10 — S1F18, S1F4, S1F12, S2F30, S2F34, S2F36, S2F38, S5F4 and S2F32 never
  arrived either, for the same reason. The host sent S9F9 (transaction timer timeout)
  after each one and carried on to the next step, as E30 requires.

As of 2026-09-05 the simulator completes HSMS Select and answers Linktest, but sends no
reply to any SECS-II data message. Every step therefore timed out at T3 (45 s), so the
run takes about 7.5 minutes; pass `--t3 5` to shorten it.

## Changelog

### 0.1.1

- **S5F3 "enable all alarms" is now E5-correct.** The body was `L[B 0x80, U4 [0]]`; "all
  alarms" is a *zero-length* ALID item, `L[B 0x80, U4 []]`. Equipment that rejects an
  unknown ALID answered ACKC5 1 to the old body.
- **DRACK 4 / LRACK 4 / ERACK 1 now say what to do**: the note names the model mismatch and
  points at `--model`, and the SVID namelist from step 4 is compared against the model's
  report VIDs, so the run flags `model VIDs not in equipment SVID list: <ids>` before
  S2F33 goes out.

## Development

```bash
npm install
npm test        # tsc && chmod +x dist/cli.js && node --test "dist/test/**/*.js"
```

## Licence

MIT © Yoseok Jung
