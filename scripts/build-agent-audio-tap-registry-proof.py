"""Build a disposable control-layer variant without changing upstream DSP wiring."""
from __future__ import annotations
import json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UPSTREAM = ROOT.parent / "ableton-live-mcp-research"
sys.path.insert(0, str(UPSTREAM / "src"))
from agent_m4l import build_amxd

out = ROOT / "m4l" / "AgentAudioTap Registry Proof.amxd"
command_file = Path.home() / ".ableton-live-mcp" / "agent_audio_tap_command.json"
patch = json.loads((UPSTREAM / "m4l" / "AgentAudioTap.maxpat").read_text())
boxes = patch["patcher"]["boxes"]
for entry in boxes:
    box = entry["box"]
    if box.get("id") == "obj-js":
        box["text"] = f'js agent_audio_tap_registry.js "{command_file}"'
        box["numoutlets"] = 4
        box["outlettype"] = ["", "", "", ""]
    if box.get("id") == "obj-loadbang": box["hidden"] = 1
    if box.get("id") == "obj-title":
        box["text"] = "Smith Listener"
        box["presentation_rect"] = [12.0, 10.0, 220.0, 18.0]
    if box.get("id") == "obj-note":
        # The upstream device's visible UDP/MCP copy is false for this Smith
        # proof. Replace it with a dynamically populated parent label below.
        box["hidden"] = 1
        box["presentation"] = 0
boxes.extend([
  {"box":{"id":"obj-live-ready","maxclass":"newobj","numinlets":1,"numoutlets":3,"outlettype":["bang","int","int"],"patching_rect":[328.0,112.0,90.0,20.0],"text":"live.thisdevice","hidden":1}},
  {"box":{"id":"obj-tap-id","maxclass":"newobj","numinlets":1,"numoutlets":1,"outlettype":[""],"patching_rect":[328.0,140.0,80.0,20.0],"text":"pattr tap_identity @initial \\\"\\\" @parameter_enable 1 @parameter_visibility 1","varname":"tap_identity","hidden":1}},
  {"box":{"id":"obj-parent-label","maxclass":"message","numinlets":2,"numoutlets":1,"outlettype":[""],"patching_rect":[328.0,168.0,220.0,22.0],"presentation":1,"presentation_rect":[12.0,38.0,300.0,24.0],"text":"Loading listener…","fontname":"Arial Bold","fontsize":14.0}}
])
lines = patch["patcher"]["lines"]
# The upstream patch lets loadbang start the JavaScript immediately.  For the
# registry proof, wait until live.thisdevice has confirmed a valid Max for
# Live device context, then initialize the JavaScript from that confirmation.
patch["patcher"]["lines"] = [
    line for line in lines
    if not (line["patchline"].get("source") == ["obj-loadbang", 0]
            and line["patchline"].get("destination") == ["obj-js", 0])
]
patch["patcher"]["lines"].extend([
    {"patchline":{"source":["obj-loadbang",0],"destination":["obj-live-ready",0]}},
    {"patchline":{"source":["obj-live-ready",0],"destination":["obj-js",0]}},
    {"patchline":{"source":["obj-js",3],"destination":["obj-parent-label",0]}},
])
patch["patcher"]["dependency_cache"].append({"name":"agent_audio_tap_registry.js","bootpath":".","patcherrelativepath":".","type":"TEXT","implicit":1})
source = ROOT / "m4l" / "AgentAudioTap Registry Proof.maxpat"
source.write_text(json.dumps(patch, indent=2))
build_amxd(source, out, "audio_effect")
print(out)
