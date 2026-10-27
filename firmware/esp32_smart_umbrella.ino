/*
 * =====================================================================
 * Project ASTRIX — ESP32-S3 Umbrella Cabinet Firmware
 * University of Moratuwa (UoM)
 *
 * All 4 slots run at the same time: each slot has its own job
 * (opening -> checking -> reading tag -> locking) that loop() moves
 * forward a little at a time, so the cabinet never sits waiting and
 * keeps reading MQTT while slots are busy.
 *
 * Hardware (pins verified on the assembled cabinet):
 *   - 4x servo locks       GPIO 4, 5, 6, 7    (LEDC channels 0-3)
 *   - 4x push buttons      GPIO 1, 2, 8, 9    (pressed while an umbrella is docked)
 *   - 4x RC522 RFID        SDA/SS 15, 16, 17, 18
 *                          shared SCK 11, MOSI 12, MISO 13, RST 14
 *   - 4x WS2812B strips    GPIO 39, 40, 41, 42 (6 LEDs each, one per slot)
 *                          green = borrow, blue = return, red = error
 *   Power the servos from a separate 5 V supply (shared GND): up to 4 can move at once.
 *   Power the LED strips from 5 V too (up to ~1.5 A at full white), shared GND.
 *
 * MQTT:
 *   - Subscribe: astrix-umbrella/cabinet/command   {"action":"BORROW"|"RETURN","slot":1-4}
 *   - Publish:   astrix-umbrella/cabinet/response  (5 standard responses, QoS 0)
 *   - Publish:   astrix-umbrella/cabinet/slots     (retained: what is in each slot, lock state, so the website can sync)
 *   - Publish:   astrix-umbrella/cabinet/ack       ("got it" the moment a command arrives)
 *   - Publish:   astrix-umbrella/cabinet/status    (retained online/offline; offline is the MQTT last will)
 *
 * Libraries: PubSubClient (Nick O'Leary), ArduinoJson 7, MFRC522 (GithubCommunity),
 *            Adafruit NeoPixel
 *
 * Note: servos are driven with raw LEDC on explicit channels. ESP32Servo assigns
 * channels 8 and 9 to the 3rd and 4th servo on the ESP32-S3 (which only has 0-7),
 * so motors 3/4 mirrored motors 1/2. Don't switch back to ESP32Servo.
 *
 * The previous one-slot-at-a-time version is tagged v1.0-serial-cabinet.
 * =====================================================================
 */

#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <SPI.h>
#include <MFRC522.h>
#include <Adafruit_NeoPixel.h>
#include <esp_arduino_version.h>

// ===== WiFi - type your WiFi name and password between the quotes =====
// (do this in a copy outside the repo folder so the real values are never committed)
const char* WIFI_SSID     = "";
const char* WIFI_PASSWORD = "";

// ===== MQTT broker =====
// Public test broker by default. For real use, switch to a private broker
// (e.g. HiveMQ Cloud) and fill in the username/password below.
const char* MQTT_BROKER    = "broker.hivemq.com";
const int   MQTT_PORT      = 1883;
const char* MQTT_USER      = ""; // leave empty for the public broker
const char* MQTT_PASS      = "";
const char* MQTT_CLIENT_ID = "astrix-umbrella-esp32"; // must be unique on the broker
const char* COMMAND_TOPIC  = "astrix-umbrella/cabinet/command";  // HiveMQ -> ESP32
const char* RESPONSE_TOPIC = "astrix-umbrella/cabinet/response"; // ESP32 -> HiveMQ
const char* SLOTS_TOPIC    = "astrix-umbrella/cabinet/slots";    // ESP32 -> HiveMQ: what is in each slot (retained)
const char* ACK_TOPIC      = "astrix-umbrella/cabinet/ack";      // ESP32 -> HiveMQ: "got it" for each command
const char* STATUS_TOPIC   = "astrix-umbrella/cabinet/status";   // ESP32 -> HiveMQ: online/offline (retained)
const char* STATUS_ONLINE  = "{\"online\":true,\"ack\":true}";
const char* STATUS_OFFLINE = "{\"online\":false}";               // sent by the broker if the cabinet drops off

WiFiClient wifiClient;
PubSubClient mqtt(wifiClient);

const int NUM_SLOTS = 4; // 4 buttons, 4 RFID readers, 4 locks

// Servo GPIO Pins (Lock 1 -> 4, Lock 2 -> 5, Lock 3 -> 6, Lock 4 -> 7)
// Each lock gets its own PWM channel (Lock 1 -> channel 0, etc.)
const int SERVO_PINS[NUM_SLOTS] = { 4, 5, 6, 7 };

// Servo PWM settings (50 Hz, 500-2400 us pulse = 0-180 degrees)
const int SERVO_FREQ     = 50;
const int SERVO_RES_BITS = 14;
const int SERVO_MIN_US   = 500;
const int SERVO_MAX_US   = 2400;

// Lock positions
const int LOCK_CLOSED = 180;
const int LOCK_OPEN   = 0;

// Push buttons (wired to GND, use INPUT_PULLUP) - pressed while an umbrella is in the slot
const int BUTTON_PINS[NUM_SLOTS] = { 1, 2, 8, 9 };

// RFID Pins - all 4 readers share SCK/MOSI/MISO and RST, each has its own SDA/SS
const int RFID_SS_PINS[NUM_SLOTS] = { 15, 16, 17, 18 };
const int RFID_RST_PIN = 14;
const int SPI_SCK      = 11;
const int SPI_MOSI     = 12;
const int SPI_MISO     = 13;

// RST is shared, so it is driven once in setup() instead of by each reader
MFRC522 readers[NUM_SLOTS] = {
  MFRC522(RFID_SS_PINS[0], MFRC522::UNUSED_PIN),
  MFRC522(RFID_SS_PINS[1], MFRC522::UNUSED_PIN),
  MFRC522(RFID_SS_PINS[2], MFRC522::UNUSED_PIN),
  MFRC522(RFID_SS_PINS[3], MFRC522::UNUSED_PIN)
};

// LED strips (WS2812B), one per slot: Slot 1 -> GPIO 39 ... Slot 4 -> GPIO 42
const int LED_PINS[NUM_SLOTS] = { 39, 40, 41, 42 };
const int LEDS_PER_STRIP      = 6;
const uint8_t LED_BRIGHTNESS  = 120; // 0-255; lower = less glare and current

Adafruit_NeoPixel strips[NUM_SLOTS] = {
  Adafruit_NeoPixel(LEDS_PER_STRIP, LED_PINS[0], NEO_GRB + NEO_KHZ800),
  Adafruit_NeoPixel(LEDS_PER_STRIP, LED_PINS[1], NEO_GRB + NEO_KHZ800),
  Adafruit_NeoPixel(LEDS_PER_STRIP, LED_PINS[2], NEO_GRB + NEO_KHZ800),
  Adafruit_NeoPixel(LEDS_PER_STRIP, LED_PINS[3], NEO_GRB + NEO_KHZ800)
};

// Umbrella tags (Umbrella 1 belongs in Slot 1, etc.) - must match the umbrellas table
const char* UMBRELLA_UIDS[NUM_SLOTS] = {
  "53 01 B8 CC 33 00 01", // Umbrella 1
  "53 07 B8 CC 33 00 01", // Umbrella 2
  "53 08 B8 CC 33 00 01", // Umbrella 3
  "53 09 B8 CC 33 00 01"  // Umbrella 4
};

// Results from tag reads besides an umbrella number (0-3)
const int NO_TAG      = -1;
const int UNKNOWN_TAG = -2;

// Timing
const int BORROW_CHECKS           = 7;    // how many times to check if the umbrella was taken
const int RETURN_CHECKS           = 7;    // how many times to check if the umbrella was put back
// Checks with the lock fully open. After these the lock starts closing and the rest
// run while it closes, the last one once it is shut. The result is what is in the slot
// when it locks, so an umbrella taken or put back at the last moment still counts.
const int OPEN_CHECKS             = 5;
const unsigned long holdTime      = 2000; // button must stay pressed/unpressed this long before reading the tag
const unsigned long tagScanWindow = 500;  // keep trying to read the tag for this long
const unsigned long stepInterval  = 15;   // ms per 1 degree of servo movement
const unsigned long errorShowTime = 10000; // red stays on this long after NOT_TAKEN / NO_UMBRELLA

// Servo positions (moved 1 degree at a time by updateServos)
int currentPosition[NUM_SLOTS];
int targetPosition[NUM_SLOTS];
unsigned long lastStepTime[NUM_SLOTS];

// Outcome of a borrow/return, sent back over MQTT
struct Result {
  bool success;
  const char* reason; // only used when success is false
  String message;
};

// One job per slot
enum Phase { SLOT_IDLE, SLOT_OPENING, SLOT_CHECKING, SLOT_READING, SLOT_LOCKING };

struct SlotJob {
  Phase phase = SLOT_IDLE;
  bool isBorrow = false;
  int check = 0;                 // current check number (1-5)
  unsigned long windowStart = 0; // start of the current button window or tag read
  bool stayed = true;            // button stayed in the required state this window
  bool wrongUmbrella = false;    // last check found a wrong umbrella (returns only)
  int lastFound = -1;            // last tag result (umbrella 0-3, NO_TAG or UNKNOWN_TAG)
  String op;                     // operation id from the server, echoed in the ack and result
  bool reportWhenLocked = false; // a successful return is reported only once the lock has closed
};

SlotJob jobs[NUM_SLOTS];

// What is physically in each slot. Reported (retained) on SLOTS_TOPIC so the website
// can keep its database in step, e.g. after a return done at the cabinet with r1.
struct SlotState {
  bool docked = false;  // button pressed
  int umbrella = -1;    // umbrella 0-3 on the reader, NO_TAG or UNKNOWN_TAG
};

SlotState seen[NUM_SLOTS];
int lastButton[NUM_SLOTS];
unsigned long buttonChangedAt[NUM_SLOTS];
int tagCandidate[NUM_SLOTS];
int tagCandidateCount[NUM_SLOTS];
int nextTagSlot = 0;
unsigned long lastTagPoll = 0;
unsigned long lastSlotsPublish = 0;
bool reportedLocked[NUM_SLOTS];          // lock state in the last report
unsigned long unlockedSince[NUM_SLOTS];  // when each lock last opened (for the admin panel)

const unsigned long buttonSettleTime = 500;   // button must be steady this long to count
const unsigned long tagPollInterval  = 750;   // read one idle slot's tag every 0.75 s (each slot every ~3 s)
const unsigned long slotsRefresh     = 60000; // resend the slot state at least once a minute

// Light colour of each slot's strip, and how long it stays on (0 = until changed)
const uint32_t LIGHT_OFF   = 0x000000;
const uint32_t LIGHT_GREEN = 0x00FF00;
const uint32_t LIGHT_BLUE  = 0x0000FF;
const uint32_t LIGHT_RED   = 0xFF0000;
uint32_t lightColor[NUM_SLOTS];
unsigned long lightSince[NUM_SLOTS];
unsigned long lightFor[NUM_SLOTS];

// Command received over MQTT, run from loop() rather than inside the callback
String pendingCommand = "";
unsigned long lastMqttAttempt = 0;

// ===================== Servo =====================

// Connect lock i to its own PWM channel i
void servoAttach(int i) {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcAttachChannel(SERVO_PINS[i], SERVO_FREQ, SERVO_RES_BITS, i);
#else
  ledcSetup(i, SERVO_FREQ, SERVO_RES_BITS);
  ledcAttachPin(SERVO_PINS[i], i);
#endif
}

// Set lock i to an angle (0-180)
void servoWrite(int i, int angle) {
  uint32_t us = map(angle, 0, 180, SERVO_MIN_US, SERVO_MAX_US);
  uint32_t duty = us * ((1 << SERVO_RES_BITS) - 1) / 20000; // 20000 us = one 50 Hz period
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWrite(SERVO_PINS[i], duty);
#else
  ledcWrite(i, duty);
#endif
}

// Moves each servo 1 degree toward its target every stepInterval ms,
// so all locks can open and close at the same time
void updateServos() {
  unsigned long now = millis();
  for (int i = 0; i < NUM_SLOTS; i++) {
    if (currentPosition[i] != targetPosition[i] && (now - lastStepTime[i]) >= stepInterval) {
      currentPosition[i] += (targetPosition[i] > currentPosition[i]) ? 1 : -1;
      servoWrite(i, currentPosition[i]);
      lastStepTime[i] = now;
    }
  }
}

bool servoArrived(int i) {
  return currentPosition[i] == targetPosition[i];
}

// True when the lock is fully closed
bool lockClosed(int i) {
  return currentPosition[i] == LOCK_CLOSED && servoArrived(i);
}

bool anyServoMoving() {
  for (int i = 0; i < NUM_SLOTS; i++) {
    if (!servoArrived(i)) return true;
  }
  return false;
}

// ===================== LED strips =====================

// Light one slot's strip in a colour; showFor > 0 turns it off after that many ms (0 = stays on)
void setLight(int slot, uint32_t color, unsigned long showFor) {
  lightSince[slot] = millis();
  lightFor[slot] = showFor;
  if (color == lightColor[slot]) return;
  lightColor[slot] = color;
  strips[slot].fill(color);
  strips[slot].show();
}

// Turns off timed lights, and the wrong-umbrella red once its lock has closed
void updateLights() {
  unsigned long now = millis();
  for (int s = 0; s < NUM_SLOTS; s++) {
    if (lightColor[s] == LIGHT_OFF) continue;
    bool timedOut = lightFor[s] > 0 && now - lightSince[s] >= lightFor[s];
    bool wrongUmbrellaCleared = lightColor[s] == LIGHT_RED && lightFor[s] == 0 && lockClosed(s);
    if (timedOut || wrongUmbrellaCleared) setLight(s, LIGHT_OFF, 0);
  }
}

// ===================== RFID =====================

// Single attempt to read a tag on one reader; returns true and fills tagUID if found
bool tryReadCard(MFRC522 &rfid, String &tagUID) {
  // WakeupA also finds a tag that was halted after an earlier scan,
  // which matters here because the umbrella tag sits on the reader the whole time
  byte atqa[2];
  byte atqaSize = sizeof(atqa);
  bool present = rfid.PICC_IsNewCardPresent() ||
                 rfid.PICC_WakeupA(atqa, &atqaSize) == MFRC522::STATUS_OK;
  if (!present || !rfid.PICC_ReadCardSerial()) {
    return false;
  }

  tagUID = "";
  for (byte i = 0; i < rfid.uid.size; i++) {
    if (rfid.uid.uidByte[i] < 0x10) tagUID += "0";
    tagUID += String(rfid.uid.uidByte[i], HEX);
    tagUID += " ";
  }
  tagUID.trim();
  tagUID.toUpperCase();

  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
  return true;
}

// Which umbrella a tag belongs to: 0-3, or UNKNOWN_TAG
int umbrellaIndex(const String &tagUID) {
  for (int u = 0; u < NUM_SLOTS; u++) {
    if (tagUID == UMBRELLA_UIDS[u]) return u;
  }
  return UNKNOWN_TAG;
}

// ===================== Slot jobs =====================

void startCheck(int slot, int checkNumber) {
  SlotJob &job = jobs[slot];
  job.check = checkNumber;
  job.windowStart = millis();
  job.stayed = true;
  job.wrongUmbrella = false;
  job.phase = SLOT_CHECKING;
  Serial.printf("Slot %d check %d/%d...\n", slot + 1, checkNumber,
                job.isBorrow ? BORROW_CHECKS : RETURN_CHECKS);
}

// Decide the result, send it, then lock (or leave a wrong umbrella's slot open)
void finishJob(int slot, bool success) {
  SlotJob &job = jobs[slot];
  char msg[160];
  Result res;
  bool keepOpen = false;

  if (job.isBorrow) {
    if (success) {
      snprintf(msg, sizeof(msg), "Umbrella taken from Slot %d. Closing the lock.", slot + 1);
      res = { true, "", msg };
    } else {
      snprintf(msg, sizeof(msg), "Umbrella was NOT taken from Slot %d after %d checks. The lock is closed.",
               slot + 1, BORROW_CHECKS);
      res = { false, "NOT_TAKEN", msg };
    }
  } else if (success) {
    snprintf(msg, sizeof(msg), "Umbrella %d returned to Slot %d. Closing the lock.", slot + 1, slot + 1);
    res = { true, "", msg };
  } else if (job.wrongUmbrella) {
    // Leave it open so the wrong umbrella can be taken back out
    snprintf(msg, sizeof(msg), "Wrong umbrella in Slot %d. Leaving the slot UNLOCKED - take it out and return Umbrella %d.",
             slot + 1, slot + 1);
    res = { false, "WRONG_UMBRELLA", msg };
    keepOpen = true;
  } else {
    snprintf(msg, sizeof(msg), "No umbrella returned to Slot %d after %d checks. The lock is closed.",
             slot + 1, RETURN_CHECKS);
    res = { false, "NO_UMBRELLA", msg };
  }

  Serial.println(msg);

  // Success keeps green/blue until the lock closes; a failure turns the strip red.
  // A wrong umbrella stays red while the slot is left unlocked.
  if (!res.success) setLight(slot, LIGHT_RED, keepOpen ? 0 : errorShowTime);

  if (keepOpen) {
    targetPosition[slot] = LOCK_OPEN; // reopen if it closed during the last checks
    job.phase = SLOT_IDLE;
  } else {
    targetPosition[slot] = LOCK_CLOSED;
    job.phase = SLOT_LOCKING;
  }

  // A return only counts once the umbrella is locked in: report it from SLOT_LOCKING,
  // after checking it is still docked (it could be pulled out while the lock closes)
  if (!job.isBorrow && success) {
    job.reportWhenLocked = true;
    return;
  }

  // Update what is in the slot from the outcome, and report it BEFORE the result,
  // so the website never sees an old "umbrella is here" after it records a borrow
  if (job.isBorrow) {
    setSlotState(slot, !success, success ? NO_TAG : slot);
  } else if (success) {
    setSlotState(slot, true, slot);
  } else if (job.wrongUmbrella) {
    setSlotState(slot, true, job.lastFound);
  } else {
    setSlotState(slot, false, NO_TAG);
  }
  publishSlots();

  publishResult(job.isBorrow ? "BORROW" : "RETURN", slot + 1, res, job.op);
}

void nextCheck(int slot) {
  SlotJob &job = jobs[slot];
  int maxChecks = job.isBorrow ? BORROW_CHECKS : RETURN_CHECKS;

  // Out of checks, or a wrong umbrella still there once the open checks are over:
  // stop (finishJob leaves the slot open for a wrong umbrella)
  if (job.check >= maxChecks || (job.wrongUmbrella && job.check >= OPEN_CHECKS)) {
    finishJob(slot, false);
    return;
  }

  // Open checks are over: start closing the lock and keep checking while it closes
  if (job.check == OPEN_CHECKS) {
    targetPosition[slot] = LOCK_CLOSED;
    Serial.printf("  Slot %d: closing the lock, still checking...\n", slot + 1);
  }
  startCheck(slot, job.check + 1);
}

// Called with the tag result once a check's button window has passed
void evaluateTag(int slot, int found) {
  SlotJob &job = jobs[slot];
  job.lastFound = found;

  if (job.isBorrow) {
    if (found < 0) {
      finishJob(slot, true); // Button unpressed AND no umbrella tag -> umbrella is gone
      return;
    }
    Serial.printf("  Slot %d: button released, but the umbrella tag is still detected.\n", slot + 1);
  } else {
    if (found == slot) {
      finishJob(slot, true); // Right umbrella is in the slot
      return;
    }
    if (found == NO_TAG) {
      Serial.printf("  Slot %d: button pressed, but no umbrella tag detected.\n", slot + 1);
    } else if (found == UNKNOWN_TAG) {
      job.wrongUmbrella = true;
      Serial.printf("  Slot %d: wrong umbrella! This is not Umbrella %d.\n", slot + 1, slot + 1);
    } else {
      job.wrongUmbrella = true;
      Serial.printf("  Slot %d: wrong umbrella! This is Umbrella %d, but Slot %d takes Umbrella %d.\n",
                    slot + 1, found + 1, slot + 1, slot + 1);
    }
  }
  nextCheck(slot);
}

// The lock has closed after a successful return: confirm the umbrella is still docked, then report
void reportLockedReturn(int slot) {
  SlotJob &job = jobs[slot];
  job.reportWhenLocked = false;
  char msg[160];
  Result res;
  if (digitalRead(BUTTON_PINS[slot]) == LOW) {
    snprintf(msg, sizeof(msg), "Umbrella %d returned to Slot %d. The lock is closed.", slot + 1, slot + 1);
    res = { true, "", msg };
    setSlotState(slot, true, slot);
  } else {
    snprintf(msg, sizeof(msg), "Umbrella %d was taken out of Slot %d before the lock closed. The lock is closed.", slot + 1, slot + 1);
    res = { false, "NO_UMBRELLA", msg };
    setSlotState(slot, false, NO_TAG);
    setLight(slot, LIGHT_RED, errorShowTime);
  }
  Serial.println(msg);
  publishSlots();
  publishResult("RETURN", slot + 1, res, job.op);
}

// Moves one slot's job forward; never waits
void updateJob(int slot) {
  SlotJob &job = jobs[slot];
  unsigned long now = millis();

  switch (job.phase) {
    case SLOT_IDLE:
      return;

    case SLOT_OPENING:
      if (servoArrived(slot)) startCheck(slot, 1);
      return;

    case SLOT_CHECKING: {
      // The last check starts only once the lock has stopped moving (closed)
      int maxChecks = job.isBorrow ? BORROW_CHECKS : RETURN_CHECKS;
      if (job.check == maxChecks && !servoArrived(slot)) {
        job.windowStart = now;
        job.stayed = true;
        return;
      }

      // Borrow: button must stay released (umbrella gone). Return: must stay pressed.
      int required = job.isBorrow ? HIGH : LOW;
      if (digitalRead(BUTTON_PINS[slot]) != required) job.stayed = false;
      if (now - job.windowStart < holdTime) return;

      if (!job.stayed) {
        Serial.printf(job.isBorrow ? "  Slot %d: button still pressed - umbrella is still in the slot.\n"
                                   : "  Slot %d: no umbrella in the slot yet.\n",
                      slot + 1);
        nextCheck(slot);
        return;
      }
      // Button was right for the whole window: read the tag next
      job.phase = SLOT_READING;
      job.windowStart = now;
      return;
    }

    case SLOT_READING: {
      String tagUID;
      if (tryReadCard(readers[slot], tagUID)) {
        evaluateTag(slot, umbrellaIndex(tagUID));
      } else if (now - job.windowStart >= tagScanWindow) {
        evaluateTag(slot, NO_TAG);
      }
      return;
    }

    case SLOT_LOCKING:
      if (servoArrived(slot)) {
        if (job.reportWhenLocked) reportLockedReturn(slot);
        job.phase = SLOT_IDLE;
        if (lightColor[slot] != LIGHT_RED) setLight(slot, LIGHT_OFF, 0);
        Serial.printf("Slot %d locked.\n", slot + 1);
        publishSlots(); // slot is no longer busy
      }
      return;
  }
}

// ===================== Slot state (for website sync) =====================

// Set what is in a slot and restart its debounce from that value
void setSlotState(int slot, bool docked, int umbrella) {
  seen[slot].docked = docked;
  seen[slot].umbrella = umbrella;
  lastButton[slot] = digitalRead(BUTTON_PINS[slot]);
  buttonChangedAt[slot] = millis();
  tagCandidate[slot] = umbrella;
  tagCandidateCount[slot] = 2;
}

// Publishes {"slots":[{"slot":1,"busy":false,"docked":true,"umbrella":1},...]} as a retained message.
// umbrella is the umbrella number on the reader (1-4), 0 for an unknown tag, or null for no tag.
void publishSlots() {
  if (!mqtt.connected()) return; // sent again on the next change or refresh

  char payload[448];
  unsigned long now = millis();
  int n = snprintf(payload, sizeof(payload), "{\"slots\":[");
  for (int s = 0; s < NUM_SLOTS; s++) {
    bool locked = lockClosed(s);
    unsigned long unlockedSeconds = locked ? 0 : (now - unlockedSince[s]) / 1000;
    char umbrella[8];
    if (seen[s].umbrella >= 0) snprintf(umbrella, sizeof(umbrella), "%d", seen[s].umbrella + 1);
    else if (seen[s].umbrella == UNKNOWN_TAG) snprintf(umbrella, sizeof(umbrella), "0");
    else snprintf(umbrella, sizeof(umbrella), "null");

    n += snprintf(payload + n, sizeof(payload) - n,
                  "%s{\"slot\":%d,\"busy\":%s,\"docked\":%s,\"umbrella\":%s,\"locked\":%s,\"unlocked_s\":%lu}",
                  s > 0 ? "," : "", s + 1,
                  jobs[s].phase != SLOT_IDLE ? "true" : "false",
                  seen[s].docked ? "true" : "false",
                  umbrella,
                  locked ? "true" : "false",
                  unlockedSeconds);
  }
  snprintf(payload + n, sizeof(payload) - n, "]}");

  if (mqtt.publish(SLOTS_TOPIC, payload, true)) {
    lastSlotsPublish = millis();
    Serial.printf("Slot state sent: %s\n", payload);
  }
}

// Watches the button and tag of every idle slot, and reports changes.
// Catches umbrellas taken or put back outside the website (Serial b1/r1, or by hand).
void watchIdleSlots() {
  unsigned long now = millis();
  bool changed = false;

  // Report every lock opening/closing (the admin panel flags slots left unlocked)
  for (int s = 0; s < NUM_SLOTS; s++) {
    bool locked = lockClosed(s);
    if (locked != reportedLocked[s]) {
      reportedLocked[s] = locked;
      if (!locked) unlockedSince[s] = now;
      changed = true;
    }
  }

  for (int s = 0; s < NUM_SLOTS; s++) {
    if (jobs[s].phase != SLOT_IDLE) continue;
    int button = digitalRead(BUTTON_PINS[s]);
    if (button != lastButton[s]) {
      lastButton[s] = button;
      buttonChangedAt[s] = now;
    } else if (now - buttonChangedAt[s] >= buttonSettleTime) {
      bool docked = (button == LOW);
      if (docked != seen[s].docked) {
        seen[s].docked = docked;
        changed = true;
      }
    }
  }

  // Read one idle slot's tag at a time, and not while a lock is moving (keeps the motors smooth)
  if (now - lastTagPoll >= tagPollInterval && !anyServoMoving()) {
    lastTagPoll = now;
    int s = nextTagSlot;
    nextTagSlot = (nextTagSlot + 1) % NUM_SLOTS;
    if (jobs[s].phase == SLOT_IDLE) {
      String tagUID;
      int found = tryReadCard(readers[s], tagUID) ? umbrellaIndex(tagUID) : NO_TAG;
      // One missed read is normal, so only believe the same result twice in a row
      if (found == tagCandidate[s]) {
        tagCandidateCount[s]++;
      } else {
        tagCandidate[s] = found;
        tagCandidateCount[s] = 1;
      }
      if (tagCandidateCount[s] >= 2 && found != seen[s].umbrella) {
        seen[s].umbrella = found;
        changed = true;
      }
    }
  }

  if (now - lastSlotsPublish >= slotsRefresh) publishStatus(); // keep "online" fresh too
  if (changed || now - lastSlotsPublish >= slotsRefresh) publishSlots();
}

// Start a borrow/return on one slot; other slots keep running
void startJob(int slot, bool isBorrow, const String &op) {
  SlotJob &job = jobs[slot];
  if (job.phase != SLOT_IDLE) {
    Serial.printf("Ignored: Slot %d is already busy.\n", slot + 1);
    return;
  }
  job = SlotJob();
  job.isBorrow = isBorrow;
  job.op = op;
  job.phase = SLOT_OPENING;
  targetPosition[slot] = LOCK_OPEN;
  setLight(slot, isBorrow ? LIGHT_GREEN : LIGHT_BLUE, 0);
  Serial.printf("=== %s Slot %d === Unlocking...\n", isBorrow ? "Borrow from" : "Return to", slot + 1);
}

// ===================== WiFi & MQTT =====================

void connectWiFi() {
  Serial.printf("Connecting to WiFi \"%s\"", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - start) < 20000) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("WiFi connected. IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("WiFi NOT connected - check the name/password. Will keep retrying in the background.");
  }
}

void connectMqtt() {
  Serial.print("Connecting to MQTT broker... ");
  // The "last will": if the cabinet drops off without saying goodbye, the broker
  // publishes STATUS_OFFLINE for it, so the website knows not to send commands
  const char* user = strlen(MQTT_USER) > 0 ? MQTT_USER : nullptr;
  const char* pass = strlen(MQTT_USER) > 0 ? MQTT_PASS : nullptr;
  bool connected = mqtt.connect(MQTT_CLIENT_ID, user, pass, STATUS_TOPIC, 0, true, STATUS_OFFLINE);
  if (connected) {
    Serial.println("connected.");
    mqtt.subscribe(COMMAND_TOPIC);
    Serial.printf("Subscribed to %s\n", COMMAND_TOPIC);
    publishStatus(); // tell the website the cabinet is online
    publishSlots();  // refresh the retained slot state after (re)connecting
  } else {
    Serial.printf("failed (state %d). Retrying in 5 seconds.\n", mqtt.state());
  }
}

// Called by PubSubClient when a message arrives - just store it for loop()
void onMqttMessage(char* topic, byte* payload, unsigned int length) {
  pendingCommand = "";
  for (unsigned int i = 0; i < length; i++) {
    pendingCommand += (char)payload[i];
  }
}

// Publishes one of the 5 standard responses (QoS 0)
void publishResult(const char* action, int slotNumber, const Result &res, const String &op) {
  JsonDocument doc;
  doc["action"] = action;
  doc["slot"] = slotNumber;
  if (op.length() > 0) doc["op"] = op;
  doc["status"] = res.success ? "SUCCESS" : "FAIL";
  if (!res.success) doc["reason"] = res.reason;
  doc["message"] = res.message;

  char payload[512];
  serializeJson(doc, payload, sizeof(payload));

  if (!mqtt.connected()) connectMqtt();
  if (mqtt.publish(RESPONSE_TOPIC, payload)) {
    Serial.printf("Sent to %s: %s\n", RESPONSE_TOPIC, payload);
  } else {
    Serial.println("Could not send the response over MQTT.");
  }
}

// Retained "online" message (refreshed with the slot state, in case the broker drops it)
void publishStatus() {
  if (mqtt.connected()) mqtt.publish(STATUS_TOPIC, STATUS_ONLINE, true);
}

// "Got it" for a command, sent the moment it arrives. accepted=false means the slot is busy.
void publishAck(const String &action, int slotNumber, bool accepted, const String &op) {
  if (!mqtt.connected()) return;
  JsonDocument doc;
  doc["action"] = action;
  doc["slot"] = slotNumber;
  if (op.length() > 0) doc["op"] = op;
  doc["accepted"] = accepted;
  if (!accepted) doc["reason"] = "BUSY";
  char payload[160];
  serializeJson(doc, payload, sizeof(payload));
  mqtt.publish(ACK_TOPIC, payload);
}

// Check the action and slot, confirm the command, then start the job.
// Invalid commands are only logged here - the response topic only carries standard responses.
void runAction(String action, int slotNumber, const String &op) {
  action.toUpperCase();

  if (slotNumber < 1 || slotNumber > NUM_SLOTS) {
    Serial.println("Ignored: slot must be 1, 2, 3 or 4.");
    return;
  }

  if (action != "BORROW" && action != "RETURN" && action != "OPEN" && action != "CLOSE") {
    Serial.println("Ignored: action must be BORROW, RETURN, OPEN, or CLOSE.");
    return;
  }

  // A borrow/return can't start on a slot that is already busy
  bool busy = (action == "BORROW" || action == "RETURN") && jobs[slotNumber - 1].phase != SLOT_IDLE;
  publishAck(action, slotNumber, !busy, op);
  if (busy) {
    Serial.printf("Ignored: Slot %d is already busy.\n", slotNumber);
    return;
  }

  // Developer Direct Lock Controls
  if (action == "OPEN") {
    targetPosition[slotNumber - 1] = LOCK_OPEN;
    Serial.printf("=== Developer Command: Opened Lock on Slot %d ===\n", slotNumber);
    Result res = { true, "", "Lock opened." };
    publishResult("OPEN", slotNumber, res, op);
    return;
  }
  if (action == "CLOSE") {
    targetPosition[slotNumber - 1] = LOCK_CLOSED;
    Serial.printf("=== Developer Command: Closed Lock on Slot %d ===\n", slotNumber);
    Result res = { true, "", "Lock closed." };
    publishResult("CLOSE", slotNumber, res, op);
    return;
  }

  startJob(slotNumber - 1, action == "BORROW", op);
}

// Parse a JSON command like {"action": "BORROW", "slot": 1, "op": "3f9a1c2e"}
// (op is optional: older servers don't send it)
void handleCommand(const String &json) {
  Serial.print("MQTT command received: ");
  Serial.println(json);

  JsonDocument doc;
  if (deserializeJson(doc, json)) {
    Serial.println("Ignored: command is not valid JSON.");
    return;
  }

  String action = doc["action"] | "";
  int slotNumber = doc["slot"].as<int>();
  String op = doc["op"] | "";
  if (op.length() > 16) op = op.substring(0, 16);
  runAction(action, slotNumber, op);
}

// ===================== Setup & Loop =====================

void setup() {
  Serial.begin(115200);

  for (int i = 0; i < NUM_SLOTS; i++) {
    // Servo Setup - every lock starts closed
    servoAttach(i);
    currentPosition[i] = LOCK_CLOSED;
    targetPosition[i] = LOCK_CLOSED;
    lastStepTime[i] = 0;
    servoWrite(i, LOCK_CLOSED);

    // Configure switch pin to use internal pull-up resistor
    pinMode(BUTTON_PINS[i], INPUT_PULLUP);

    // Start the slot watcher from the button; the tag is read within a few seconds
    lastButton[i] = digitalRead(BUTTON_PINS[i]);
    buttonChangedAt[i] = millis();
    seen[i].docked = (lastButton[i] == LOW);
    seen[i].umbrella = NO_TAG;
    tagCandidate[i] = NO_TAG;
    tagCandidateCount[i] = 0;
    reportedLocked[i] = true;
    unlockedSince[i] = 0;
  }

  // LED strips: flash green, blue, red once so the wiring can be checked, then off
  for (int i = 0; i < NUM_SLOTS; i++) {
    strips[i].begin();
    strips[i].setBrightness(LED_BRIGHTNESS);
    lightColor[i] = LIGHT_OFF;
    lightSince[i] = 0;
    lightFor[i] = 0;
  }
  const uint32_t testColors[] = { LIGHT_GREEN, LIGHT_BLUE, LIGHT_RED, LIGHT_OFF };
  for (uint32_t color : testColors) {
    for (int i = 0; i < NUM_SLOTS; i++) {
      strips[i].fill(color);
      strips[i].show();
    }
    delay(300);
  }

  // Deselect every reader before using SPI, so they don't talk over each other
  for (int r = 0; r < NUM_SLOTS; r++) {
    pinMode(RFID_SS_PINS[r], OUTPUT);
    digitalWrite(RFID_SS_PINS[r], HIGH);
  }

  // Hardware reset all 4 readers at once through the shared RST pin
  pinMode(RFID_RST_PIN, OUTPUT);
  digitalWrite(RFID_RST_PIN, LOW);
  delay(10);
  digitalWrite(RFID_RST_PIN, HIGH);
  delay(50);

  // RFID Setup
  SPI.begin(SPI_SCK, SPI_MISO, SPI_MOSI);
  for (int r = 0; r < NUM_SLOTS; r++) {
    readers[r].PCD_Init();
  }

  // WiFi & MQTT Setup
  connectWiFi();
  mqtt.setServer(MQTT_BROKER, MQTT_PORT);
  mqtt.setCallback(onMqttMessage);
  mqtt.setBufferSize(512);
  mqtt.setKeepAlive(15); // loop() never waits, so a short keep-alive is safe; the broker notices a drop in ~20 s
  if (WiFi.status() == WL_CONNECTED) connectMqtt();
  lastMqttAttempt = millis();

  Serial.println("System Ready. Send a command over MQTT, or type b1-b4 / r1-r4 here.");
}

void loop() {
  // Keep the MQTT connection up
  if (WiFi.status() == WL_CONNECTED && !mqtt.connected() && (millis() - lastMqttAttempt) >= 5000) {
    lastMqttAttempt = millis();
    connectMqtt();
  }
  mqtt.loop();

  // Start a command that arrived over MQTT (slots that are already busy keep running)
  if (pendingCommand.length() > 0) {
    String cmd = pendingCommand;
    pendingCommand = "";
    handleCommand(cmd);
  }

  // For testing: type b1-b4 to borrow or r1-r4 to return
  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    cmd.toLowerCase();
    if (cmd.length() == 2 && cmd[1] >= '1' && cmd[1] <= '4') {
      if (cmd[0] == 'b') runAction("BORROW", cmd[1] - '0', "");
      else if (cmd[0] == 'r') runAction("RETURN", cmd[1] - '0', "");
    }
  }

  // Move every slot's job and lock forward a little
  for (int s = 0; s < NUM_SLOTS; s++) {
    updateJob(s);
  }
  updateServos();
  updateLights();

  // Report what is in each idle slot so the website stays in step
  watchIdleSlots();
}
