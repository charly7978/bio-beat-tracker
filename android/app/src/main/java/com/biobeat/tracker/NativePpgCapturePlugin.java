package com.biobeat.tracker;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NativePpgCapture")
public class NativePpgCapturePlugin extends Plugin {
    @PluginMethod
    public void getCapabilities(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("available", false);
        ret.put("provider", "camera2");
        ret.put("reason", "capability_scaffold");
        call.resolve(ret);
    }
}
