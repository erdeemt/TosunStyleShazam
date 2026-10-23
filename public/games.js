// Oyun kayıt listesi. Sol menü ve ana sayfa buradan oluşur.
// Yeni oyun eklemek: bu listeye bir kayıt + oyunun kendi modülü (enter/leave fonksiyonları).
// Bir oyun birden fazla kategoride olabilir; enter(categoryId) ile hangisinden açıldığını öğrenir.

export const CATEGORIES = [
  { id: 'single', name: 'Tek Oyunculu', icon: '👤' },
  { id: 'multi', name: 'Çok Oyunculu', icon: '👥' },
];

export const GAMES = [
  {
    id: 'shazam',
    name: 'Tosun Shazam',
    icon: '🎵',
    desc: 'Şarkıyı 0.5 saniyeden tanı',
    categories: ['single', 'multi'],
    load: () => import('./shazam.js'),
  },
  {
    id: 'wordle',
    name: 'Wordle TR',
    icon: '🟩',
    desc: '5 harfli kelimeyi 6 denemede bul',
    categories: ['single'],
    load: () => import('./games/wordle.js'),
  },
  {
    id: 'spyfall',
    name: 'Casus Kim?',
    icon: '🕵️',
    desc: 'Aranızdaki casusu bulun',
    categories: ['multi'],
    load: () => import('./games/spyfall.js'),
  },
  {
    id: 'vampir',
    name: 'Vampir Köylü',
    icon: '🧛',
    desc: 'Gece vampirler avlanır, gündüz köy asar',
    categories: ['multi'],
    load: () => import('./games/vampir.js'),
  },
];
