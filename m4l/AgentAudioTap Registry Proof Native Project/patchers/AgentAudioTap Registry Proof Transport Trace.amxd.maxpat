{
    "patcher": {
        "fileversion": 1,
        "appversion": {
            "major": 9,
            "minor": 1,
            "revision": 5,
            "architecture": "x64",
            "modernui": 1
        },
        "classnamespace": "box",
        "rect": [ 239.0, 105.0, 557.0, 169.0 ],
        "openrect": [ 0.0, 0.0, 560.0, 169.0 ],
        "openrectmode": 0,
        "openinpresentation": 1,
        "default_fontsize": 10.0,
        "default_fontname": "Arial Bold",
        "gridsize": [ 8.0, 8.0 ],
        "boxanimatetime": 500,
        "devicewidth": 560.0,
        "description": "Agent-controlled audio tap for recording audio at this point in an Ableton signal chain.",
        "digest": "Agent audio tap",
        "tags": "agent,analysis,audio tap,recording",
        "boxes": [
            {
                "box": {
                    "id": "obj-plugin",
                    "maxclass": "newobj",
                    "numinlets": 2,
                    "numoutlets": 2,
                    "outlettype": [ "signal", "signal" ],
                    "patching_rect": [ 40.0, 48.0, 53.0, 20.0 ],
                    "text": "plugin~"
                }
            },
            {
                "box": {
                    "id": "obj-plugout",
                    "maxclass": "newobj",
                    "numinlets": 2,
                    "numoutlets": 2,
                    "outlettype": [ "signal", "signal" ],
                    "patching_rect": [ 40.0, 216.0, 53.0, 20.0 ],
                    "text": "plugout~"
                }
            },
            {
                "box": {
                    "id": "obj-recorder",
                    "maxclass": "newobj",
                    "numinlets": 2,
                    "numoutlets": 1,
                    "outlettype": [ "signal" ],
                    "patching_rect": [ 176.0, 216.0, 72.0, 20.0 ],
                    "text": "sfrecord~ 2"
                }
            },
            {
                "box": {
                    "id": "obj-udp",
                    "maxclass": "newobj",
                    "numinlets": 1,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 176.0, 48.0, 116.0, 20.0 ],
                    "text": "udpreceive 17654"
                }
            },
            {
                "box": {
                    "id": "obj-tosymbol",
                    "maxclass": "newobj",
                    "numinlets": 1,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 176.0, 80.0, 59.0, 20.0 ],
                    "text": "tosymbol"
                }
            },
            {
                "box": {
                    "id": "obj-js",
                    "linecount": 6,
                    "maxclass": "newobj",
                    "numinlets": 1,
                    "numoutlets": 4,
                    "outlettype": [ "", "", "", "" ],
                    "patching_rect": [ 176.0, 112.0, 139.0, 76.0 ],
                    "saved_object_attributes": {
                        "filename": "agent_audio_tap_registry.js",
                        "parameter_enable": 0
                    },
                    "text": "js agent_audio_tap_registry.js \"/Volumes/T7 Shield/Users/Aditya/.ableton-live-mcp/agent_audio_tap_command.json\""
                }
            },
            {
                "box": {
                    "hidden": 1,
                    "id": "obj-loadbang",
                    "maxclass": "newobj",
                    "numinlets": 1,
                    "numoutlets": 1,
                    "outlettype": [ "bang" ],
                    "patching_rect": [ 328.0, 80.0, 55.0, 20.0 ],
                    "text": "loadbang"
                }
            },
            {
                "box": {
                    "id": "obj-notein",
                    "maxclass": "newobj",
                    "numinlets": 1,
                    "numoutlets": 3,
                    "outlettype": [ "int", "int", "int" ],
                    "patching_rect": [ 328.0, 48.0, 45.0, 20.0 ],
                    "text": "notein"
                }
            },
            {
                "box": {
                    "id": "obj-stripnote",
                    "maxclass": "newobj",
                    "numinlets": 2,
                    "numoutlets": 2,
                    "outlettype": [ "int", "int" ],
                    "patching_rect": [ 328.0, 112.0, 55.0, 20.0 ],
                    "text": "stripnote"
                }
            },
            {
                "box": {
                    "id": "obj-midi-select",
                    "maxclass": "newobj",
                    "numinlets": 3,
                    "numoutlets": 3,
                    "outlettype": [ "bang", "bang", "" ],
                    "patching_rect": [ 328.0, 144.0, 59.0, 20.0 ],
                    "text": "sel 60 61"
                }
            },
            {
                "box": {
                    "id": "obj-midi-start",
                    "maxclass": "message",
                    "numinlets": 2,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 328.0, 176.0, 35.0, 20.0 ],
                    "text": "start"
                }
            },
            {
                "box": {
                    "id": "obj-midi-stop",
                    "maxclass": "message",
                    "numinlets": 2,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 376.0, 176.0, 32.0, 20.0 ],
                    "text": "stop"
                }
            },
            {
                "box": {
                    "id": "obj-status-send",
                    "maxclass": "newobj",
                    "numinlets": 1,
                    "numoutlets": 0,
                    "patching_rect": [ 272.0, 152.0, 139.0, 20.0 ],
                    "text": "s agent_audio_tap_status"
                }
            },
            {
                "box": {
                    "id": "obj-print",
                    "maxclass": "newobj",
                    "numinlets": 1,
                    "numoutlets": 0,
                    "patching_rect": [ 424.0, 152.0, 112.0, 20.0 ],
                    "text": "print AgentAudioTap"
                }
            },
            {
                "box": {
                    "id": "obj-title",
                    "maxclass": "live.comment",
                    "numinlets": 1,
                    "numoutlets": 0,
                    "patching_rect": [ 16.0, 8.0, 220.0, 18.0 ],
                    "presentation": 1,
                    "presentation_rect": [ 12.0, 10.0, 220.0, 18.0 ],
                    "text": "Smith Listener",
                    "textjustification": 0
                }
            },
            {
                "box": {
                    "hidden": 1,
                    "id": "obj-note",
                    "maxclass": "live.comment",
                    "numinlets": 1,
                    "numoutlets": 0,
                    "patching_rect": [ 16.0, 272.0, 488.0, 18.0 ],
                    "text": "Controlled by Ableton MCP on UDP 127.0.0.1:17654; audio passes through unchanged.",
                    "textjustification": 0
                }
            },
            {
                "box": {
                    "hidden": 1,
                    "id": "obj-limit",
                    "maxclass": "comment",
                    "numinlets": 1,
                    "numoutlets": 0,
                    "patching_rect": [ 0.0, 170.0, 134.0, 18.0 ],
                    "text": "Device vertical limit"
                }
            },
            {
                "box": {
                    "hidden": 1,
                    "id": "obj-live-ready",
                    "maxclass": "newobj",
                    "numinlets": 1,
                    "numoutlets": 3,
                    "outlettype": [ "bang", "int", "int" ],
                    "patching_rect": [ 328.0, 112.0, 90.0, 20.0 ],
                    "text": "live.thisdevice"
                }
            },
            {
                "box": {
                    "hidden": 1,
                    "id": "obj-tap-id",
                    "linecount": 2,
                    "maxclass": "newobj",
                    "numinlets": 1,
                    "numoutlets": 3,
                    "outlettype": [ "", "", "" ],
                    "patching_rect": [ 328.0, 140.0, 232.0, 31.0 ],
                    "restore": [ "tap_1a0ed5133d3_2b08674c" ],
                    "saved_attribute_attributes": {
                        "valueof": {
                            "parameter_longname": "tap_identity",
                            "parameter_modmode": 4,
                            "parameter_shortname": "tap_identity",
                            "parameter_type": 1
                        }
                    },
                    "saved_object_attributes": {
                        "parameter_enable": 1,
                        "parameter_mappable": 0
                    },
                    "text": "pattr tap_identity @initial @parameter_enable 1",
                    "varname": "tap_identity"
                }
            },
            {
                "box": {
                    "fontname": "Arial Bold",
                    "fontsize": 14.0,
                    "id": "obj-parent-label",
                    "maxclass": "message",
                    "numinlets": 2,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 328.0, 168.0, 220.0, 24.0 ],
                    "presentation": 1,
                    "presentation_rect": [ 12.0, 38.0, 300.0, 24.0 ],
                    "text": "Unavailable"
                }
            }
        ],
        "lines": [
            {
                "patchline": {
                    "destination": [ "obj-parent-label", 0 ],
                    "source": [ "obj-js", 3 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-print", 0 ],
                    "source": [ "obj-js", 2 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-recorder", 0 ],
                    "source": [ "obj-js", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-status-send", 0 ],
                    "source": [ "obj-js", 1 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-js", 0 ],
                    "source": [ "obj-live-ready", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-live-ready", 0 ],
                    "source": [ "obj-loadbang", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-midi-start", 0 ],
                    "source": [ "obj-midi-select", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-midi-stop", 0 ],
                    "source": [ "obj-midi-select", 1 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-js", 0 ],
                    "source": [ "obj-midi-start", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-js", 0 ],
                    "source": [ "obj-midi-stop", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-stripnote", 1 ],
                    "source": [ "obj-notein", 1 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-stripnote", 0 ],
                    "source": [ "obj-notein", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-plugout", 1 ],
                    "order": 1,
                    "source": [ "obj-plugin", 1 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-plugout", 0 ],
                    "order": 1,
                    "source": [ "obj-plugin", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-recorder", 1 ],
                    "order": 0,
                    "source": [ "obj-plugin", 1 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-recorder", 0 ],
                    "order": 0,
                    "source": [ "obj-plugin", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-midi-select", 0 ],
                    "source": [ "obj-stripnote", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-js", 0 ],
                    "source": [ "obj-tosymbol", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-tosymbol", 0 ],
                    "source": [ "obj-udp", 0 ]
                }
            }
        ],
        "parameters": {
            "obj-tap-id": [ "tap_identity", "tap_identity", 0 ],
            "parameterbanks": {
                "0": {
                    "index": 0,
                    "name": "",
                    "parameters": [ "-", "-", "-", "-", "-", "-", "-", "-" ],
                    "buttons": [ "-", "-", "-", "-", "-", "-", "-", "-" ]
                }
            },
            "inherited_shortname": 1
        },
        "autosave": 0
    }
}