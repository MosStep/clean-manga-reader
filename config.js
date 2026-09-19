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

  // รายการเว็บต้นทางทั้งหมด (ภาษาไทย)
  // เว็บที่ readable: true สามารถอ่านภาพแนวตั้งได้สมบูรณ์แบบในเว็บนี้ 100%
  // เว็บที่ readable: false เป็นเว็บที่มีระบบเหรียญหรือเข้ารหัสของค่ายต้นทาง (มีปุ่มเปิดอ่านเว็บต้นทางให้)
  SOURCES: [
    { id: 'go-manga', name: 'Go-Manga', url: 'https://www.go-manga.com', type: 'mangareader', icon: '⚡', readable: true, isCoin: false, lang: 'th' },
    { id: 'slow-manga', name: 'Slow-Manga', url: 'https://www.slow-manga.net', type: 'mangareader', icon: '🐢', readable: true, isCoin: false, lang: 'th' },
    { id: 'ped-manga', name: 'Ped-Manga', url: 'https://ped-manga.com', type: 'mangareader', icon: '🦆', readable: true, isCoin: false, lang: 'th' },
    { id: 'manga-step', name: 'MangaStep', url: 'https://mangastep.com', type: 'mangareader', icon: '🐾', readable: true, isCoin: false, lang: 'th' },
    { id: 'ntr-manga', name: 'NTR-Manga', url: 'https://www.ntr-manga.net', type: 'mangareader', icon: '🔥', readable: true, isCoin: false, lang: 'th' },
    { id: 'dark-manga', name: 'Dark-Manga', url: 'https://www.dark-manga.com', type: 'mangareader', icon: '🌑', readable: true, isCoin: false, lang: 'th' },
    { id: 'fin-manga', name: 'Fin-Manga', url: 'https://www.fin-manga.com', type: 'mangareader', icon: '🌸', readable: true, isCoin: false, lang: 'th' },
    { id: 'up-manga', name: 'Up-Manga', url: 'https://www.up-manga.com', type: 'mangareader', icon: '🚀', readable: true, isCoin: false, lang: 'th' },
    { id: 'speed-manga', name: 'Speed-Manga', url: 'https://speed-manga.net', type: 'mangareader', icon: '⚡', readable: true, isCoin: false, lang: 'th' },
    { id: 'du-manga', name: 'Du-Manga', url: 'https://www.du-manga.com', type: 'madara', icon: '📖', readable: true, isCoin: false, lang: 'th' },
    { id: 'manga-lc', name: 'Manga-LC', url: 'https://manga-lc.net', type: 'madara', icon: '📚', readable: true, isCoin: false, lang: 'th' },
    { id: 'sing-manga', name: 'Sing-Manga', url: 'https://www.sing-manga.com', type: 'mangareader', icon: '🎤', readable: true, isCoin: false, lang: 'th' },
    { id: 'flash-manga', name: 'Flash-Manga', url: 'https://www.flash-manga.net', type: 'mangareader', icon: '⚡', readable: true, isCoin: false, lang: 'th' },
    { id: 'chibi-manga', name: 'Chibi-Manga', url: 'https://chibi-manga.com', type: 'mangareader', icon: '🧸', readable: true, isCoin: false, lang: 'th' },
    { id: 'nano-manga', name: 'Nano-Manga', url: 'https://nano-manga.com', type: 'madara', icon: '🧬', readable: true, isCoin: false, lang: 'th' },
    { id: 'ecchi-doujin', name: 'Ecchi-Doujin', url: 'https://ecchi-doujin.com', type: 'mangareader', icon: '🔞', readable: true, isCoin: false, lang: 'th' },
    { id: 'ntrnaja', name: 'NTRnaja', url: 'https://ntrnaja.com', type: 'ntrnaja', icon: '🔥', readable: false, isCoin: true, lang: 'th' },
    { id: 'bully-manga', name: 'Bully Manga', url: 'https://bully-manga.com', type: 'bullymanga', icon: '🐂', readable: true, isCoin: false, lang: 'th' },
    { id: 'asura-scans', name: 'Asura Scans', url: 'https://asurascans.com', type: 'asurascans', icon: '⚔️', readable: true, isCoin: false, lang: 'en' },
    { id: 'manga-town', name: 'MangaTown', url: 'https://www.mangatown.com', type: 'mangatown', icon: '🏙️', readable: true, isCoin: false, lang: 'en' },
    { id: 'pocket-shonen', name: 'マガポケ (Pocket Shonen)', url: 'https://pocket.shonenmagazine.com', type: 'pocketshonen', icon: '🇯🇵', readable: false, isCoin: true, lang: 'ja' }
  ],

  // แหล่งข้อมูลการ์ตูนภาษาอังกฤษระดับโลก (MangaDex)
  MANGADEX: {
    id: 'mangadex',
    name: 'MangaDex',
    url: 'https://mangadex.org',
    apiUrl: 'https://api.mangadex.org',
    coverUrl: 'https://uploads.mangadex.org/covers',
    type: 'mangadex',
    icon: '🌐',
    readable: true,
    isCoin: false,
    lang: 'en'
  },

  DEFAULT_SOURCE_ID: 'all'
};
