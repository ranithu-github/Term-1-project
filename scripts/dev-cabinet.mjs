// =====================================================================
// Local development cabinet: a private MQTT broker plus a simulated cabinet
// that behaves like firmware/esp32_smart_umbrella.ino (status, "got it",
// results and the retained slot report). Nothing leaves this computer.
//
//   npm run dev:cabinet
//
// Then set in .env.local:
//   HIVEMQ_BROKER_URL=ws://localhost:18884/mqtt
//
// Never point a local app at broker.hivemq.com: the topic names are the
// real cabinet's, so a local borrow would open a real lock.
//
// Keys (type a key, then Enter):
//   n      next BORROW is not taken          (FAIL / NOT_TAKEN)
//   e      next RETURN finds no umbrella     (FAIL / NO_UMBRELLA)
//   w      next RETURN has the wrong one     (FAIL / WRONG_UMBRELLA)
//   s      next command gets "got it" but no result (server times out)
//   x      next command gets no "got it"     (server treats cabinet as offline)
//   o      cabinet goes offline / comes back online
//   t1-t4  someone takes the umbrella from a slot by hand
//   r1-r4  someone puts the umbrella back in a slot by hand
//   p      print the slots
// =====================================================================
import net from 'net';
import http from 'http';
import readline from 'readline';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { WebSocketServer, createWebSocketStream } = require('ws');
const aedesModule = require('aedes');
const mqtt = require('mqtt');

const TCP_PORT = Number(process.env.DEV_MQTT_TCP_PORT || 18830);
const WS_PORT = Number(process.env.DEV_MQTT_WS_PORT || 18884);
const STEP_MS = Number(process.env.DEV_CABINET_STEP_MS || 3000); // how long a borrow/return takes

const TOPIC = {
  command: 'astrix-umbrella/cabinet/command',
  response: 'astrix-umbrella/cabinet/response',
  slots: 'astrix-umbrella/cabinet/slots',
  ack: 'astrix-umbrella/cabinet/ack',
  status: 'astrix-umbrella/cabinet/status',
};

// ---------------- Broker ----------------
const broker = aedesModule.createBroker ? await aedesModule.createBroker() : aedesModule();
net.createServer(broker.handle).listen(TCP_PORT);
const httpServer = http.createServer();
new WebSocketServer({ server: httpServer, path: '/mqtt' }).on('connection', (ws) =>
  broker.handle(createWebSocketStream(ws))
);
httpServer.listen(WS_PORT);
console.log(`🧪 Local MQTT broker: mqtt://localhost:${TCP_PORT}  ws://localhost:${WS_PORT}/mqtt`);

// ---------------- Simulated cabinet ----------------
// docked: dock button pressed; umbrella: tag number read in the slot (null = none)
const slots = [1, 2, 3, 4].map((slot) => ({ slot, busy: false, docked: true, umbrella: slot, locked: true }));
let next = null; // one-shot outcome for the next command: n | e | w | s | x
let online = true;
let cabinet = null;

const say = (topic, payload, retain = false) => cabinet?.publish(topic, JSON.stringify(payload), { retain });
const publishSlots = () =>
  say(TOPIC.slots, { slots: slots.map((s) => ({ ...s, unlocked_s: 0 })) }, true);

function connectCabinet() {
  cabinet = mqtt.connect(`mqtt://localhost:${TCP_PORT}`, {
    clientId: `astrix-dev-cabinet-${Date.now()}`,
    will: { topic: TOPIC.status, payload: JSON.stringify({ online: false }), retain: true, qos: 0 },
  });
  cabinet.on('connect', () => {
    cabinet.subscribe(TOPIC.command);
    say(TOPIC.status, { online: true, ack: true }, true);
    publishSlots();
    console.log('🗄️  Simulated cabinet online (4 umbrellas docked)');
  });
  cabinet.on('message', (_topic, raw) => handleCommand(raw.toString()));
}

function handleCommand(raw) {
  let cmd;
  try {
    cmd = JSON.parse(raw);
  } catch {
    return;
  }
  const action = String(cmd.action || '').toUpperCase();
  const s = slots[Number(cmd.slot) - 1];
  if (!s || !['BORROW', 'RETURN', 'OPEN', 'CLOSE'].includes(action)) return;
  console.log(`📥 ${action} slot ${s.slot}`);

  const outcome = next;
  next = null;
  if (outcome === 'x') return console.log('   (no "got it" sent, as asked)');
  if (s.busy) return say(TOPIC.ack, { action, slot: s.slot, accepted: false, reason: 'BUSY' });
  say(TOPIC.ack, { action, slot: s.slot, accepted: true });

  if (action === 'OPEN' || action === 'CLOSE') {
    s.locked = action === 'CLOSE';
    publishSlots();
    return say(TOPIC.response, { action, slot: s.slot, status: 'SUCCESS', message: action === 'OPEN' ? 'Lock opened.' : 'Lock closed.' });
  }

  s.busy = true;
  s.locked = false;
  publishSlots();
  setTimeout(() => {
    s.busy = false;
    s.locked = true;
    let result;
    if (action === 'BORROW') {
      if (outcome === 'n') {
        result = { status: 'FAIL', reason: 'NOT_TAKEN', message: `Umbrella was NOT taken from Slot ${s.slot} after 7 checks. The lock is closed.` };
      } else {
        s.docked = false;
        s.umbrella = null;
        result = { status: 'SUCCESS', message: `Umbrella taken from Slot ${s.slot}. Closing the lock.` };
      }
    } else if (outcome === 'e') {
      result = { status: 'FAIL', reason: 'NO_UMBRELLA', message: `No umbrella returned to Slot ${s.slot} after 7 checks. The lock is closed.` };
    } else if (outcome === 'w') {
      s.locked = false;
      s.docked = true;
      s.umbrella = (s.slot % 4) + 1;
      result = { status: 'FAIL', reason: 'WRONG_UMBRELLA', message: `Wrong umbrella in Slot ${s.slot}. Leaving the slot UNLOCKED - take it out and return Umbrella ${s.slot}.` };
    } else {
      s.docked = true;
      s.umbrella = s.slot;
      result = { status: 'SUCCESS', message: `Umbrella ${s.slot} returned to Slot ${s.slot}. Closing the lock.` };
    }
    publishSlots();
    if (outcome === 's') return console.log('   (result not sent, as asked)');
    say(TOPIC.response, { action, slot: s.slot, ...result });
    console.log(`📤 ${action} slot ${s.slot}: ${result.status}${result.reason ? ` ${result.reason}` : ''}`);
  }, STEP_MS);
}

connectCabinet();

// ---------------- Keyboard ----------------
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const key = line.trim().toLowerCase();
  const slot = slots[Number(key.slice(1)) - 1];
  if (['n', 'e', 'w', 's', 'x'].includes(key)) {
    next = key;
    console.log(`⏭️  Next command: ${{ n: 'NOT_TAKEN', e: 'NO_UMBRELLA', w: 'WRONG_UMBRELLA', s: 'no result', x: 'no "got it"' }[key]}`);
  } else if (key === 'o') {
    online = !online;
    if (online) {
      connectCabinet();
    } else {
      cabinet.stream.destroy(); // drop without saying goodbye, so the broker sends the last will
      cabinet.end(true);
      console.log('🔌 Simulated cabinet offline');
    }
  } else if (slot && key[0] === 't') {
    Object.assign(slot, { docked: false, umbrella: null });
    publishSlots();
    console.log(`✋ Umbrella taken by hand from slot ${slot.slot}`);
  } else if (slot && key[0] === 'r') {
    Object.assign(slot, { docked: true, umbrella: slot.slot });
    publishSlots();
    console.log(`↩️  Umbrella ${slot.slot} put back by hand`);
  } else if (key === 'p') {
    console.table(slots);
  }
});
