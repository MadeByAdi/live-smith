import type { NoteDescription } from "@ableton-extensions/sdk";

export const MAX_MIDI_EVIDENCE_NOTES = 4096;
const MAX_RENDERED_VALUES = 128;

export type EvidenceCategory = "OBSERVED" | "DERIVED" | "UNKNOWN";

export interface Evidence<T> {
  category: EvidenceCategory;
  source: "live-sdk";
  derivation: string;
  units?: "beats" | "count" | "midi-note" | "velocity" | "ratio";
  assumptions: readonly string[];
  value?: T;
  unavailableReason?: string;
}

export interface MidiEvidenceInput {
  trackHandleId: string;
  clipHandleId: string;
  trackLabel: string;
  clipLabel: string;
  location: "arrangement" | "session" | "take-lane" | "unknown";
  clip: {
    startBeat: number;
    endBeat: number;
    durationBeats: number;
    startMarkerBeat: number;
    endMarkerBeat: number;
    looping: boolean;
    loopStartBeat: number;
    loopEndBeat: number;
    muted: boolean;
  };
  notes: readonly NoteDescription[];
  grid: { quantization: number; isTriplet: boolean };
}

type NumericSummary = { min: number; max: number; mean: number; median: number };
type OptionalNumericSummary = { presentCount: number; missingCount: number } & Partial<NumericSummary>;

export interface MidiEvidenceReport {
  schemaVersion: 1;
  source: {
    trackHandleId: Evidence<string>;
    clipHandleId: Evidence<string>;
    trackLabel: Evidence<string>;
    clipLabel: Evidence<string>;
    location: Evidence<MidiEvidenceInput["location"]>;
  };
  clip: { [K in keyof MidiEvidenceInput["clip"]]: Evidence<MidiEvidenceInput["clip"][K]> };
  notes: {
    count: Evidence<number>;
    pitch: Evidence<{ uniqueCount: number; lowest: number; highest: number; span: number }>;
    density: Evidence<{ notesPerClipBeat: number; onsetGroupsPerClipBeat: number }>;
    onsets: Evidence<{ positionsBeats: number[]; omittedPositionCount: number; interOnsetIntervalsBeats: number[] }>;
    duration: Evidence<NumericSummary & { repeatedValues: number[] }>;
    occupancy: Evidence<{
      maxSimultaneous: number;
      monophonicIntervalsBeats: [number, number][];
      polyphonicIntervalsBeats: [number, number][];
      overlapIntervalsBeats: [number, number][];
      silentGapIntervalsBeats: [number, number][];
    }>;
    velocity: Evidence<OptionalNumericSummary & { repeatedValues?: number[] }>;
    probability: Evidence<OptionalNumericSummary>;
    velocityDeviation: Evidence<OptionalNumericSummary>;
    releaseVelocity: Evidence<OptionalNumericSummary>;
    repetition: Evidence<{ exactEventSignatureGroups: number; exactOnsetGroupSignatureGroups: number }>;
  };
  grid: {
    quantization: Evidence<string>;
    triplet: Evidence<boolean>;
    deviation: Evidence<NumericSummary>;
  };
  unknowns: Array<{ field: string; reason: string; evidenceNeeded: string }>;
}

export function analyzeMidiEvidence(input: MidiEvidenceInput): MidiEvidenceReport {
  validateInput(input);
  const notes = input.notes.map((note) => ({ ...note }));
  const observed = <T>(value: T, units?: Evidence<T>["units"]): Evidence<T> => ({
    category: "OBSERVED", source: "live-sdk", derivation: "direct", ...(units ? { units } : {}), assumptions: [], value,
  });
  const derived = <T>(value: T, derivation: string, units?: Evidence<T>["units"]): Evidence<T> => ({
    category: "DERIVED", source: "live-sdk", derivation, ...(units ? { units } : {}), assumptions: [], value,
  });
  const unknown = <T>(reason: string): Evidence<T> => ({
    category: "UNKNOWN", source: "live-sdk", derivation: "not-computable", assumptions: [], unavailableReason: reason,
  });
  const onsets = uniqueSorted(notes.map((note) => note.startTime));
  const gridStep = gridStepBeats(input.grid.quantization, input.grid.isTriplet);
  const unknowns: MidiEvidenceReport["unknowns"] = [
    { field: "applicableTimeSignature", reason: "The SDK does not expose a clip-applicable Song meter.", evidenceNeeded: "Observed applicable time signature." },
    { field: "phraseBoundaries", reason: "No deterministic phrase-boundary rule is part of v1.", evidenceNeeded: "User-provided or independently observed phrase boundaries." },
    { field: "performanceSemantics", reason: "MIDI values do not establish intent, articulation, technique, role, or realism.", evidenceNeeded: "User-provided intent or independent performance/audio evidence." },
  ];

  const clip = {
    startBeat: observed(input.clip.startBeat, "beats"),
    endBeat: observed(input.clip.endBeat, "beats"),
    durationBeats: observed(input.clip.durationBeats, "beats"),
    startMarkerBeat: observed(input.clip.startMarkerBeat, "beats"),
    endMarkerBeat: observed(input.clip.endMarkerBeat, "beats"),
    looping: observed(input.clip.looping),
    loopStartBeat: observed(input.clip.loopStartBeat, "beats"),
    loopEndBeat: observed(input.clip.loopEndBeat, "beats"),
    muted: observed(input.clip.muted),
  };

  if (!notes.length) {
    return {
      schemaVersion: 1,
      source: {
        trackHandleId: observed(input.trackHandleId), clipHandleId: observed(input.clipHandleId),
        trackLabel: observed(input.trackLabel), clipLabel: observed(input.clipLabel), location: observed(input.location),
      },
      clip,
      notes: {
        count: observed(0, "count"),
        pitch: unknown("The MIDI clip contains no notes."),
        density: derived({ notesPerClipBeat: 0, onsetGroupsPerClipBeat: 0 }, "count divided by observed clip duration", "ratio"),
        onsets: derived({ positionsBeats: [], omittedPositionCount: 0, interOnsetIntervalsBeats: [] }, "sorted exact note start times", "beats"),
        duration: unknown("The MIDI clip contains no note durations."),
        occupancy: derived({ maxSimultaneous: 0, monophonicIntervalsBeats: [], polyphonicIntervalsBeats: [], overlapIntervalsBeats: [], silentGapIntervalsBeats: [[0, input.clip.durationBeats]] }, "half-open interval sweep", "beats"),
        velocity: unknown("The MIDI clip contains no velocity values."),
        probability: unknown("The MIDI clip contains no probability values."),
        velocityDeviation: unknown("The MIDI clip contains no velocity-deviation values."),
        releaseVelocity: unknown("The MIDI clip contains no release-velocity values."),
        repetition: derived({ exactEventSignatureGroups: 0, exactOnsetGroupSignatureGroups: 0 }, "exact signature grouping", "count"),
      },
      grid: gridEvidence(input.grid, gridStep, [], observed, derived, unknown),
      unknowns,
    };
  }

  const pitches = uniqueSorted(notes.map((note) => note.pitch));
  const durations = notes.map((note) => note.duration);
  const occupancy = occupancyMetrics(notes, input.clip.durationBeats);
  const velocity = optionalSummary(notes, "velocity");
  const probability = optionalSummary(notes, "probability");
  const velocityDeviation = optionalSummary(notes, "velocityDeviation");
  const releaseVelocity = optionalSummary(notes, "releaseVelocity");

  return {
    schemaVersion: 1,
    source: {
      trackHandleId: observed(input.trackHandleId), clipHandleId: observed(input.clipHandleId),
      trackLabel: observed(input.trackLabel), clipLabel: observed(input.clipLabel), location: observed(input.location),
    },
    clip,
    notes: {
      count: observed(notes.length, "count"),
      pitch: derived({ uniqueCount: pitches.length, lowest: pitches[0]!, highest: pitches.at(-1)!, span: pitches.at(-1)! - pitches[0]! }, "unique sorted MIDI pitches", "midi-note"),
      density: derived({ notesPerClipBeat: notes.length / input.clip.durationBeats, onsetGroupsPerClipBeat: onsets.length / input.clip.durationBeats }, "count divided by observed clip duration", "ratio"),
      onsets: derived({ positionsBeats: onsets.slice(0, MAX_RENDERED_VALUES), omittedPositionCount: Math.max(0, onsets.length - MAX_RENDERED_VALUES), interOnsetIntervalsBeats: bounded(onsets.slice(1).map((value, index) => value - onsets[index]!)) }, "sorted exact note start times", "beats"),
      duration: derived({ ...numericSummary(durations), repeatedValues: repeatedValues(durations) }, "exact note durations", "beats"),
      occupancy: derived(occupancy, "half-open interval sweep", "beats"),
      velocity: optionalEvidence(velocity, "available note velocities", "velocity", derived, unknown, true),
      probability: optionalEvidence(probability, "available note probabilities", "ratio", derived, unknown),
      velocityDeviation: optionalEvidence(velocityDeviation, "available note velocity deviations", "velocity", derived, unknown),
      releaseVelocity: optionalEvidence(releaseVelocity, "available note release velocities", "velocity", derived, unknown),
      repetition: derived(repetitionMetrics(notes, onsets), "exact note and onset-group signatures", "count"),
    },
    grid: gridEvidence(input.grid, gridStep, onsets, observed, derived, unknown),
    unknowns,
  };
}

export function renderMidiEvidence(report: MidiEvidenceReport): string {
  const value = <T>(field: Evidence<T>): string => field.value === undefined ? "UNKNOWN" : JSON.stringify(field.value);
  return [
    "OBSERVED MIDI",
    `- target: track=${value(report.source.trackHandleId)}, clip=${value(report.source.clipHandleId)}, location=${value(report.source.location)}`,
    `- clip: start=${value(report.clip.startBeat)}, end=${value(report.clip.endBeat)}, duration=${value(report.clip.durationBeats)}, looping=${value(report.clip.looping)}, muted=${value(report.clip.muted)}`,
    `- notes: ${value(report.notes.count)}`,
    `- grid: ${value(report.grid.quantization)}, triplet=${value(report.grid.triplet)}`,
    "DERIVED METRICS",
    `- pitch: ${value(report.notes.pitch)}`,
    `- density: ${value(report.notes.density)}`,
    `- onsets: ${value(report.notes.onsets)}`,
    `- duration: ${value(report.notes.duration)}`,
    `- occupancy: ${value(report.notes.occupancy)}`,
    `- velocity: ${value(report.notes.velocity)}`,
    `- probability: ${value(report.notes.probability)}`,
    `- velocity deviation: ${value(report.notes.velocityDeviation)}`,
    `- release velocity: ${value(report.notes.releaseVelocity)}`,
    `- repetition: ${value(report.notes.repetition)}`,
    `- grid deviation: ${value(report.grid.deviation)}`,
    "UNKNOWN / NOT ESTABLISHED",
    ...report.unknowns.map((item) => `- ${item.field}: ${item.reason}`),
  ].join("\n");
}

function validateInput(input: MidiEvidenceInput): void {
  if (!Number.isInteger(input.notes.length) || input.notes.length > MAX_MIDI_EVIDENCE_NOTES) {
    throw new Error(`MIDI evidence supports at most ${MAX_MIDI_EVIDENCE_NOTES} notes; refusing partial analysis.`);
  }
  for (const value of Object.values(input.clip)) {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("MIDI clip geometry must be finite.");
  }
  if (!(input.clip.durationBeats > 0)) throw new Error("MIDI clip duration must be greater than zero.");
  if (!Number.isInteger(input.grid.quantization)) throw new Error("MIDI grid quantization must be an integer.");
  input.notes.forEach((note, index) => validateNote(note, index));
}

function validateNote(note: NoteDescription, index: number): void {
  if (!Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127) throw new Error(`MIDI note ${index} pitch must be an integer between 0 and 127.`);
  if (!Number.isFinite(note.startTime) || note.startTime < 0) throw new Error(`MIDI note ${index} startTime must be finite and non-negative.`);
  if (!Number.isFinite(note.duration) || !(note.duration > 0)) throw new Error(`MIDI note ${index} duration must be finite and greater than zero.`);
  optionalNumber(note.velocity, 0, 127, `MIDI note ${index} velocity`);
  optionalBoolean(note.muted, `MIDI note ${index} muted`);
  optionalNumber(note.probability, 0, 1, `MIDI note ${index} probability`);
  optionalNumber(note.velocityDeviation, -127, 127, `MIDI note ${index} velocityDeviation`);
  optionalNumber(note.releaseVelocity, 0, 127, `MIDI note ${index} releaseVelocity`);
}

function optionalNumber(value: unknown, minimum: number, maximum: number, label: string): void {
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum)) throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
}

function optionalBoolean(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
}

function numericSummary(values: readonly number[]): NumericSummary {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length / 2;
  return { min: sorted[0]!, max: sorted.at(-1)!, mean: values.reduce((sum, value) => sum + value, 0) / values.length, median: Number.isInteger(middle) ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[Math.floor(middle)]! };
}

function optionalSummary(notes: readonly NoteDescription[], key: "velocity" | "probability" | "velocityDeviation" | "releaseVelocity"): OptionalNumericSummary & { values: number[] } {
  const values = notes.flatMap((note) => note[key] === undefined ? [] : [note[key] as number]);
  return values.length ? { presentCount: values.length, missingCount: notes.length - values.length, ...numericSummary(values), values } : { presentCount: 0, missingCount: notes.length, values };
}

function optionalEvidence(summary: OptionalNumericSummary & { values: number[] }, derivation: string, units: "ratio" | "velocity", derived: <V>(value: V, derivation: string, units?: Evidence<V>["units"]) => Evidence<V>, unknown: <V>(reason: string) => Evidence<V>, includeRepeated = false): Evidence<OptionalNumericSummary & { repeatedValues?: number[] }> {
  if (!summary.presentCount) {
    return { ...unknown("No values were supplied by the Live SDK."), value: { presentCount: 0, missingCount: summary.missingCount } };
  }
  const result = numericSummary(summary.values);
  return derived({ presentCount: summary.presentCount, missingCount: summary.missingCount, ...result, ...(includeRepeated ? { repeatedValues: repeatedValues(summary.values) } : {}) }, derivation, units);
}

function occupancyMetrics(notes: readonly NoteDescription[], duration: number): MidiEvidenceReport["notes"]["occupancy"] extends Evidence<infer Value> ? Value : never {
  const times = uniqueSorted([0, duration, ...notes.flatMap((note) => [note.startTime, note.startTime + note.duration])]);
  const monophonicIntervalsBeats: [number, number][] = [];
  const polyphonicIntervalsBeats: [number, number][] = [];
  const overlapIntervalsBeats: [number, number][] = [];
  const silentGapIntervalsBeats: [number, number][] = [];
  let maxSimultaneous = 0;
  for (let index = 0; index < times.length - 1; index += 1) {
    const start = times[index]!;
    const end = times[index + 1]!;
    if (!(end > start)) continue;
    const active = notes.filter((note) => note.startTime <= start && start < note.startTime + note.duration).length;
    maxSimultaneous = Math.max(maxSimultaneous, active);
    if (active === 0) silentGapIntervalsBeats.push([start, end]);
    if (active === 1) monophonicIntervalsBeats.push([start, end]);
    if (active > 1) {
      polyphonicIntervalsBeats.push([start, end]);
      overlapIntervalsBeats.push([start, end]);
    }
  }
  return { maxSimultaneous, monophonicIntervalsBeats: bounded(monophonicIntervalsBeats), polyphonicIntervalsBeats: bounded(polyphonicIntervalsBeats), overlapIntervalsBeats: bounded(overlapIntervalsBeats), silentGapIntervalsBeats: bounded(silentGapIntervalsBeats) };
}

function repetitionMetrics(notes: readonly NoteDescription[], onsets: readonly number[]): { exactEventSignatureGroups: number; exactOnsetGroupSignatureGroups: number } {
  const eventGroups = new Map<string, number>();
  for (const note of notes) increment(eventGroups, noteSignature(note));
  const onsetGroups = new Map<string, number>();
  for (const onset of onsets) increment(onsetGroups, notes.filter((note) => note.startTime === onset).map(noteSignature).sort().join("|"));
  return { exactEventSignatureGroups: [...eventGroups.values()].filter((count) => count > 1).length, exactOnsetGroupSignatureGroups: [...onsetGroups.values()].filter((count) => count > 1).length };
}

function noteSignature(note: NoteDescription): string {
  return `${note.pitch}:${note.duration}`;
}

function gridEvidence(grid: MidiEvidenceInput["grid"], step: number | undefined, onsets: readonly number[], observed: <T>(value: T, units?: Evidence<T>["units"]) => Evidence<T>, derived: <T>(value: T, derivation: string, units?: Evidence<T>["units"]) => Evidence<T>, unknown: <T>(reason: string) => Evidence<T>): MidiEvidenceReport["grid"] {
  const quantization = observed(gridLabel(grid.quantization));
  const triplet = observed(grid.isTriplet);
  if (step === undefined) return { quantization, triplet, deviation: unknown(grid.quantization === 0 ? "NoGrid has no grid point for deviation measurement." : "This grid setting cannot be mapped to beats without an applicable time signature.") };
  const deviations = onsets.map((onset) => {
    const remainder = ((onset % step) + step) % step;
    return Math.min(remainder, step - remainder);
  });
  return { quantization, triplet, deviation: derived(numericSummaryOrZero(deviations), "nearest known grid subdivision", "beats") };
}

function numericSummaryOrZero(values: readonly number[]): NumericSummary {
  return values.length ? numericSummary(values) : { min: 0, max: 0, mean: 0, median: 0 };
}

function gridStepBeats(quantization: number, triplet: boolean): number | undefined {
  const base = new Map<number, number>([[5, 2], [6, 1], [7, 0.5], [8, 0.25], [9, 0.125]]).get(quantization);
  return base === undefined ? undefined : triplet ? base * 2 / 3 : base;
}

function gridLabel(quantization: number): string {
  return ({ 0: "NoGrid", 1: "8 bars", 2: "4 bars", 3: "2 bars", 4: "1 bar", 5: "1/2", 6: "1/4", 7: "1/8", 8: "1/16", 9: "1/32" } as Record<number, string>)[quantization] ?? `unsupported:${quantization}`;
}

function uniqueSorted(values: readonly number[]): number[] { return [...new Set(values)].sort((left, right) => left - right); }
function repeatedValues(values: readonly number[]): number[] { const counts = new Map<number, number>(); values.forEach((value) => increment(counts, value)); return [...counts.entries()].filter(([, count]) => count > 1).map(([value]) => value).sort((left, right) => left - right).slice(0, MAX_RENDERED_VALUES); }
function increment(map: Map<string, number> | Map<number, number>, key: string | number): void { map.set(key as never, (map.get(key as never) ?? 0) + 1); }
function bounded<T>(values: readonly T[]): T[] { return values.slice(0, MAX_RENDERED_VALUES); }
