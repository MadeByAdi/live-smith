import { createHash } from "node:crypto";
import type { AudioOperation, AudioServiceConnection } from "../audio-services/contracts.js";
import { audioServiceSupports, type AudioServiceChoice } from "../audio-services/capabilities.js";
import { loadAgentSettings } from "../storage/settings.js";

export function audioConnectionFingerprint(settings: AudioServiceConnection): string {
  // Preserve the legacy credential fingerprint. Connection ID is independently
  // checked on the job, and a model change cannot retarget an accepted task.
  return createHash("sha256").update(JSON.stringify([settings.provider, settings.apiKey])).digest("hex");
}

/** Private send snapshot; only credential-free choices may enter model tools. */
export async function captureAudioServiceConnections(
  storageDirectory: string | undefined,
): Promise<AudioServiceConnection[]> {
  if (!storageDirectory) return [];
  const settings = await loadAgentSettings(storageDirectory);
  return (settings.audioServices?.connections ?? [])
    .filter((connection) => connection.enabled && connection.apiKey)
    .map((connection) => Object.freeze({ ...connection }));
}

export async function availableAudioServices(storageDirectory: string | undefined): Promise<AudioServiceChoice[]> {
  return (await captureAudioServiceConnections(storageDirectory))
    .map(({ id, name, provider }) => ({ id, name, provider }));
}

export async function resolveAudioService(
  storageDirectory: string | undefined, serviceId: string, operation: AudioOperation,
  admittedConnections?: readonly AudioServiceConnection[],
): Promise<AudioServiceConnection> {
  if (!storageDirectory) throw new Error("Audio processing requires private persistent storage.");
  const admitted = admittedConnections?.find((entry) => entry.id === serviceId);
  if (admittedConnections && !admitted) {
    throw new Error("The selected audio service was not admitted for this request. Send a new request to use its saved connection.");
  }
  const settings = await loadAgentSettings(storageDirectory);
  const connection = settings.audioServices?.connections.find((entry) => entry.id === serviceId);
  if (!connection?.enabled || !connection.apiKey) {
    throw new Error("The selected audio service is unavailable. Enable its saved connection in Inspector → App.");
  }
  // Compare this connection, not the collection revision. The persisted job
  // fingerprint binds an accepted task's credential owner; send admission also
  // binds configuration that can change a new submission or its destination.
  if (admitted && (connection.name !== admitted.name || connection.provider !== admitted.provider ||
    connection.enabled !== admitted.enabled || connection.apiKey !== admitted.apiKey ||
    connection.modelId !== admitted.modelId || connection.callbackUrl !== admitted.callbackUrl)) {
    throw new Error("The selected audio service changed after this request was admitted. Send a new request to use its saved connection.");
  }
  if (!audioServiceSupports(connection.provider, operation)) {
    throw new Error("The selected audio service does not support this operation.");
  }
  return admitted ?? connection;
}
