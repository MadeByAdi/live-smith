import type { NoteDescription } from "@ableton-extensions/sdk";

export const STANDARD_GUITAR_OPEN_PITCHES = [40, 45, 50, 55, 59, 64] as const;
export const DEFAULT_GUITAR_MAX_FRET = 24;
export const MAX_GUITAR_SEARCH_STATES = 4096;
export const MAX_GUITAR_SEARCH_TRANSITIONS = 100_000;

export type GuitarVerdict = "POSSIBLE" | "IMPOSSIBLE" | "UNKNOWN";
export type GuitarAssignment = { noteIndex: number; string: number; fret: number };
export interface GuitarPlayabilityInput { notes: readonly NoteDescription[]; maxFret?: number; maxFretSpan?: number; }
export interface GuitarPlayabilityReport {
  verdict: GuitarVerdict;
  assumptions: { tuning: readonly number[]; capo: 0; maxFret: number; maxFretSpan?: number; handSpanRule: string };
  reasons: string[];
  onsetGroups: Array<{ startBeat: number; verdict: GuitarVerdict; candidateAssignments: GuitarAssignment[] }>;
  sequence: { verdict: GuitarVerdict; candidatePathCount?: number; transitionCount: number };
  unknowns: string[];
}

type State = Map<number, GuitarAssignment>;

export function fretMappingsForPitch(pitch: number, maxFret = DEFAULT_GUITAR_MAX_FRET): GuitarAssignment[] {
  validatePitch(pitch); validateMaxFret(maxFret);
  return STANDARD_GUITAR_OPEN_PITCHES.flatMap((openPitch, index) => {
    const fret = pitch - openPitch;
    return fret >= 0 && fret <= maxFret ? [{ noteIndex: -1, string: 6 - index, fret }] : [];
  });
}

export function analyzeGuitarPlayability(input: GuitarPlayabilityInput): GuitarPlayabilityReport {
  const maxFret = input.maxFret ?? DEFAULT_GUITAR_MAX_FRET;
  validateMaxFret(maxFret);
  if (input.maxFretSpan === undefined) return unknownReport(maxFret, "maxFretSpan is required; no default hand-span threshold is established.");
  if (!Number.isInteger(input.maxFretSpan) || input.maxFretSpan < 0 || input.maxFretSpan > maxFret) throw new Error("maxFretSpan must be an integer between 0 and maxFret.");
  const notes = input.notes.map((note, index) => ({ ...note, index }));
  notes.forEach((note) => validateNote(note));
  const assumptions = { tuning: STANDARD_GUITAR_OPEN_PITCHES, capo: 0 as const, maxFret, maxFretSpan: input.maxFretSpan, handSpanRule: "Open strings are excluded; max(fretted)-min(fretted) must not exceed maxFretSpan." };
  const groups = groupByStart(notes);
  const groupReports: GuitarPlayabilityReport["onsetGroups"] = [];
  let states = new Map<string, State>([["", new Map()]]);
  let transitions = 0;
  for (const group of groups) {
    for (const state of states.values()) removeEnded(state, notes, group.startBeat);
    if (group.notes.length > 6) return impossible(assumptions, groupReports, transitions, group.startBeat, "More than six notes start simultaneously.");
    if (group.notes.some((note) => !fretMappingsForPitch(note.pitch, maxFret).length)) return impossible(assumptions, groupReports, transitions, group.startBeat, "At least one pitch has no mapping in the declared guitar range.");
    const next = new Map<string, State>();
    for (const state of states.values()) {
      for (const assignment of assignGroup(group.notes, state, maxFret, input.maxFretSpan)) {
        transitions += 1;
        if (transitions > MAX_GUITAR_SEARCH_TRANSITIONS || next.size >= MAX_GUITAR_SEARCH_STATES) return boundUnknown(assumptions, groupReports, transitions);
        next.set(stateKey(assignment), assignment);
      }
    }
    const examples = [...next.values()].slice(0, 8).map((state) => group.notes.map((note) => state.get(note.index)!).filter(Boolean));
    groupReports.push({ startBeat: group.startBeat, verdict: next.size ? "POSSIBLE" : "IMPOSSIBLE", candidateAssignments: examples[0] ?? [] });
    if (!next.size) return impossible(assumptions, groupReports, transitions, group.startBeat, "No distinct-string assignment satisfies the declared fret-span constraint while sustained notes remain sounding.");
    states = next;
  }
  return { verdict: "POSSIBLE", assumptions, reasons: ["At least one assignment path satisfies only the declared v1 physical constraints."], onsetGroups: groupReports, sequence: { verdict: "POSSIBLE", candidatePathCount: states.size, transitionCount: transitions }, unknowns: ["No conclusion about comfort, idiomaticity, fingering, technique, articulation, or realism."] };
}

function assignGroup(notes: readonly (NoteDescription & { index: number })[], existing: State, maxFret: number, span: number): State[] {
  const ordered = [...notes].sort((a, b) => fretMappingsForPitch(a.pitch, maxFret).length - fretMappingsForPitch(b.pitch, maxFret).length);
  const result: State[] = [];
  const visit = (index: number, state: State): void => {
    if (index === ordered.length) { result.push(new Map(state)); return; }
    const note = ordered[index]!;
    for (const mapping of fretMappingsForPitch(note.pitch, maxFret)) {
      if ([...state.values()].some((item) => item.string === mapping.string)) continue;
      const next = new Map(state); next.set(note.index, { ...mapping, noteIndex: note.index });
      if (!withinSpan(next, span)) continue;
      visit(index + 1, next);
    }
  };
  visit(0, existing); return result;
}

function withinSpan(state: State, span: number): boolean {
  const frets = [...state.values()].map((item) => item.fret).filter((fret) => fret > 0);
  return !frets.length || Math.max(...frets) - Math.min(...frets) <= span;
}
function removeEnded(state: State, notes: readonly (NoteDescription & { index: number })[], time: number): void { for (const note of notes) if (note.startTime + note.duration <= time) state.delete(note.index); }
function stateKey(state: State): string { return [...state.values()].sort((a, b) => a.noteIndex - b.noteIndex).map((item) => `${item.noteIndex}:${item.string}:${item.fret}`).join("|"); }
function groupByStart(notes: readonly (NoteDescription & { index: number })[]): Array<{ startBeat: number; notes: (NoteDescription & { index: number })[] }> { const groups = new Map<number, (NoteDescription & { index: number })[]>(); for (const note of notes) groups.set(note.startTime, [...(groups.get(note.startTime) ?? []), note]); return [...groups.entries()].sort(([a], [b]) => a - b).map(([startBeat, grouped]) => ({ startBeat, notes: grouped })); }
function unknownReport(maxFret: number, reason: string): GuitarPlayabilityReport { return { verdict: "UNKNOWN", assumptions: { tuning: STANDARD_GUITAR_OPEN_PITCHES, capo: 0, maxFret, handSpanRule: "Open strings would be excluded if maxFretSpan were supplied." }, reasons: [reason], onsetGroups: [], sequence: { verdict: "UNKNOWN", transitionCount: 0 }, unknowns: [reason] }; }
function impossible(assumptions: GuitarPlayabilityReport["assumptions"], onsetGroups: GuitarPlayabilityReport["onsetGroups"], transitions: number, startBeat: number, reason: string): GuitarPlayabilityReport { if (!onsetGroups.length || onsetGroups.at(-1)?.startBeat !== startBeat) onsetGroups.push({ startBeat, verdict: "IMPOSSIBLE", candidateAssignments: [] }); return { verdict: "IMPOSSIBLE", assumptions, reasons: [reason], onsetGroups, sequence: { verdict: "IMPOSSIBLE", candidatePathCount: 0, transitionCount: transitions }, unknowns: [] }; }
function boundUnknown(assumptions: GuitarPlayabilityReport["assumptions"], onsetGroups: GuitarPlayabilityReport["onsetGroups"], transitions: number): GuitarPlayabilityReport { return { verdict: "UNKNOWN", assumptions, reasons: ["analysis-bound-exceeded"], onsetGroups, sequence: { verdict: "UNKNOWN", transitionCount: transitions }, unknowns: ["Search bound exceeded; no approximation was used."] }; }
function validatePitch(pitch: number): void { if (!Number.isInteger(pitch) || pitch < 0 || pitch > 127) throw new Error("MIDI pitch must be an integer between 0 and 127."); }
function validateMaxFret(maxFret: number): void { if (!Number.isInteger(maxFret) || maxFret < 0 || maxFret > 127) throw new Error("maxFret must be an integer between 0 and 127."); }
function validateNote(note: NoteDescription & { index: number }): void { validatePitch(note.pitch); if (!Number.isFinite(note.startTime) || note.startTime < 0 || !Number.isFinite(note.duration) || note.duration <= 0) throw new Error(`MIDI note ${note.index} has invalid timing.`); }
