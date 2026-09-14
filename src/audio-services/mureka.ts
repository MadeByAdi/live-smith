import type { AudioGenerationAdapter, AudioGenerationRequest } from "./contracts.js";
import { DEFAULT_MUREKA_MUSIC_MODEL, MUREKA_MUSIC_MODELS } from "./capabilities.js";
import { createMurekaHttp, type MurekaTaskKind } from "./mureka-http.js";
import { exceedsAudioPromptLimit } from "./prompt.js";

const RUNNING = new Set(["preparing", "queued", "running", "streaming"]);
const TERMINAL = new Set(["succeeded", "failed", "timeouted", "cancelled"]);

/** Official protocol: https://platform.mureka.ai/docs/ */
export function createMurekaAudioAdapter(
  apiKey: string, options: { modelId?: string | undefined; fetchImpl?: typeof fetch | undefined } = {},
): AudioGenerationAdapter {
  const http = createMurekaHttp(apiKey, options.fetchImpl);
  const model = options.modelId ?? DEFAULT_MUREKA_MUSIC_MODEL;
  if (!MUREKA_MUSIC_MODELS.includes(model as (typeof MUREKA_MUSIC_MODELS)[number])) {
    throw http.fail("unsupported music model identifier.");
  }
  const parseTask = (locator: string): { kind: MurekaTaskKind; taskId: string } => {
    const match = /^(song|instrumental):(.+)$/u.exec(locator);
    if (!match) throw http.fail("invalid task locator.");
    return { kind: match[1] as MurekaTaskKind, taskId: http.identifier(match[2]) };
  };
  return {
    provider: "mureka",
    async submit(request, signal) {
      http.active(signal);
      validateGenerationRequest(request, model, http.fail);
      const kind: MurekaTaskKind = request.instrumental ? "instrumental" : "song";
      const value = await http.submit(kind, {
        model, n: 1, prompt: request.prompt, stream: false,
      }, signal);
      const taskId = http.identifier(value.id);
      if (typeof value.status !== "string" || !RUNNING.has(value.status) && !TERMINAL.has(value.status)) {
        throw http.fail("invalid submission task status.");
      }
      return { kind: "task", taskId: `${kind}:${taskId}` };
    },
    async inspect(locator, signal) {
      http.active(signal);
      const { kind, taskId } = parseTask(locator);
      const value = await http.inspect(kind, taskId, signal);
      if (http.identifier(value.id) !== taskId) throw http.fail("task ID does not match the requested task.");
      if (typeof value.status !== "string") throw http.fail("invalid task status.");
      if (RUNNING.has(value.status)) return { status: "running" };
      if (value.status === "failed") return { status: "failed", message: http.fail("task failed.").message };
      if (value.status === "timeouted") return { status: "failed", message: http.fail("task timed out.").message };
      if (value.status === "cancelled") return { status: "cancelled" };
      if (value.status !== "succeeded") throw http.fail("unknown task status.");
      if (!Array.isArray(value.choices) || value.choices.length !== 1) {
        throw http.fail("completed task must contain the requested audio output.");
      }
      const choice = http.object(value.choices[0]);
      return { status: "completed", outputs: [{
        key: http.identifier(choice.id), role: "music", url: http.outputUrl(choice.url),
      }] };
    },
    async download(output, signal) {
      http.active(signal);
      http.identifier(output.key);
      if (output.role !== "music") throw http.fail("invalid music output role.");
      return http.download(output.url, signal);
    },
    // The published API documents task state polling but no cancellation operation.
  };
}

function validateGenerationRequest(
  request: AudioGenerationRequest, model: string, fail: (detail: string) => Error,
): asserts request is Extract<AudioGenerationRequest, { operation: "generate_music" }> {
  if (!request || request.operation !== "generate_music") throw fail("only music generation is supported.");
  if (request.options !== undefined) throw fail("custom music options are not supported by this adapter.");
  if (request.durationSeconds !== undefined) throw fail("duration is not supported.");
  if (typeof request.instrumental !== "boolean") throw fail("instrumental must be a boolean.");
  if (typeof request.prompt !== "string" || !request.prompt.trim() || request.prompt.includes("\0") ||
      exceedsAudioPromptLimit(request.prompt, 1024)) throw fail("music prompt must contain 1–1024 characters.");
  if (request.instrumental && model === "mureka-o2") throw fail("the selected model does not support instrumental generation.");
}
