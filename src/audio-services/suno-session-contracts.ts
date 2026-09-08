/** Website-session evidence never confers an audio-generation capability. */
export interface SunoSessionIdentity {
  accountId: string;
  accountName?: string;
}

export type SunoSessionVerifier = (
  clientToken: string, signal: AbortSignal,
) => Promise<SunoSessionIdentity>;

export interface SunoAccountView {
  serviceId: string;
  status: "signed_out" | "saved" | "signed_in" | "expired" | "unavailable";
  accountId?: string;
  accountName?: string;
}
