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
    id: 'spyfall',
    name: 'Casus Kim?',
    icon: '🕵️',
    desc: 'Aranızdaki casusu bulun',
    categories: ['multi'],
    load: () => import('./games/spyfall.js'),
  },
];
