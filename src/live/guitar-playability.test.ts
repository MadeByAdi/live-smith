import assert from "node:assert/strict";
import test from "node:test";
import { analyzeGuitarPlayability, fretMappingsForPitch, STANDARD_GUITAR_OPEN_PITCHES } from "./guitar-playability.js";

const report = (notes: Array<{ pitch: number; startTime: number; duration: number }>, maxFretSpan?: number) => analyzeGuitarPlayability({ notes, ...(maxFretSpan === undefined ? {} : { maxFretSpan }) });

test("fretboard maps six open strings, repeated pitches, and declared range boundaries", () => {
  assert.deepEqual(STANDARD_GUITAR_OPEN_PITCHES, [40, 45, 50, 55, 59, 64]);
  for (const pitch of STANDARD_GUITAR_OPEN_PITCHES) assert.ok(fretMappingsForPitch(pitch).some((item) => item.fret === 0));
  assert.ok(fretMappingsForPitch(64).length > 1);
  assert.deepEqual(fretMappingsForPitch(40), [{ noteIndex: -1, string: 6, fret: 0 }]);
  assert.ok(fretMappingsForPitch(88).some((item) => item.string === 1 && item.fret === 24));
  assert.deepEqual(fretMappingsForPitch(39), []);
  assert.deepEqual(fretMappingsForPitch(89), []);
});

test("guitar playability requires an explicit span and surfaces assumptions without realism claims", () => {
  const missing = report([{ pitch: 60, startTime: 0, duration: 1 }]);
  assert.equal(missing.verdict, "UNKNOWN");
  assert.match(missing.reasons[0] ?? "", /maxFretSpan/i);
  const result = report([{ pitch: 52, startTime: 0, duration: 1 }, { pitch: 55, startTime: 0, duration: 1 }, { pitch: 59, startTime: 0, duration: 1 }], 4);
  assert.equal(result.verdict, "POSSIBLE");
  assert.equal(result.assumptions.maxFretSpan, 4);
  assert.doesNotMatch(result.reasons.join(" "), /comfortable|idiomatic|realistic/i);
});

test("guitar playability rejects physical contradictions and honors open-string span exclusion", () => {
  assert.equal(report(Array.from({ length: 7 }, (_, index) => ({ pitch: 40 + index, startTime: 0, duration: 1 })), 24).verdict, "IMPOSSIBLE");
  assert.equal(report([{ pitch: 40, startTime: 0, duration: 1 }, { pitch: 64, startTime: 0, duration: 1 }], 0).verdict, "POSSIBLE");
  assert.equal(report([{ pitch: 41, startTime: 0, duration: 1 }, { pitch: 67, startTime: 0, duration: 1 }], 0).verdict, "IMPOSSIBLE");
  assert.equal(report([{ pitch: 39, startTime: 0, duration: 1 }], 4).verdict, "IMPOSSIBLE");
});

test("guitar playability searches sustained assignments with half-open reuse", () => {
  assert.equal(report([{ pitch: 64, startTime: 0, duration: 2 }, { pitch: 64, startTime: 1, duration: 1 }], 24).verdict, "POSSIBLE");
  assert.equal(report([{ pitch: 40, startTime: 0, duration: 1 }, { pitch: 40, startTime: 1, duration: 1 }], 0).verdict, "POSSIBLE");
  assert.equal(report([{ pitch: 40, startTime: 0, duration: 2 }, { pitch: 40, startTime: 1, duration: 1 }], 0).verdict, "IMPOSSIBLE");
});
