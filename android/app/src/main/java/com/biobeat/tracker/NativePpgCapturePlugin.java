package com.biobeat.tracker;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NativePpgCapture")
public class NativePpgCapturePlugin extends Plugin {
    private JSObject runtimeProfile;

    @PluginMethod
    public void getCapabilities(PluginCall call) {
        call.resolve(Camera2CapabilityReader.read(getContext()));
    }

    @PluginMethod
    public void configure(PluginCall call) {
        runtimeProfile = buildRuntimeProfile(call);
        call.resolve(runtimeProfile);
    }

    @PluginMethod
    public void start(PluginCall call) {
        runtimeProfile = buildRuntimeProfile(call);
        call.resolve(runtimeProfile);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("stopped", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void getRuntimeProfile(PluginCall call) {
        if (runtimeProfile == null) runtimeProfile = buildRuntimeProfile(call);
        call.resolve(runtimeProfile);
    }

    private JSObject buildRuntimeProfile(PluginCall call) {
        JSObject ret = new JSObject();
        Integer fps = call.getInt("targetFps", 30);
        String cameraId = call.getString("cameraId", null);
        ret.put("provider", "camera2");
        if (cameraId != null) ret.put("cameraId", cameraId);
        ret.put("targetFps", fps != null ? fps : 30);
        ret.put("torchSupported", true);
        ret.put("torchVerified", false);
        ret.put("exposureLockSupported", true);
        ret.put("whiteBalanceLockSupported", true);
        return ret;
    }
}
