ANPR YOLO Colab Backend + Frontend v2
====================================

What changed in v2
------------------
1. Region-aware regex cleaning removes side/badge text like IND from OCR output.
2. Frontend can send a region hint: AUTO, IN, UK, EU, US, CA, AU.
3. Backend reuses OCR text for the same track for a few seconds, so moving vehicles can be processed faster.
4. Frontend defaults to 5 FPS, JPEG quality 0.65, OCR every 3 frames, and max frame width 960.

Recommended live settings
-------------------------
For moving vehicles:
- FPS: 4 to 8
- OCR every N frames: 3 to 5
- Max frame width: 960 or 1280
- JPEG quality: 0.60 to 0.75
- Region hint: choose the country/region if known. Use AUTO only for mixed feeds.

Important
---------
If the frontend sends only 1 frame per second, the backend cannot truly lock onto a fast vehicle between frames. The backend can only detect what it receives. For fast motion, increase FPS and reduce OCR frequency.

Backend API
-----------
POST /detect_frame
Form fields:
- image: JPG/PNG frame
- source_id: camera/source name
- conf: YOLO confidence, e.g. 0.25
- iou: YOLO IoU, e.g. 0.45
- ocr_enabled: true/false
- region_hint: AUTO, IN, UK, EU, US, CA, AU

Main response fields:
- detections[].box
- detections[].plate_text
- detections[].raw_ocr_text
- detections[].detection_confidence
- detections[].ocr_confidence
- detections[].format_pattern
- detections[].track_id
- detections[].is_unique_within_2h

Files
-----
1. ANPR_YOLO_Backend_Colab.ipynb  -> run in Google Colab
2. index.html                     -> open in browser
3. app.js                         -> frontend logic

