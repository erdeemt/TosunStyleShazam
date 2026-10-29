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
    id: 'nuance',
    name: 'Nüans',
    icon: '🎨',
    desc: 'Rengi gör, aklında tut, yeniden oluştur',
    categories: ['single', 'multi'],
    load: () => import('./games/nuance.js'),
  },
  {
    id: 'tone',
    name: 'Ton Avı',
    icon: '🔊',
    desc: 'Tonu dinle, aynı perdeyi bul',
    categories: ['single', 'multi'],
    load: () => import('./games/tone.js'),
  },
  {
    id: 'perceptle',
    name: 'Algıla',
    icon: '👁️',
    desc: 'Beş kısa algı testi: say, kestir, ritim tut',
    categories: ['single', 'multi'],
    load: () => import('./games/perceptle.js'),
  },
  {
    id: 'haxball',
    name: 'Tosun Top',
    icon: '⚽',
    desc: 'HaxBall gibi gerçek zamanlı futbol',
    categories: ['multi'],
    load: () => import('./games/haxball.js'),
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
