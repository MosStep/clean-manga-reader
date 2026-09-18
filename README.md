# 📖 Clean Manga Reader (เว็บอ่านการ์ตูนไร้โฆษณา & ระบบรวมเว็บการ์ตูนอัจฉริยะ)

โปรเจกต์เว็บรวมมังงะสไตล์มินิมอล โหลดไว ไม่มีโฆษณากวนใจ 100% รวมมังงะจากหลากหลายค่ายมาไว้ในที่เดียว พร้อมระบบจัดอันดับ **"เว็บฟรีขึ้นก่อนเป็นหลัก"**, **ระบบประวัติการอ่านและเรื่องโปรด (บันทึกในเครื่องอัตโนมัติ)**, **ระบบตรวจสอบเว็บขัดข้อง (🔴 แจ้งเตือนสีแดง)** และตัวอ่านภาพแนวตั้งสไตล์ Webtoon ออกแบบมาสำหรับนำไปเปิดใช้งานบน **GitHub Pages** ควบคู่กับ **Cloudflare Worker (ฟรี 100%)**

---

## 🌟 ฟีเจอร์เด่น (Key Features)

- 🚫 **ไม่มีโฆษณา 100%:** ป้องกันโฆษณาป๊อปอัป แบนเนอร์เว็บพนัน และลิงก์สแปมทุกชนิด
- ⚡ **จัดลำดับเว็บฟรีขึ้นก่อน (Free-First Priority):** รวมเรื่องที่ซ้ำกันข้ามเว็บ และคัดเลือกเว็บที่เปิดให้อ่านฟรีตอนล่าสุดขึ้นเป็นตัวเลือกหลักเสมอ
- 🕒 **ระบบจำประวัติการอ่าน & เรื่องโปรด (localStorage):** ไม่ต้องสมัครสมาชิก ไม่ต้องล็อกอิน ข้อมูลบันทึกไว้ในเครื่องของผู้ใช้ถาวร แม้ปิดเครื่องหรือรีเฟรชก็ไม่หาย
- 🔴 **ระบบตรวจสอบสถานะเว็บขัดข้อง (Health Check):** หากเว็บต้นทางเว็บไหนปิดปรับปรุงหรือล่ม ระบบจะขึ้นป้ายเตือน 🔴 ขัดข้อง ให้ทราบทันที
- 📱 **Webtoon Vertical Reader:** เลื่อนอ่านภาพแนวตั้งเต็มจอ คมชัด รองรับมือถือและคอมพิวเตอร์อย่างลื่นไหล
- 🆓 **Zero Cost Hosting:** ใช้งานผ่าน GitHub Pages ร่วมกับ Cloudflare Worker ได้ฟรีตลอดชีพ

---

## 🚀 1. วิธีรันใช้งานในเครื่อง (Local Run)

1. ดับเบิลคลิกไฟล์ un.bat หรือเปิด PowerShell แล้วรันคำสั่ง:
   `powershell
   powershell -ExecutionPolicy Bypass -File .\local_server.ps1
   `
2. เปิดเบราว์เซอร์ไปที่: **http://localhost:7777/**

---

## 🌐 2. วิธีนำขึ้น GitHub & เปิดใช้งาน GitHub Pages

### ขั้นตอนที่ 2.1: สร้าง Repository บน GitHub
1. เข้าเว็บไซต์ [github.com](https://github.com/) แล้วเข้าสู่ระบบ
2. กดปุ่ม **New Repository** (หรือเครื่องหมาย + มุมขวาบน)
3. ตั้งชื่อ Repository เช่น clean-manga-reader (เลือกเป็น **Public**)
4. **ไม่ต้อง** ติ๊กถูกที่ 'Add a README file' แล้วกด **Create repository**

### ขั้นตอนที่ 2.2: Push โค้ดขึ้น GitHub
เปิด Terminal / PowerShell ในโฟลเดอร์นี้ แล้วรันคำสั่ง:
`ash
git remote add origin https://github.com/<YOUR_USERNAME>/clean-manga-reader.git
git branch -M main
git push -u origin main
`
*(ระบบจะให้เข้าสู่ระบบ GitHub หรือป้อน Personal Access Token)*

### ขั้นตอนที่ 2.3: เปิดใช้งาน GitHub Pages (ให้เพื่อนหรือคนอื่นเปิดอ่านออนไลน์ได้)
1. ไปที่หน้า Repository ของคุณบน GitHub
2. คลิกแท็บ **Settings** > เลือกเมนู **Pages** (แถบซ้ายมือ)
3. ในส่วน **Build and deployment > Branch**:
   - เลือก Branch เป็น main
   - เลือก Folder เป็น / (root)
   - กดปุ่ม **Save**
4. รอระบบประมวลผล 1-2 นาที จะได้รับลิงก์เว็บไซต์ เช่น:
   `
   https://<YOUR_USERNAME>.github.io/clean-manga-reader/
   `

---

## ⚡ 3. การตั้งค่า Proxy ข้ามโดเมน (Cloudflare Worker ฟรี)

เนื่องจากเว็บเบราว์เซอร์มีระบบรักษาความปลอดภัย **CORS (Cross-Origin Resource Sharing)** เมื่อเปิดเว็บผ่าน GitHub Pages การจะดึงภาพหรือข้อมูลจากเว็บการ์ตูนต้นทาง จำเป็นต้องมี Proxy ช่วยส่งต่อข้อมูล (ทำฟรี 100%):

1. สมัคร/เข้าสู่ระบบ [dash.cloudflare.com](https://dash.cloudflare.com/) (ฟรี)
2. ไปที่เมนู **Workers & Pages** > กด **Create** > **Create Worker**
3. ตั้งชื่อ Worker เช่น my-manga-proxy แล้วกด **Deploy**
4. กดปุ่ม **Edit Code**
5. นำโค้ดทั้งหมดจากไฟล์ worker/worker.js ไปวางแทนที่โค้ดเดิมทั้งหมด แล้วกด **Deploy**
6. คัดลอก URL ของ Worker ที่ได้ เช่น https://my-manga-proxy.yourname.workers.dev
7. เปิดไฟล์ config.js ในโปรเจกต์นี้ แก้ไขค่า PROXY_URL (บรรทัดที่ 6) เป็น URL Worker ของคุณ:
   `javascript
   PROXY_URL: window.location.origin.includes('localhost') || window.location.origin.includes('127.0.0.1')
     ? '/api/proxy?url='
     : 'https://my-manga-proxy.yourname.workers.dev/?url=',
   `
8. Commit & Push ขึ้น GitHub อีกครั้ง เว็บของคุณจะสามารถอ่านการ์ตูนได้จากทุกที่ทั่วโลกทันที!
