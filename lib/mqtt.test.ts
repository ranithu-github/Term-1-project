import net from 'net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The status cache lives in the database; not needed here
vi.mock('./cabinet-state', () => ({
  parseStatus: (raw: string) => {
    try {
      const d = JSON.parse(raw);
      return typeof d.online === 'boolean' ? { online: d.online, ack: Boolean(d.ack) } : null;
    } catch {
      return null;
    }
  },
  saveCabinetStatus: async () => {},
}));

import mqtt from 'mqtt';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const aedesModule = require('aedes');

const T = {
  command: 'astrix-umbrella/cabinet/command',
  response: 'astrix-umbrella/cabinet/response',
  ack: 'astrix-umbrella/cabinet/ack',
  status: 'astrix-umbrella/cabinet/status',
};

let server: net.Server;
let broker: any;
let url = '';

beforeAll(async () => {
  broker = aedesModule.createBroker ? await aedesModule.createBroker() : aedesModule();
  server = net.createServer(broker.handle);
  await new Promise<void>((r) => server.listen(0, r));
  url = `mqtt://localhost:${(server.address() as net.AddressInfo).port}`;
  process.env.HIVEMQ_BROKER_URL = url;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => broker.close(() => r()));
});

type Behaviour = (cmd: { action: string; slot: number; op?: string }, say: (topic: string, msg: object) => void) => void;

/** A scripted cabinet: publishes its retained status, then answers commands as told */
async function cabinet(status: object | null, behave: Behaviour) {
  const c = mqtt.connect(url, { clientId: `fake-cabinet-${Math.random()}` });
  await new Promise<void>((r) => c.on('connect', () => r()));
  // clear any retained status from an earlier test, then set this one
  await new Promise<void>((r) => c.publish(T.status, status ? JSON.stringify(status) : '', { retain: true }, () => r()));
  await new Promise<void>((r) => c.subscribe(T.command, () => r()));
  c.on('message', (_t, raw) => behave(JSON.parse(raw.toString()), (topic, msg) => c.publish(topic, JSON.stringify(msg))));
  return () => new Promise<void>((r) => c.end(true, {}, () => r()));
}

const ONLINE = { online: true, ack: true };

describe('runCabinetCommand (against a real local broker)', () => {
  it('returns the cabinet result for this command', async () => {
    const { runCabinetCommand } = await import('./mqtt');
    const stop = await cabinet(ONLINE, (cmd, say) => {
      say(T.ack, { action: cmd.action, slot: cmd.slot, op: cmd.op, accepted: true });
      say(T.response, { action: cmd.action, slot: cmd.slot, op: cmd.op, status: 'SUCCESS', message: 'ok' });
    });
    const r = await runCabinetCommand('BORROW', 2, 8000, 'op-a');
    await stop();
    expect(r).toMatchObject({ ok: true, response: { status: 'SUCCESS', op: 'op-a' } });
  });

  it('ignores a reply that belongs to a different operation on the same slot', async () => {
    const { runCabinetCommand } = await import('./mqtt');
    const stop = await cabinet(ONLINE, (cmd, say) => {
      say(T.ack, { action: cmd.action, slot: cmd.slot, op: cmd.op, accepted: true });
      // a late answer to an earlier borrow on the same slot, then the real one
      say(T.response, { action: cmd.action, slot: cmd.slot, op: 'old-op', status: 'FAIL', reason: 'NOT_TAKEN', message: 'stale' });
      setTimeout(() => say(T.response, { action: cmd.action, slot: cmd.slot, op: cmd.op, status: 'SUCCESS', message: 'ok' }), 200);
    });
    const r = await runCabinetCommand('BORROW', 1, 8000, 'op-b');
    await stop();
    expect(r).toMatchObject({ ok: true, response: { status: 'SUCCESS' } });
  });

  it('still works with firmware that sends no op ids', async () => {
    const { runCabinetCommand } = await import('./mqtt');
    const stop = await cabinet(ONLINE, (cmd, say) => {
      say(T.ack, { action: cmd.action, slot: cmd.slot, accepted: true });
      say(T.response, { action: cmd.action, slot: cmd.slot, status: 'SUCCESS', message: 'ok' });
    });
    const r = await runCabinetCommand('RETURN', 3, 8000, 'op-c');
    await stop();
    expect(r.ok).toBe(true);
  });

  it('a lost "got it" is uncertain (the slot must stay held), not offline', async () => {
    const { runCabinetCommand, outcomeUncertain } = await import('./mqtt');
    const stop = await cabinet(ONLINE, () => {}); // receives the command, says nothing
    const r = await runCabinetCommand('BORROW', 1, 12000, 'op-d');
    await stop();
    expect(r).toMatchObject({ ok: false, error: 'NO_ACK', commandSent: true });
    expect(outcomeUncertain(r)).toBe(true);
  }, 15000);

  it('busy is certain: nothing happened, the slot can be released', async () => {
    const { runCabinetCommand, outcomeUncertain } = await import('./mqtt');
    const stop = await cabinet(ONLINE, (cmd, say) => say(T.ack, { action: cmd.action, slot: cmd.slot, op: cmd.op, accepted: false, reason: 'BUSY' }));
    const r = await runCabinetCommand('BORROW', 4, 8000, 'op-e');
    await stop();
    expect(r).toMatchObject({ ok: false, error: 'BUSY' });
    expect(outcomeUncertain(r)).toBe(false);
  });

  it('does not send anything when the cabinet says it is offline', async () => {
    const { runCabinetCommand, outcomeUncertain } = await import('./mqtt');
    let received = 0;
    const stop = await cabinet({ online: false }, () => received++);
    const r = await runCabinetCommand('BORROW', 1, 8000, 'op-f');
    await stop();
    expect(r).toMatchObject({ ok: false, error: 'OFFLINE', commandSent: false });
    expect(received).toBe(0);
    expect(outcomeUncertain(r)).toBe(false);
  });

  it('a result that never comes after "got it" is an uncertain timeout', async () => {
    const { runCabinetCommand, outcomeUncertain } = await import('./mqtt');
    const stop = await cabinet(ONLINE, (cmd, say) => say(T.ack, { action: cmd.action, slot: cmd.slot, op: cmd.op, accepted: true }));
    const r = await runCabinetCommand('RETURN', 2, 3000, 'op-g');
    await stop();
    expect(r).toMatchObject({ ok: false, error: 'TIMEOUT', commandSent: true });
    expect(outcomeUncertain(r)).toBe(true);
  });
});
