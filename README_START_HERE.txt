ANPR YOLO Colab Backend + Frontend
====================================

Files:
1. ANPR_YOLO_Backend_Colab.ipynb
   - Upload this to Google Colab.
   - Upload your trained best.pt when prompted.
   - Add Colab secret named NGROK_AUTHTOKEN.
   - Run all cells.
   - Copy the printed ngrok URL.

2. index.html
3. app.js
   - Keep both files in the same folder.
   - Open index.html in a browser.
   - Paste the ngrok backend URL.
   - Start camera or use a direct CORS-enabled video URL.

Important:
- best.pt detects the plate location.
- EasyOCR reads the plate number from the cropped plate.
- The backend returns JSON containing box coordinates, plate text, and confidence.
- Unique plates are tracked in memory for 2 hours per source_id.
- Colab/ngrok is suitable for testing, not permanent production hosting.

Browser limitations:
- YouTube cannot be frame-captured directly from normal browser JS because of cross-origin restrictions.
- RTSP cannot be opened directly by browser JS. Use RTSP-to-WebRTC/HLS conversion, or process RTSP server-side.
- Mobile camera requires HTTPS or localhost.
