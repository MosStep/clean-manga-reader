// การตั้งค่าระบบ Clean Manga Reader
const CONFIG = {
  // Proxy URL สำหรับ Local Test หรือเปลี่ยนเป็น Cloudflare Worker เมื่อขึ้น GitHub
  PROXY_URL: window.location.origin.includes('localhost') || window.location.origin.includes('127.0.0.1')
    ? '/api/proxy?url='
    : 'https://manga-proxy.free-reader.workers.dev/?url=',

  // รายการเว็บต้นทางทั้งหมด
  // เว็บที่ readable: true สามารถอ่านภาพแนวตั้งได้สมบูรณ์แบบในเว็บนี้ 100%
  // เว็บที่ readable: false เป็นเว็บที่มีระบบเหรียญหรือเข้ารหัสของค่ายต้นทาง (มีปุ่มเปิดอ่านเว็บต้นทางให้)
  SOURCES: [
    { id: 'go-manga', name: 'Go-Manga', url: 'https://www.go-manga.com', type: 'mangareader', icon: '⚡', readable: true, isCoin: false },
    { id: 'slow-manga', name: 'Slow-Manga', url: 'https://www.slow-manga.net', type: 'mangareader', icon: '🐢', readable: true, isCoin: false },
    { id: 'ntr-manga', name: 'NTR-Manga', url: 'https://www.ntr-manga.net', type: 'mangareader', icon: '🔥', readable: true, isCoin: false },
    { id: 'dark-manga', name: 'Dark-Manga', url: 'https://www.dark-manga.com', type: 'mangareader', icon: '🌑', readable: true, isCoin: false },
    { id: 'fin-manga', name: 'Fin-Manga', url: 'https://www.fin-manga.com', type: 'mangareader', icon: '🌸', readable: true, isCoin: false },
    { id: 'up-manga', name: 'Up-Manga', url: 'https://www.up-manga.com', type: 'mangareader', icon: '🚀', readable: true, isCoin: false },
    { id: 'whytoon', name: 'WhyToon', url: 'https://whytoon.com', type: 'whytoon', icon: '📱', readable: true, isCoin: false },
    { id: 'speed-manga', name: 'Speed-Manga', url: 'https://speed-manga.net', type: 'mangareader', icon: '⚡', readable: true, isCoin: false },
    { id: 'du-manga', name: 'Du-Manga', url: 'https://www.du-manga.com', type: 'madara', icon: '📖', readable: true, isCoin: false },
    { id: 'manga-lc', name: 'Manga-LC', url: 'https://manga-lc.net', type: 'madara', icon: '📚', readable: true, isCoin: false },
    { id: 'ecchi-doujin', name: 'Ecchi-Doujin', url: 'https://ecchi-doujin.com', type: 'mangareader', icon: '🔞', readable: true, isCoin: false },
    { id: 'readtoon', name: 'ReadToon (ติดเหรียญ)', url: 'https://readtoon.com', type: 'readtoon', icon: '🔒', readable: false, isCoin: true },
    { id: 'ntrnaja', name: 'NTRnaja (ติดเหรียญ)', url: 'https://ntrnaja.com', type: 'ntrnaja', icon: '🔒', readable: false, isCoin: true },
    { id: 'kairew', name: 'Kairew (เข้ารหัส)', url: 'https://kairew.com', type: 'kairew', icon: '🔒', readable: false, isCoin: true }
  ],

  DEFAULT_SOURCE_ID: 'all'
};
