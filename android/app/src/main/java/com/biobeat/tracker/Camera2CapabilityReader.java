package com.biobeat.tracker;

import android.content.Context;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

public final class Camera2CapabilityReader {
    private Camera2CapabilityReader() {}

    public static JSObject read(Context context) {
        JSObject ret = new JSObject();
        JSArray cameras = new JSArray();
        String preferred = null;
        try {
            CameraManager manager = (CameraManager) context.getSystemService(Context.CAMERA_SERVICE);
            for (String id : manager.getCameraIdList()) {
                CameraCharacteristics cc = manager.getCameraCharacteristics(id);
                Integer facing = cc.get(CameraCharacteristics.LENS_FACING);
                Boolean flash = cc.get(CameraCharacteristics.FLASH_INFO_AVAILABLE);
                JSObject cam = new JSObject();
                cam.put("cameraId", id);
                cam.put("lensFacing", facingToString(facing));
                cam.put("flashAvailable", Boolean.TRUE.equals(flash));
                cameras.put(cam);
                if (preferred == null && facing != null && facing == CameraCharacteristics.LENS_FACING_BACK) preferred = id;
            }
            ret.put("available", cameras.length() > 0);
            ret.put("provider", "camera2");
            ret.put("cameras", cameras);
            if (preferred != null) ret.put("preferredCameraId", preferred);
        } catch (CameraAccessException | RuntimeException e) {
            ret.put("available", false);
            ret.put("provider", "camera2");
            ret.put("cameras", cameras);
            ret.put("reason", e.getMessage());
        }
        return ret;
    }

    private static String facingToString(Integer facing) {
        if (facing == null) return "unknown";
        if (facing == CameraCharacteristics.LENS_FACING_BACK) return "back";
        if (facing == CameraCharacteristics.LENS_FACING_FRONT) return "front";
        if (facing == CameraCharacteristics.LENS_FACING_EXTERNAL) return "external";
        return "unknown";
    }
}
