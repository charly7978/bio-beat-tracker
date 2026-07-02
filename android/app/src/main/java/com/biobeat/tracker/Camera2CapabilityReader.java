package com.biobeat.tracker;

import android.content.Context;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.util.Range;

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
                Integer orientation = cc.get(CameraCharacteristics.SENSOR_ORIENTATION);
                Integer level = cc.get(CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL);
                JSObject cam = new JSObject();
                cam.put("cameraId", id);
                cam.put("lensFacing", facingToString(facing));
                cam.put("flashAvailable", Boolean.TRUE.equals(flash));
                cam.put("sensorOrientation", orientation != null ? orientation : 0);
                cam.put("hardwareLevel", hardwareLevel(level));
                cam.put("fpsRanges", fpsRanges(cc));
                putRange(cam, "isoRange", cc.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE));
                putLongRange(cam, "exposureTimeRangeNs", cc.get(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE));
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

    private static JSArray fpsRanges(CameraCharacteristics cc) {
        JSArray arr = new JSArray();
        Range<Integer>[] ranges = cc.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES);
        if (ranges == null) return arr;
        for (Range<Integer> r : ranges) {
            JSObject o = new JSObject();
            o.put("min", r.getLower());
            o.put("max", r.getUpper());
            arr.put(o);
        }
        return arr;
    }

    private static void putRange(JSObject target, String key, Range<Integer> range) {
        if (range == null) return;
        JSObject o = new JSObject();
        o.put("min", range.getLower());
        o.put("max", range.getUpper());
        target.put(key, o);
    }

    private static void putLongRange(JSObject target, String key, Range<Long> range) {
        if (range == null) return;
        JSObject o = new JSObject();
        o.put("min", range.getLower());
        o.put("max", range.getUpper());
        target.put(key, o);
    }

    private static String facingToString(Integer facing) {
        if (facing == null) return "unknown";
        if (facing == CameraCharacteristics.LENS_FACING_BACK) return "back";
        if (facing == CameraCharacteristics.LENS_FACING_FRONT) return "front";
        if (facing == CameraCharacteristics.LENS_FACING_EXTERNAL) return "external";
        return "unknown";
    }

    private static String hardwareLevel(Integer level) {
        if (level == null) return "unknown";
        if (level == CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_LEGACY) return "legacy";
        if (level == CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_LIMITED) return "limited";
        if (level == CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_FULL) return "full";
        if (level == CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_3) return "level_3";
        return "unknown";
    }
}
