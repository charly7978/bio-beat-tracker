package com.biobeat.tracker;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NativePpgCapture")
public class NativePpgCapturePlugin extends Plugin {
    @PluginMethod
    public void getCapabilities(PluginCall call) {
        call.resolve(Camera2CapabilityReader.read(getContext()));
    }
}
