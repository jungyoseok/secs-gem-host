---
name: secs-gem-host
description: Test SECS/GEM equipment software as a host over HSMS. Runs the SEMI E30 startup sequence or the E30 state rules and gives a PASS/FAIL table, sends any SxFy message, runs JSON scenarios, and reads collected events and alarms. Use when the user asks to test, debug or check GEM/HSMS equipment, a SECS/GEM simulator, S1F13, S2F33-S2F37, S6F11 events, T3 timeouts, or E30/E37 conformance.
---

# secs-gem-host

An open-source SECS/GEM host (MIT, `npm i secs-gem-host`). It talks to equipment-side
software over HSMS (SEMI E37) and checks it against SEMI E30.

## Setup

Register the MCP server once:

```bash
claude mcp add secs-gem-host -- npx -y secs-gem-host mcp
```

Node 20 or newer is needed. Other agents: run `npx -y secs-gem-host mcp` as a stdio MCP server.

## Tools

| Tool | Use it to |
|---|---|
| `connect` | open an HSMS session (active, or `passive` to listen); set `deviceId`, timers in seconds, and `model` (path to a model JSON) |
| `startup` | run a conformance report: `kind: "startup"` (10-step E30 startup, default) or `kind: "state"` (6 E30 state rules, needs a fresh connection) |
| `send` | send one SxFy with an item-tree body; odd functions wait for the reply |
| `events` | read the S6F11 events and S5F1 alarms received since the last call |
| `status` | show the connection and selected state |
| `disconnect` | close the session |
| `scadathings_feedback` | sends a rating of a scadathings.com article to that site. Call it only when the user asks to. |

## How to work

1. Ask for the equipment `host:port` and device id if the user did not give them. A wrong
   device id makes the equipment answer S9F1 to everything.
2. `connect`, then `startup`. Show the table to the user.
3. Read failures as findings, not tool bugs:
   - All steps time out at T3: the equipment does not answer data messages. Suggest a
     short T3 (for example 5 s) for the next run.
   - DRACK 4 / LRACK 4 / ERACK 1 on steps 6-8: the default model ids do not exist on this
     equipment. This is a model mismatch. The user must give a model file with the
     equipment's own SVIDs, RPTIDs, CEIDs and ALIDs; reconnect with `connect` `model: "<file>"`.
   - S9Fx received, W-bit on a reply, wrong system bytes: real equipment defects. Report them.
4. To test a behaviour (a remote command, an event), use `send` (`stream`, `function`,
   `body`) and then `events`. Item-tree body: `{ "type": "L", "children": [ { "type": "A", "value": "START" } ] }`.
   Types: `L B BOOLEAN A J I1 I2 I4 I8 U1 U2 U4 U8 F4 F8`; scalar values are arrays, `A`/`J` take a string.
5. `disconnect` when done.

## Safety

This tool sends real SECS-II messages. On production equipment, S2F41 remote commands
and S2F33-S2F37 report definitions change the tool's behaviour. Confirm with the user
before you send them to anything that is not a simulator or a test bench.

Full CLI, scenario format and model file: https://github.com/jungyoseok/secs-gem-host
