# 🎥 Meeting Room — Video Conference

ห้องประชุมวิดีโอคอลออนไลน์ใช้งานข้ามอินเทอร์เน็ตจริง รองรับ:
- ✅ วิดีโอ + เสียง (WebRTC P2P)
- ✅ แชร์หน้าจอ
- ✅ Chat ข้อความ
- ✅ บันทึกการประชุม (ไฟล์ .webm)
- ✅ รองรับหลายคนในห้องเดียวกัน

---

## 📦 โครงสร้างไฟล์

```
meeting-app/
├── server.js          ← Signaling server (Node.js + Socket.io)
├── package.json
└── public/
    └── index.html     ← Frontend (HTML + JS + WebRTC)
```

---

## 🚀 วิธีติดตั้งและรัน (Local)

### 1. ติดตั้ง Node.js
ดาวน์โหลดจาก https://nodejs.org (เวอร์ชัน 18+)

### 2. ติดตั้ง dependencies
เปิด terminal ที่โฟลเดอร์ `meeting-app`:
```bash
npm install
```

### 3. รัน server
```bash
npm start
```

จะเห็นข้อความ:
```
▶ Running on: http://localhost:3000
```

### 4. เปิดในเบราว์เซอร์
ไปที่ `http://localhost:3000`

---

## 🌐 วิธี Deploy ขึ้นอินเทอร์เน็ต (ให้คนอื่นเข้าได้)

### ⚠️ ข้อกำหนดสำคัญ
- **ต้องใช้ HTTPS** เท่านั้น (เบราว์เซอร์ไม่อนุญาตให้เข้าถึงกล้อง/ไมค์ผ่าน HTTP ยกเว้น localhost)
- ใช้ public IP หรือ domain name

### ตัวเลือกที่ 1: Render.com (ง่ายที่สุด, ฟรี)

1. Push โค้ดขึ้น GitHub
2. ไปที่ https://render.com → New Web Service
3. เชื่อมต่อ repo
4. ตั้งค่า:
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
5. Deploy → จะได้ URL เช่น `https://your-app.onrender.com`

### ตัวเลือกที่ 2: Railway.app

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

### ตัวเลือกที่ 3: VPS ของตัวเอง (DigitalOcean, AWS, etc.)

1. ติดตั้ง Node.js บน server
2. Clone โค้ดและ `npm install`
3. ใช้ PM2 รัน server:
   ```bash
   npm install -g pm2
   pm2 start server.js --name meeting
   pm2 startup
   pm2 save
   ```
4. ตั้งค่า Nginx + Let's Encrypt สำหรับ HTTPS:
   ```nginx
   server {
     listen 443 ssl;
     server_name meet.yourdomain.com;

     ssl_certificate /etc/letsencrypt/live/meet.yourdomain.com/fullchain.pem;
     ssl_certificate_key /etc/letsencrypt/live/meet.yourdomain.com/privkey.pem;

     location / {
       proxy_pass http://localhost:3000;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
     }
   }
   ```

### ตัวเลือกที่ 4: ทดสอบเร็วด้วย ngrok (สำหรับทดสอบเท่านั้น)

```bash
# Terminal 1
npm start

# Terminal 2
npx ngrok http 3000
```

ngrok จะให้ URL https://xxxx.ngrok.io มา ใช้ได้ทันที

---

## 🔧 TURN Server (สำคัญสำหรับ Production!)

WebRTC ใช้ **STUN** เพื่อหา IP จริง แต่ถ้าผู้ใช้อยู่หลัง NAT แบบ symmetric (เช่น 4G/บริษัทใหญ่ ๆ) ต้องใช้ **TURN server**

แก้ในไฟล์ `public/index.html` ส่วน `rtcConfig`:

```javascript
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    // เพิ่ม TURN server
    {
      urls: 'turn:your.turn.server:3478',
      username: 'your-username',
      credential: 'your-password',
    },
  ],
};
```

**TURN Server แนะนำ:**
- **Metered.ca** — ฟรี 50GB/เดือน → https://www.metered.ca/tools/openrelay/
- **Twilio** — เสียเงิน แต่ stable
- **Coturn** — Open source, host เอง

---

## 💡 วิธีใช้งาน

1. เปิด URL → อนุญาตกล้อง/ไมค์
2. ใส่ชื่อและรหัสห้อง
3. แชร์ลิงก์และรหัสห้องให้เพื่อนร่วมงาน
4. ทุกคนใส่รหัสห้องเดียวกัน → จะเห็นกันอัตโนมัติ

---

## ⚠️ ข้อจำกัด

- **Mesh topology**: ทุก peer เชื่อมกันโดยตรง รองรับได้ดีถึง **~6-8 คน/ห้อง**
- ถ้าต้องการ 10+ คน ควรใช้ SFU เช่น **mediasoup**, **Janus**, **LiveKit**
- การบันทึกทำงานในเบราว์เซอร์ของผู้บันทึก (ไม่ใช่ server-side recording)

---

## 🛠️ Tech Stack

- **Backend**: Node.js, Express, Socket.io
- **Frontend**: Vanilla JS, WebRTC API
- **Protocols**: WebSocket (signaling), WebRTC (media)
