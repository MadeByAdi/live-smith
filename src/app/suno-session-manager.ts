import { createHash } from "node:crypto";
import type { AudioServiceConnection } from "../audio-services/contracts.js";
import type { SunoAccountView, SunoSessionVerifier } from "../audio-services/suno-session-contracts.js";
import { normalizeSunoSessionIdentity, normalizeSunoSessionValue, SunoSessionExpiredError, SunoSessionUnavailableError } from "../audio-services/suno-session.js";
import { waitForPromiseWithSignal } from "../runtime/host.js";
import { isStorageCommitOutcomeUnknownError, StorageCommitOutcomeUnknownError, withStorageTransaction, type StorageTransactionContext } from "../storage/persistence.js";
import { loadAgentSettings } from "../storage/settings.js";
import { storageScopeKey, type StorageScopeKey } from "../storage/scope.js";
import { SunoSessions, SunoSessionStorageError, type StoredSunoSession } from "../storage/suno-sessions.js";

interface VerificationEvidence {
  fingerprint: string;
  status: "signed_in" | "expired" | "unavailable";
}
// Only fingerprints and verification outcomes survive across managers, never credentials.
const evidenceByStorage = new Map<StorageScopeKey, Map<string, VerificationEvidence>>();

/** The app's global-settings fence serializes the complete network/commit lifecycle. */
export class SunoSessionManager {
  private readonly store: SunoSessions;
  private readonly scopeKey: StorageScopeKey;

  constructor(private readonly storageDirectory: string | undefined, private readonly verifier: SunoSessionVerifier) {
    this.store = new SunoSessions(storageDirectory);
    // The app supplies its canonical directory; the store rejects symlink aliases.
    this.scopeKey = storageScopeKey(storageDirectory);
  }

  async views(connections: readonly AudioServiceConnection[]): Promise<SunoAccountView[]> {
    const sunoConnections = connections.filter((connection) => connection.provider === "suno");
    const owners = new Set(sunoConnections.map(({ id }) => id));
    for (const id of evidenceByStorage.get(this.scopeKey)?.keys() ?? []) {
      if (!owners.has(id)) this.updateEvidence(id);
    }
    return Promise.all(sunoConnections.map(async ({ id }) => {
      try {
        if (!this.storageDirectory) return { serviceId: id, status: "signed_out" as const };
        const saved = await this.store.load(id);
        if (!saved) { this.updateEvidence(id); return { serviceId: id, status: "signed_out" as const }; }
        const cached = evidenceByStorage.get(this.scopeKey)?.get(id);
        const status = cached?.fingerprint === identity(saved) ? cached.status : "saved";
        if (status === "saved") this.updateEvidence(id);
        return { serviceId: id, status, ...(["signed_in", "saved"].includes(status)
          ? { accountId: saved.accountId, ...(saved.accountName ? { accountName: saved.accountName } : {}) } : {}) };
      } catch {
        this.updateEvidence(id);
        return { serviceId: id, status: "unavailable" as const };
      }
    }));
  }

  async importSession(serviceId: string, sessionValue: unknown, signal: AbortSignal): Promise<void> {
    active(signal);
    await this.requireSavedConnection(serviceId);
    const clientToken = normalizeSunoSessionValue(sessionValue);
    const previous = await this.store.load(serviceId);
    const account = await this.verify(clientToken, signal);
    await this.commit(serviceId, { clientToken, ...account }, previous, signal);
  }

  async refresh(serviceId: string, signal: AbortSignal): Promise<void> {
    active(signal);
    await this.requireSavedConnection(serviceId);
    const previous = await this.store.load(serviceId);
    if (!previous) {
      this.updateEvidence(serviceId);
      throw new Error("Import a Suno session before refreshing this connection.");
    }
    try {
      const account = await this.verify(previous.clientToken, signal);
      if (account.accountId !== previous.accountId) throw new SunoSessionUnavailableError();
      await this.commit(serviceId, { clientToken: previous.clientToken, ...account }, previous, signal);
    } catch (error) {
      if (isStorageCommitOutcomeUnknownError(error)) {
        this.updateEvidence(serviceId);
        throw new StorageCommitOutcomeUnknownError(new SunoSessionStorageError());
      }
      active(signal);
      this.updateEvidence(serviceId, { fingerprint: identity(previous),
        status: error instanceof SunoSessionExpiredError ? "expired" : "unavailable" });
      if (error instanceof SunoSessionExpiredError) throw new SunoSessionExpiredError();
      throw new SunoSessionUnavailableError();
    }
  }

  async clear(serviceId: string, transaction?: StorageTransactionContext): Promise<void> {
    try { await this.store.clear(serviceId, transaction); }
    catch (error) {
      if (isStorageCommitOutcomeUnknownError(error)) this.updateEvidence(serviceId);
      throw error;
    }
    this.updateEvidence(serviceId);
  }

  private updateEvidence(serviceId: string, value?: VerificationEvidence): void {
    const shared = evidenceByStorage.get(this.scopeKey);
    if (value) {
      const evidence = shared ?? new Map<string, VerificationEvidence>();
      evidence.set(serviceId, value);
      evidenceByStorage.set(this.scopeKey, evidence);
    } else {
      shared?.delete(serviceId);
      if (!shared?.size) evidenceByStorage.delete(this.scopeKey);
    }
  }

  private async verify(token: string, signal: AbortSignal) {
    try {
      active(signal);
      const account = await waitForPromiseWithSignal(this.verifier(token, signal), signal);
      active(signal);
      return normalizeSunoSessionIdentity(account, token);
    } catch (error) {
      active(signal);
      if (error instanceof SunoSessionExpiredError) throw new SunoSessionExpiredError();
      throw new SunoSessionUnavailableError();
    }
  }

  private async commit(serviceId: string, next: StoredSunoSession, previous: StoredSunoSession | undefined, signal: AbortSignal): Promise<void> {
    await withStorageTransaction(this.storageDirectory, async (transaction) => {
      active(signal);
      await this.requireSavedConnection(serviceId);
      const current = await this.store.load(serviceId, transaction);
      if (identity(current) !== identity(previous)) throw new SunoSessionUnavailableError();
      active(signal);
      await this.store.save(serviceId, next, transaction);
      this.updateEvidence(serviceId, { fingerprint: identity(next), status: "signed_in" });
    });
  }

  private async requireSavedConnection(serviceId: string): Promise<void> {
    let exists = false;
    try {
      exists = Boolean(this.storageDirectory && (await loadAgentSettings(this.storageDirectory)).audioServices?.connections
        .some((connection) => connection.id === serviceId && connection.provider === "suno"));
    } catch { throw new SunoSessionUnavailableError(); }
    if (!exists) throw new Error("Save this Suno connection before importing or refreshing its session.");
  }
}

function identity(session: StoredSunoSession | undefined): string {
  return session ? createHash("sha256").update(JSON.stringify(session), "utf8").digest("hex") : "";
}

function active(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error("Suno session verification was cancelled.");
  error.name = "AbortError";
  throw error;
}
