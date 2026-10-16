import { SessionMutationFence } from "./session-mutation-fence.js";

export const sessionMutationFence = new SessionMutationFence();
export const attachmentMutationFence = new SessionMutationFence();
export const sessionIntentFence = new SessionMutationFence();
export const globalSettingsMutationFence = new SessionMutationFence();
export const requestConfigurationFence = new SessionMutationFence();
