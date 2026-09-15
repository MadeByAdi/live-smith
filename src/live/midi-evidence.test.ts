import assert from "node:assert/strict";
import test from "node:test";

import { MAX_MIDI_EVIDENCE_NOTES, analyzeMidiEvidence } from "./midi-evidence.js";

const source = {
  trackHandleId: "track-1",
  clipHandleId: "clip-1",
  trackLabel: "Labels are not musical evidence",
  clipLabel: "Phrase",
  location: "arrangement" as const,
  clip: {
    startBeat: 8,
    endBeat: 12,
    durationBeats: 4,
    startMarkerBeat: 0,
    endMarkerBeat: 4,
    looping: true,
    loopStartBeat: 0,
    loopEndBeat: 4,
    muted: false,
  },
  grid: { quantization: 7, isTriplet: false },
};

test("analyzeMidiEvidence reports deterministic metrics for a polyphonic MIDI clip", () => {
  const report = analyzeMidiEvidence({
    ...source,
    notes: [
      { pitch: 60, startTime: 0, duration: 2, velocity: 80 },
      { pitch: 64, startTime: 0, duration: 1, velocity: 100, probability: 0.5 },
      { pitch: 67, startTime: 1, duration: 1, velocity: 100, velocityDeviation: -4 },
      { pitch: 60, startTime: 3, duration: 1, releaseVelocity: 64 },
    ],
  });

  assert.equal(report.notes.count.value, 4);
  assert.deepEqual(report.notes.pitch.value, { uniqueCount: 3, lowest: 60, highest: 67, span: 7 });
  assert.deepEqual(report.notes.onsets.value?.positionsBeats, [0, 1, 3]);
  assert.deepEqual(report.notes.onsets.value?.interOnsetIntervalsBeats, [1, 2]);
  assert.equal(report.notes.density.value?.notesPerClipBeat, 1);
  assert.equal(report.notes.occupancy.value?.maxSimultaneous, 2);
  assert.deepEqual(report.notes.occupancy.value?.overlapIntervalsBeats, [[0, 1], [1, 2]]);
  assert.deepEqual(report.notes.velocity.value, { presentCount: 3, missingCount: 1, min: 80, max: 100, mean: 280 / 3, median: 100, repeatedValues: [100] });
  assert.equal(report.notes.probability.value?.presentCount, 1);
  assert.equal(report.notes.probability.value?.missingCount, 3);
  assert.equal(report.grid.deviation.category, "DERIVED");
  assert.equal(report.notes.occupancy.category, "DERIVED");
  assert.equal(report.notes.occupancy.source, "live-sdk");
  assert.equal(report.notes.occupancy.units, "beats");
  assert.equal(report.notes.occupancy.derivation, "half-open interval sweep");
});

test("analyzeMidiEvidence keeps absent velocity absent rather than defaulting it to 100", () => {
  const report = analyzeMidiEvidence({
    ...source,
    notes: [{ pitch: 60, startTime: 0, duration: 1 }],
  });

  assert.deepEqual(report.notes.velocity.value, { presentCount: 0, missingCount: 1 });
  assert.equal(report.notes.velocity.category, "UNKNOWN");
});

test("analyzeMidiEvidence returns valid UNKNOWN aggregates for an empty MIDI clip", () => {
  const report = analyzeMidiEvidence({ ...source, notes: [] });

  assert.equal(report.notes.count.value, 0);
  assert.equal(report.notes.pitch.category, "UNKNOWN");
  assert.equal(report.notes.duration.category, "UNKNOWN");
  assert.equal(report.notes.velocity.category, "UNKNOWN");
  assert.equal(report.notes.occupancy.value?.maxSimultaneous, 0);
});

test("analyzeMidiEvidence uses half-open intervals for occupancy and gaps", () => {
  const report = analyzeMidiEvidence({
    ...source,
    notes: [
      { pitch: 60, startTime: 0, duration: 1, velocity: 80 },
      { pitch: 62, startTime: 1, duration: 1, velocity: 80 },
      { pitch: 64, startTime: 3, duration: 1, velocity: 80 },
    ],
  });

  assert.equal(report.notes.occupancy.value?.maxSimultaneous, 1);
  assert.deepEqual(report.notes.occupancy.value?.monophonicIntervalsBeats, [[0, 1], [1, 2], [3, 4]]);
  assert.deepEqual(report.notes.occupancy.value?.silentGapIntervalsBeats, [[2, 3]]);
  assert.deepEqual(report.notes.occupancy.value?.overlapIntervalsBeats, []);
});

test("analyzeMidiEvidence computes exact durations, medians, optional fields, and repetition", () => {
  const report = analyzeMidiEvidence({
    ...source,
    notes: [
      { pitch: 60, startTime: 0, duration: 1, velocity: 90, muted: true, probability: 0.25, velocityDeviation: -2, releaseVelocity: 64 },
      { pitch: 60, startTime: 2, duration: 1, velocity: 90, muted: false, probability: 0.75, velocityDeviation: 2, releaseVelocity: 64 },
      { pitch: 67, startTime: 4, duration: 3, velocity: 110 },
      { pitch: 67, startTime: 7, duration: 3, velocity: 110 },
    ],
  });

  assert.deepEqual(report.notes.duration.value, { min: 1, max: 3, mean: 2, median: 2, repeatedValues: [1, 3] });
  assert.deepEqual(report.notes.repetition.value, { exactEventSignatureGroups: 2, exactOnsetGroupSignatureGroups: 2 });
  assert.deepEqual(report.notes.probability.value, { presentCount: 2, missingCount: 2, min: 0.25, max: 0.75, mean: 0.5, median: 0.5 });
  assert.deepEqual(report.notes.velocityDeviation.value, { presentCount: 2, missingCount: 2, min: -2, max: 2, mean: 0, median: 0 });
  assert.deepEqual(report.notes.releaseVelocity.value, { presentCount: 2, missingCount: 2, min: 64, max: 64, mean: 64, median: 64 });
});

test("analyzeMidiEvidence reports UNKNOWN grid deviation for NoGrid", () => {
  const report = analyzeMidiEvidence({
    ...source,
    grid: { quantization: 0, isTriplet: false },
    notes: [{ pitch: 60, startTime: 0.1, duration: 1, velocity: 100 }],
  });

  assert.equal(report.grid.deviation.category, "UNKNOWN");
  assert.match(report.grid.deviation.unavailableReason ?? "", /NoGrid/);
});

test("analyzeMidiEvidence rejects malformed notes and input beyond its complete-analysis bound", () => {
  assert.throws(
    () => analyzeMidiEvidence({ ...source, notes: [{ pitch: 128, startTime: 0, duration: 1 }] }),
    /pitch/i,
  );
  assert.throws(
    () => analyzeMidiEvidence({ ...source, notes: [{ pitch: 60, startTime: 0, duration: 0 }] }),
    /duration/i,
  );
  assert.throws(
    () => analyzeMidiEvidence({
      ...source,
      notes: Array.from({ length: MAX_MIDI_EVIDENCE_NOTES + 1 }, () => ({ pitch: 60, startTime: 0, duration: 1 })),
    }),
    /at most/i,
  );
});
