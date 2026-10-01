/* Disposable control-layer companion for the upstream AgentAudioTap DSP patch. */
autowatch = 1;
inlets = 1;
outlets = 4;

var commandFile = jsarguments.length > 1 ? String(jsarguments[1]) : "agent_audio_tap_command.json";
var tapId = "";
var device = null;
var track = null;
var nameObserver = null;
var initialized = false;
var parentStatus = "not_initialized";
var isRecording = false;
var lastPath = "";
var lastCommandId = "";
var pollTask = null;
var heartbeatTask = null;
var transportPollTask = null;
var startTask = null;
var song = null;
var transportObserver = null;
var listenActive = false;
var listenStartedPlayback = false;
var listenPlaybackObserved = false;
var listenAwaitingSeek = false;
var listenSeekAttempts = 0;
var listenSeekAttemptLimit = 50;
var listenSeekToleranceBeats = 0.25;
var listenSnapshot = null;
var currentCapture = null;
var traceEntries = [];

function bang() {
    // live.thisdevice signals readiness first; defer once so LiveAPI sees the
    // fully bound device instance rather than the just-created patcher.
    var readyTask = new Task(initialize, this);
    readyTask.schedule(100);
}

function initialize() {
    if (initialized) return;
    initialized = true;
    tapId = validTapId(storedTapId()) ? storedTapId() : uuid();
    storeTapId(tapId);
    try {
        // Begin at this device and explicitly navigate to its parent.  This
        // avoids relying on a compound-path constructor during device load.
        device = new LiveAPI(null, "this_device");
        track = new LiveAPI(trackChanged, "this_device");
        track.goto("canonical_parent");
        nameObserver = new LiveAPI(trackChanged, "this_device");
        nameObserver.goto("canonical_parent");
        nameObserver.property = "name";
        song = new LiveAPI(null, "live_set");
        transportObserver = new LiveAPI(transportChanged, "live_set");
        transportObserver.property = "current_song_time";
        parentStatus = "ready";
    } catch (err) {
        parentStatus = "unavailable";
        outlet(2, "error", "parent_unavailable", String(err));
    }
    pollTask = new Task(pollCommandFile, this); pollTask.interval = 100; pollTask.repeat();
    heartbeatTask = new Task(writeRegistry, this); heartbeatTask.interval = 1000; heartbeatTask.repeat();
    // LiveAPI property callbacks can be coalesced while Live's UI is busy.
    // Poll the same beat-position source as a bounded fallback; this is not a
    // wall-clock capture timer and the Arrangement end beat remains canonical.
    transportPollTask = new Task(checkTransportPosition, this); transportPollTask.interval = 100; transportPollTask.repeat();
    writeRegistry();
    publishParentLabel();
}

function trackChanged() { writeRegistry(); publishParentLabel(); }

function storedTapId() {
    try { return String(this.patcher.getnamed("tap_identity").getvalueof() || ""); } catch (err) { return ""; }
}
function validTapId(value) { return /^tap_[0-9a-f]+_[0-9a-f]+$/.test(String(value || "")); }
function storeTapId(value) {
    try {
        var identity = this.patcher.getnamed("tap_identity");
        // Older proof bundles created this internal parameter as Hidden. Max
        // Max's native Parameter window owns the Stored Only setting. Keep the
        // opaque UUID producer-invisible while assigning it to the existing
        // persisted parameter.
        identity.setattr("parameter_enable", 1);
        identity.setvalueof(value);
    } catch (err) {}
}
function uuid() { return "tap_" + new Date().getTime().toString(16) + "_" + Math.floor(Math.random() * 0x7fffffff).toString(16); }
function parent() {
    var path = "", name = "", foldable = false;
    if (track) {
        try {
            path = String(track.unquotedpath || track.path || "");
            name = String(track.getstring("name") || "");
            foldable = Number(track.get("is_foldable") || 0) === 1;
        } catch (err) {
            parentStatus = "unavailable";
        }
    }
    var kind = path.indexOf("master_track") >= 0 ? "main" : path.indexOf("return_tracks") >= 0 ? "return" : foldable ? "group" : "track";
    return { tapId: tapId, trackName: name, trackType: kind, canonicalParent: path, online: true, recording: isRecording, parentStatus: parentStatus, updatedAt: new Date().toISOString() };
}
function registryPath() { return commandFile + "." + tapId + ".status.json"; }
function writeRegistry() {
    if (!tapId) return;
    try {
        var file = new File(registryPath(), "write");
        file.position = 0;
        file.eof = 0;
        var status = parent();
        if (currentCapture) status.capture = currentCapture;
        file.writestring(JSON.stringify(status));
        file.close();
    } catch (err) { outlet(2, "error", "registry_write", String(err)); }
}
// Presentation is intentionally a projection of the same canonical-parent
// lookup used for registry records. It is not a second naming or routing path.
function publishParentLabel() {
    outlet(3, "set", parent().trackName || "Unavailable");
}
function pollCommandFile() {
    var file = new File(commandFile, "read"); if (!file.isopen) return;
    var raw = file.readstring(65536); file.close(); if (!raw) return;
    try {
        var command = JSON.parse(raw); var id = command.id || raw;
        if (id === lastCommandId || (command.targetTapId && command.targetTapId !== tapId)) return;
        lastCommandId = id; handleCommand(command);
    } catch (err) { outlet(2, "error", "invalid_command_file", String(err)); }
}
function anything() { var atoms = arrayfromargs(messagename, arguments); handleCommand({ command: atoms[0], path: atoms[1] }); }
function handleCommand(value) {
    var command = value.command, path = value.path;
    if (command === "start") { if (path) { lastPath = path; outlet(0, "open", path, "wave"); if (!startTask) startTask = new Task(startRecording, this); startTask.schedule(500); } else startRecording(); }
    else if (command === "stop") stopRecording();
    else if (command === "arm") armListen(value);
    else if (command === "begin") beginListen(value);
    else if (command === "cancel") cancelListen(value);
}
function startRecording() { if (!lastPath) { outlet(2, "error", "no_output_path"); return; } isRecording = true; outlet(0, 1); report("start"); }
function stopRecording() { isRecording = false; outlet(0, 0); report("stop"); }
function boundedListen(value) {
    return value && validCaptureId(value.captureId) && validCaptureId(value.windowId) &&
        isFinite(Number(value.startBeat)) &&
        isFinite(Number(value.endBeat)) && Number(value.startBeat) >= 0 && Number(value.endBeat) > Number(value.startBeat);
}
function validCaptureId(value) { return /^[A-Za-z0-9_-]+$/.test(String(value || "")); }
function liveNumber(api, property) {
    var value = api.get(property);
    if (typeof value === "number") return value;
    try { return Number(Array.prototype.slice.call(value)[0]); } catch (err) { return Number(value); }
}
// Temporary R&D-only trace. It writes a bounded, sanitized sidecar beside the
// existing command receipt and never participates in command handling.
function writeCaptureTrace(eventName, detail) {
    if (!currentCapture) return;
    var entry = { event: eventName, atMs: new Date().getTime(), captureId: currentCapture.captureId,
        startBeat: currentCapture.startBeat, endBeat: currentCapture.endBeat, songTime: null, isPlaying: null };
    try {
        if (song) { entry.songTime = liveNumber(song, "current_song_time"); entry.isPlaying = liveNumber(song, "is_playing") !== 0; }
    } catch (err) { /* Trace observation is best effort only. */ }
    if (detail && typeof detail.reason === "string") entry.reason = detail.reason;
    traceEntries.push(entry);
    if (traceEntries.length > 16) traceEntries.shift();
    try {
        var file = new File(commandFile + "." + tapId + ".trace.json", "write");
        if (!file.isopen) return;
        file.eof = 0;
        file.writestring(JSON.stringify({ tapId: tapId, entries: traceEntries }));
        file.close();
    } catch (err) { /* Diagnostics must never change capture behavior. */ }
}
function armListen(value) {
    if (!boundedListen(value) || typeof value.path !== "string" || value.path.length === 0 || !song) { setCaptureFailure(value); return; }
    if (liveNumber(song, "is_playing") !== 0) { setCaptureFailure(value); return; }
    lastPath = value.path;
    currentCapture = { id: String(value.id), captureId: String(value.captureId), windowId: String(value.windowId),
        state: "armed", startBeat: Number(value.startBeat), endBeat: Number(value.endBeat) };
    traceEntries = [];
    writeCaptureTrace("armed");
    outlet(0, "open", lastPath, "wave");
    writeRegistry(); report("armed");
}
function beginListen(value) {
    if (!currentCapture || currentCapture.captureId !== String(value.captureId) || currentCapture.windowId !== String(value.windowId) ||
        currentCapture.state !== "armed" || !song || liveNumber(song, "is_playing") !== 0) { setCaptureFailure(value); return; }
    try {
        writeCaptureTrace("begin_received");
        listenSnapshot = { currentSongTime: liveNumber(song, "current_song_time"), startTime: liveNumber(song, "start_time"), isPlaying: liveNumber(song, "is_playing") };
        song.set("start_time", currentCapture.startBeat);
        song.set("current_song_time", currentCapture.startBeat);
        writeCaptureTrace("transport_positioned");
        // Live applies transport seeks asynchronously. Do not start the WAV
        // recorder or the end-beat monitor until its observable playhead has
        // actually reached the requested window start.
        listenActive = true; listenStartedPlayback = false; listenPlaybackObserved = false;
        listenAwaitingSeek = true; listenSeekAttempts = 0;
        currentCapture.id = String(value.id); currentCapture.state = "seeking";
        writeRegistry(); report("seeking");
        writeCaptureTrace("seek_requested");
        checkTransportPosition();
    } catch (err) { finishListen("failed"); }
}
function transportChanged(args) {
    if (!listenActive || !currentCapture || !args || args[0] !== "current_song_time") return;
    checkTransportPosition();
}
function checkTransportPosition() {
    if (!listenActive || !currentCapture || !song) return;
    try {
        var isPlaying = liveNumber(song, "is_playing") !== 0;
        var position = liveNumber(song, "current_song_time");
        if (listenAwaitingSeek) {
            if (Math.abs(position - currentCapture.startBeat) <= listenSeekToleranceBeats) {
                listenAwaitingSeek = false;
                writeCaptureTrace("seek_observed");
                isRecording = true; listenStartedPlayback = true; currentCapture.state = "recording";
                outlet(0, 1); writeRegistry(); report("recording");
                song.call("start_playing");
                writeCaptureTrace("start_playing_requested");
            } else {
                listenSeekAttempts += 1;
                if (listenSeekAttempts >= listenSeekAttemptLimit) {
                    writeCaptureTrace("stop_triggered", { reason: "seek_timeout" });
                    finishListen("failed");
                }
            }
            return;
        }
        if (isPlaying && !listenPlaybackObserved) { listenPlaybackObserved = true; writeCaptureTrace("playback_observed"); }
        if (position >= currentCapture.endBeat) {
            writeCaptureTrace("stop_triggered", { reason: "reached_end" });
            finishListen("stopped");
        } else if (listenPlaybackObserved && !isPlaying) {
            // The producer/host stopped before the selected end. Finalize and
            // restore rather than leaving a recording or a Smith command hung.
            writeCaptureTrace("stop_triggered", { reason: "playback_stopped" });
            finishListen("failed");
        }
    } catch (err) {
        writeCaptureTrace("stop_triggered", { reason: "transport_observation_error" });
        finishListen("failed");
    }
}
function cancelListen(value) {
    if (!currentCapture || currentCapture.captureId !== String(value.captureId)) return;
    finishListen("failed");
}
function finishListen(state) {
    var failed = state === "failed";
    writeCaptureTrace("finish_entered", { reason: state });
    try {
        if (isRecording) outlet(0, 0);
        isRecording = false;
        if (song && listenStartedPlayback) song.call("stop_playing");
        if (song && listenSnapshot) {
            song.set("current_song_time", listenSnapshot.currentSongTime);
            song.set("start_time", listenSnapshot.startTime);
        }
    } catch (err) { failed = true; }
    listenActive = false; listenStartedPlayback = false; listenPlaybackObserved = false;
    listenAwaitingSeek = false; listenSeekAttempts = 0; listenSnapshot = null;
    if (currentCapture) currentCapture.state = failed ? "failed" : "stopped";
    writeRegistry(); report(failed ? "listen_failed" : "listen_stopped");
    writeCaptureTrace("receipt_written", { reason: failed ? "failed" : "stopped" });
}
function setCaptureFailure(value) {
    if (boundedListen(value)) currentCapture = { id: String(value.id), captureId: String(value.captureId), windowId: String(value.windowId),
        state: "failed", startBeat: Number(value.startBeat), endBeat: Number(value.endBeat) };
    writeRegistry(); report("listen_failed");
}
function report(eventName) { writeRegistry(); outlet(1, JSON.stringify({ event: eventName, recording: isRecording, tap: parent() })); }
