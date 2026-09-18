// การตั้งค่าระบบ Clean Manga Reader
const CONFIG = {
  // Proxy URL สำหรับ Local Test, Cloudflare Worker, หรือ GitHub Pages
  PROXY_URL: (window.location.origin.includes('localhost') || window.location.origin.includes('127.0.0.1') || window.location.hostname.endsWith('workers.dev') || window.location.hostname.endsWith('pages.dev'))
    ? '/api/proxy?url='
    : 'https://clean-manga-reader.mosstep.workers.dev/api/proxy?url=',

  // URL ระบบแชทส่วนกลาง
  CHAT_API_URL: (window.location.origin.includes('localhost') || window.location.origin.includes('127.0.0.1') || window.location.hostname.endsWith('workers.dev') || window.location.hostname.endsWith('pages.dev'))
    ? '/api/chat'
    : 'https://clean-manga-reader.mosstep.workers.dev/api/chat',

  // Base URL สำหรับระบบ Private Sync Key ข้ามอุปกรณ์
  SYNC_API_BASE: (window.location.origin.includes('localhost') || window.location.origin.includes('127.0.0.1') || window.location.hostname.endsWith('workers.dev') || window.location.hostname.endsWith('pages.dev'))
    ? '/api/sync'
    : 'https://clean-manga-reader.mosstep.workers.dev/api/sync',

  // รายการเว็บต้นทางทั้งหมด
  // เว็บที่ readable: true สามารถอ่านภาพแนวตั้งได้สมบูรณ์แบบในเว็บนี้ 100%
  // เว็บที่ readable: false เป็นเว็บที่มีระบบเหรียญหรือเข้ารหัสของค่ายต้นทาง (มีปุ่มเปิดอ่านเว็บต้นทางให้)
  SOURCES: [
    { id: 'go-manga', name: 'Go-Manga', url: 'https://www.go-manga.com', type: 'mangareader', icon: '⚡', readable: true, isCoin: false },
    { id: 'slow-manga', name: 'Slow-Manga', url: 'https://www.slow-manga.net', type: 'mangareader', icon: '🐢', readable: true, isCoin: false },
    { id: 'ped-manga', name: 'Ped-Manga', url: 'https://ped-manga.com', type: 'mangareader', icon: '🦆', readable: true, isCoin: false },
    { id: 'manga-step', name: 'MangaStep', url: 'https://mangastep.com', type: 'mangareader', icon: '🐾', readable: true, isCoin: false },
    { id: 'ntr-manga', name: 'NTR-Manga', url: 'https://www.ntr-manga.net', type: 'mangareader', icon: '🔥', readable: true, isCoin: false },
    { id: 'dark-manga', name: 'Dark-Manga', url: 'https://www.dark-manga.com', type: 'mangareader', icon: '🌑', readable: true, isCoin: false },
    { id: 'fin-manga', name: 'Fin-Manga', url: 'https://www.fin-manga.com', type: 'mangareader', icon: '🌸', readable: true, isCoin: false },
    { id: 'up-manga', name: 'Up-Manga', url: 'https://www.up-manga.com', type: 'mangareader', icon: '🚀', readable: true, isCoin: false },
    { id: 'speed-manga', name: 'Speed-Manga', url: 'https://speed-manga.net', type: 'mangareader', icon: '⚡', readable: true, isCoin: false },
    { id: 'du-manga', name: 'Du-Manga', url: 'https://www.du-manga.com', type: 'madara', icon: '📖', readable: true, isCoin: false },
    { id: 'manga-lc', name: 'Manga-LC', url: 'https://manga-lc.net', type: 'madara', icon: '📚', readable: true, isCoin: false },
    { id: 'sing-manga', name: 'Sing-Manga', url: 'https://www.sing-manga.com', type: 'mangareader', icon: '🎤', readable: true, isCoin: false },
    { id: 'flash-manga', name: 'Flash-Manga', url: 'https://www.flash-manga.net', type: 'mangareader', icon: '⚡', readable: true, isCoin: false },
    { id: 'chibi-manga', name: 'Chibi-Manga', url: 'https://chibi-manga.com', type: 'mangareader', icon: '🧸', readable: true, isCoin: false },
    { id: 'nano-manga', name: 'Nano-Manga', url: 'https://nano-manga.com', type: 'madara', icon: '🧬', readable: true, isCoin: false },
    { id: 'ecchi-doujin', name: 'Ecchi-Doujin', url: 'https://ecchi-doujin.com', type: 'mangareader', icon: '🔞', readable: true, isCoin: false }
  ],

  DEFAULT_SOURCE_ID: 'all'
};
