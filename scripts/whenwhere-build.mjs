// 📸 Ne Zaman Nerede? — fotoğraf havuzu oluşturucu (çevrimdışı, elle çalıştırılır; sunucu bunu çalıştırmaz).
//
//   node scripts/whenwhere-build.mjs            → content/whenwhere/photos.json
//   node scripts/whenwhere-build.mjs --sample 40 → ayrıca rastgele 40 küçük resmi WW_SAMPLE_DIR'e indirir (göz kontrolü)
//
// Kaynaklar: Wikidata SPARQL (Commons kategorisi → yer öğesi, koordinat, Türkçe ad/açıklama, ülke, kıta) ve
// Wikimedia Commons API (kategori ağacı "X by year" / "X in 1925" / "History of X" / "X in the 1920s"; dosya tarihi,
// lisansı, yazarı, kendi koordinatı). Yıl: kategori adındaki kesin yıl (en güvenilir) ya da dosyanın "Date" alanı;
// ikisi çelişirse dosya atılır. Lisans: sadece kamu malı / CC0 / CC BY / CC BY-SA / "No restrictions".
// Ayrıntı ve süzgeçler: PLAN.md §4.10.
//
// Ağ nazik: tek istek, aralarda bekleme, 429'da geri çekilme, yanıtlar WW_CACHE klasöründe saklanır (tekrar çalıştırma ucuz).
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'content', 'whenwhere', 'photos.json');
const CACHE = process.env.WW_CACHE || join(tmpdir(), 'ww-build-cache');
const SAMPLE_DIR = process.env.WW_SAMPLE_DIR || join(tmpdir(), 'ww-sample');
const UA = 'TosunStyleGames/1.0 (https://github.com/erdeemt/TosunStyleShazam; offline photo pool builder) node';
const GAP_MS = Number(process.env.WW_GAP_MS) || 650;
mkdirSync(CACHE, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;

async function getJson(url, body = null) {
  const key = createHash('sha1').update(body ? `${url}\n${body}` : url).digest('hex');
  const file = join(CACHE, `${key}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  for (let attempt = 0; attempt < 8; attempt++) {
    const wait = last + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    let text = '';
    let status = 0;
    try {
      const res = await fetch(url, body
        ? { method: 'POST', body, headers: { 'User-Agent': UA, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' } }
        : { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (res.status === 414 || res.status === 404) throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: true });
      status = res.status;
      text = await res.text();
      const json = JSON.parse(text);
      if (json.error?.code === 'maxlag' || json.error?.code === 'ratelimited') throw new Error(json.error.code);
      writeFileSync(file, JSON.stringify(json));
      return json;
    } catch (err) {
      if (err.fatal) throw err;
      const backoff = Math.min(120_000, 5000 * 2 ** attempt);
      console.warn(`  ! ${status} ${String(err.message).slice(0, 60)} — ${backoff / 1000} sn bekle`);
      await sleep(backoff);
    }
  }
  throw new Error(`alınamadı: ${url}`);
}

const commons = (params, post = false) => {
  const qs = String(new URLSearchParams({ format: 'json', formatversion: '2', maxlag: '5', ...params }));
  return post ? getJson('https://commons.wikimedia.org/w/api.php', qs) : getJson(`https://commons.wikimedia.org/w/api.php?${qs}`);
};
const sparql = (q) => getJson(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(q)}`);

// ---------- Tohumlar ----------
// cat: Commons kategori adı (ana konu). t: temalar. n: en fazla kaç foto. lat/lon/tr: Wikidata'da yoksa elle.
// city: şehir kategorisi (yer = dosyanın kendi koordinatı, yoksa şehir merkezi → sadece dünya/ülke modunda, hassas değil).
const S = (cat, t = [], extra = {}) => ({ cat, t, ...extra });

const ISTANBUL = [
  S('Galata Tower', ['sehir'], { n: 4 }), S('Galata Bridge', ['ulasim'], { n: 5 }), S('Hagia Sophia', [], { n: 4 }),
  S('Sultan Ahmed Mosque', [], { n: 3 }), S('Topkapı Palace', [], { n: 3 }), S('Dolmabahçe Palace', [], { n: 3 }),
  S("Maiden's Tower", [], { n: 3 }), S('Rumelihisarı', [], { n: 3 }), S('Anadoluhisarı'), S('Haydarpaşa railway station', ['ulasim'], { n: 3 }),
  S('Sirkeci railway station', ['ulasim'], { n: 3 }), S('Taksim Square', ['sehir'], { n: 4 }), S('İstiklal Avenue', ['sehir'], { n: 4 }),
  S('Beyazıt Tower'), S('Beyazıt Square', ['sehir'], { n: 3 }), S('Süleymaniye Mosque', [], { n: 3 }), S('Yeni Cami', [], { n: 3 }),
  S('Grand Bazaar, Istanbul', ['sehir'], { n: 3 }), S('Spice Bazaar', ['sehir']), S('Ortaköy Mosque', [], { n: 3 }),
  S('Bosphorus Bridge', ['ulasim'], { n: 3 }), S('Çırağan Palace'), S('Beylerbeyi Palace'), S('Valens Aqueduct', [], { n: 3 }),
  S('Hippodrome of Constantinople', ['sehir'], { n: 3 }), S('Obelisk of Theodosius'), S('Eminönü', ['sehir'], { n: 4 }),
  S('Karaköy', ['sehir'], { n: 4 }), S('Kadıköy', ['sehir'], { n: 3 }), S('Üsküdar', ['sehir'], { n: 3 }), S('Pera Palace Hotel'),
  S('Tünel', ['ulasim'], { n: 3 }), S('Galatasaray High School'), S('Hagia Irene'), S('Little Hagia Sophia'), S('Rüstem Pasha Mosque'),
  S('Fatih Mosque'), S('Eyüp Sultan Mosque'), S('Atatürk Cultural Center', [], { n: 2 }), S('Republic Monument (Istanbul)', ['sehir']),
  S('Haydarpaşa', ['ulasim']), S('Istanbul Atatürk Airport', ['ulasim']), S('BJK İnönü Stadium', ['spor'], { n: 3 }),
  S('Şükrü Saracoğlu Stadium', ['spor']), S('Taksim Stadium', ['spor'], { n: 2 }), S('Istanbul University', [], { n: 3 }), S('Bebek', ['sehir']),
  S('Büyükada', ['sehir'], { n: 3 }), S('Heybeliada'), S('Moda, Kadıköy', ['sehir']), S('Beşiktaş', ['sehir'], { n: 3 }),
  S('Kuleli Military High School'), S('Selimiye Barracks', ['savas']), S('Basilica Cistern'), S('Istanbul Archaeology Museums'),
  S('Pera', ['sehir'], { n: 3 }), S('Galata', ['sehir'], { n: 3 }), S('Sultanahmet', ['sehir'], { n: 3 }), S('Atatürk Bridge (Istanbul)', ['ulasim']),
  S('Trams in Istanbul', ['ulasim'], { n: 4, lat: 41.0336, lon: 28.9770, tr: 'İstanbul tramvayı' }),
  S('Ferries in Istanbul', ['ulasim'], { n: 3, lat: 41.0171, lon: 28.9744, tr: 'İstanbul vapurları' }),
  S('Golden Horn', ['sehir'], { n: 3 }), S('Bosphorus', ['sehir'], { n: 3 }), S('Nuruosmaniye Mosque'), S('Laleli Mosque'),
  S('Mihrimah Sultan Mosque (Edirnekapı)'), S('Walls of Constantinople', [], { n: 3 }), S('Yedikule Fortress'), S('Kumkapı', ['sehir']),
  S('Cağaloğlu', ['sehir']), S('Sirkeci', ['sehir'], { n: 3 }), S('Tophane', ['sehir']), S('Fountain of Ahmed III'), S('Fenerbahçe', ['sehir']),
  S('Haydarpaşa High School'), S('Ortaköy', ['sehir'], { n: 3 }), S('Arnavutköy', ['sehir']), S('Istanbul', ['sehir'], { n: 10, city: true }),
];

const TURKIYE = [
  S('Ankara', ['sehir'], { n: 6, city: true }), S('Anıtkabir', [], { n: 3 }), S('Ulus, Ankara', ['sehir'], { n: 3 }), S('Ankara railway station', ['ulasim'], { n: 2 }),
  S('Grand National Assembly of Turkey', [], { n: 2 }), S('Ankara Castle'), S('Victory Monument (Ankara)'), S('Ankara 19 Mayıs Stadium', ['spor']),
  S('İzmir', ['sehir'], { n: 6, city: true }), S('Konak Square', ['sehir'], { n: 3 }), S('İzmir Clock Tower', [], { n: 3 }), S('Kordon, İzmir', ['sehir']),
  S('Bursa', ['sehir'], { n: 3, city: true }), S('Green Mosque, Bursa'), S('Trabzon', ['sehir'], { n: 3, city: true }), S('Sümela Monastery', [], { n: 2 }),
  S('Ephesus', [], { n: 3 }), S('Pamukkale'), S('Mount Nemrut', [], { n: 2 }), S('Göreme'), S('Selimiye Mosque, Edirne', [], { n: 2 }),
  S('Edirne', ['sehir'], { n: 2, city: true }), S('Kaleiçi', ['sehir']), S('Hıdırlık Tower'), S('Mevlana Museum', [], { n: 2 }), S('Konya', ['sehir'], { n: 2, city: true }),
  S('Diyarbakır', ['sehir'], { n: 2, city: true }), S('Mardin', ['sehir'], { n: 2, city: true }), S('Gallipoli Campaign', ['savas'], { n: 4, lat: 40.2306, lon: 26.2789, tr: 'Çanakkale Savaşı (Gelibolu)', years: [1915, 1916] }),
  S('Çanakkale', ['sehir'], { n: 2, city: true }), S('Troy', [], { n: 2 }), S('Erzurum', ['sehir'], { n: 2, city: true }), S('Kars', ['sehir'], { n: 2, city: true }),
  S('Ani', [], { n: 2 }), S('Samsun', ['sehir'], { n: 2, city: true }), S('Taşköprü (Adana)', ['ulasim']), S('Adana', ['sehir'], { n: 2, city: true }),
  S('Aspendos', [], { n: 2 }), S('Safranbolu', ['sehir']), S('Amasya', ['sehir'], { n: 2, city: true }), S('İznik', ['sehir']),
  S('Antalya', ['sehir'], { n: 2, city: true }), S('Gaziantep', ['sehir'], { n: 2, city: true }), S('Sivas', ['sehir'], { n: 2, city: true }),
  S('Eskişehir', ['sehir'], { n: 2, city: true }), S('Kayseri', ['sehir'], { n: 2, city: true }), S('Hasankeyf'), S('Ishak Pasha Palace'),
  S('Akdamar Island'), S('Bodrum Castle'), S('Hagia Sophia, Trabzon'), S('Zonguldak', ['sehir'], { n: 2, city: true }), S('Şanlıurfa', ['sehir'], { n: 2, city: true }),
  S('Van, Turkey', ['sehir'], { n: 2, city: true }), S('Manisa', ['sehir'], { n: 1, city: true }), S('Sinop, Turkey', ['sehir'], { n: 1, city: true }),
];

const WORLD = [
  // Avrupa
  S('Eiffel Tower', ['icat'], { n: 4 }), S('Arc de Triomphe', [], { n: 2 }), S('Notre-Dame de Paris', [], { n: 2 }), S('Avenue des Champs-Élysées', ['sehir'], { n: 2 }),
  S('Sacré-Cœur Basilica', [], { n: 2 }), S('Place de la Concorde', ['sehir'], { n: 2 }), S('Gare Saint-Lazare', ['ulasim']), S('Gare du Nord', ['ulasim']),
  S('Exposition Universelle (1889)', ['icat'], { n: 2, lat: 48.8556, lon: 2.2986, tr: '1889 Paris Dünya Fuarı', years: [1887, 1890] }),
  S('Exposition Universelle (1900)', ['icat'], { n: 2, lat: 48.8606, lon: 2.3126, tr: '1900 Paris Dünya Fuarı', years: [1898, 1901] }),
  S('Big Ben', [], { n: 2 }), S('Tower Bridge', ['ulasim'], { n: 3 }), S('Trafalgar Square', ['sehir'], { n: 2 }), S('Piccadilly Circus', ['sehir'], { n: 3 }),
  S("St Paul's Cathedral", [], { n: 2 }), S('Buckingham Palace', [], { n: 2 }), S('London Bridge', ['ulasim']), S('St Pancras railway station', ['ulasim']),
  S('Wembley Stadium (1923)', ['spor'], { n: 2 }), S('The Crystal Palace', ['icat'], { n: 2, years: [1851, 1936] }), S('Forth Bridge', ['ulasim'], { n: 2 }), S('Edinburgh Castle'),
  S('Brandenburg Gate', [], { n: 3 }), S('Berlin Wall', ['savas'], { n: 4 }), S('Checkpoint Charlie', ['savas'], { n: 2 }), S('Reichstag building', [], { n: 2 }),
  S('Potsdamer Platz', ['sehir'], { n: 2 }), S('Olympiastadion (Berlin)', ['spor'], { n: 2 }), S('Tempelhof Airport', ['ulasim'], { n: 2 }), S('Berlin Blockade', ['savas'], { n: 2, lat: 52.4731, lon: 13.4039, tr: 'Berlin Hava Köprüsü', years: [1948, 1949] }),
  S('Cologne Cathedral', [], { n: 2 }), S('Neuschwanstein Castle'), S('Hamburg Hauptbahnhof', ['ulasim']), S('Frauenkirche, Dresden', ['savas'], { n: 2 }),
  S('Colosseum', [], { n: 3 }), S("St. Peter's Square", ['sehir'], { n: 2 }), S('Trevi Fountain', [], { n: 2 }), S('Leaning Tower of Pisa', [], { n: 2 }),
  S('Piazza San Marco', ['sehir'], { n: 3 }), S('Rialto Bridge', ['ulasim'], { n: 2 }), S('Milan Cathedral', [], { n: 2 }), S('Galleria Vittorio Emanuele II', ['sehir']),
  S('Acropolis of Athens', [], { n: 2 }), S('Parthenon', [], { n: 2 }), S('Syntagma Square', ['sehir'], { n: 2 }), S('Panathenaic Stadium', ['spor'], { n: 2 }),
  S('Thessaloniki', ['sehir'], { n: 2, city: true }), S('White Tower of Thessaloniki', [], { n: 2 }),
  S('Sagrada Família', ['icat'], { n: 2 }), S('Puerta del Sol', ['sehir'], { n: 2 }), S('Plaza Mayor (Madrid)', ['sehir']), S('Alhambra'), S('Gran Vía (Madrid)', ['sehir']),
  S('Belém Tower'), S('Praça do Comércio', ['sehir']), S('Elevador de Santa Justa', ['ulasim']), S('Atomium', ['icat'], { n: 2 }), S('Grand-Place', ['sehir'], { n: 2 }),
  S('Dam Square', ['sehir'], { n: 2 }), S('Amsterdam Centraal station', ['ulasim']), S('Red Square', ['sehir'], { n: 3 }), S("Saint Basil's Cathedral", [], { n: 2 }),
  S('Winter Palace', [], { n: 2 }), S('Nevsky Prospekt', ['sehir'], { n: 2 }), S('Charles Bridge', ['ulasim'], { n: 2 }), S('Old Town Square (Prague)', ['sehir'], { n: 2 }),
  S('Wenceslas Square', ['sehir'], { n: 2 }), S('Hungarian Parliament Building', [], { n: 2 }), S('Széchenyi Chain Bridge', ['ulasim'], { n: 2 }),
  S('Schönbrunn Palace'), S("St. Stephen's Cathedral, Vienna", [], { n: 2 }), S('Vienna State Opera'), S('Old Town Market Place in Warsaw', ['sehir', 'savas'], { n: 2 }),
  S('Wawel Castle'), S('Stockholm City Hall'), S('Stockholm Olympic Stadium', ['spor']), S('Nyhavn', ['sehir']), S('Kapellbrücke', ['ulasim']),
  S('Mostar Bridge', ['ulasim'], { n: 2 }), S('Latin Bridge', ['savas']), S('Sofia', ['sehir'], { n: 2, city: true }), S('Bucharest', ['sehir'], { n: 2, city: true }),
  S('Belgrade', ['sehir'], { n: 2, city: true }), S('Helsinki Central railway station', ['ulasim']), S('Helsinki Olympic Stadium', ['spor']),
  S('Dublin', ['sehir'], { n: 2, city: true }), S("O'Connell Street", ['sehir']), S('Zeppelin', ['icat'], { n: 2, lat: 47.6519, lon: 9.4792, tr: 'Zeplin (Friedrichshafen)' }),
  // Kuzey Amerika
  S('Statue of Liberty', ['icat'], { n: 3 }), S('Empire State Building', ['icat'], { n: 3 }), S('Brooklyn Bridge', ['ulasim'], { n: 3 }), S('Times Square', ['sehir'], { n: 3 }),
  S('Grand Central Terminal', ['ulasim'], { n: 2 }), S('Flatiron Building', [], { n: 2 }), S('Chrysler Building', [], { n: 2 }), S('Ellis Island', ['ulasim'], { n: 2 }),
  S('1939 New York World\'s Fair', ['icat'], { n: 2, lat: 40.7464, lon: -73.8448, tr: '1939 New York Dünya Fuarı', years: [1937, 1940] }), S('Yankee Stadium (1923)', ['spor'], { n: 2 }),
  S('Golden Gate Bridge', ['ulasim'], { n: 3 }), S('Hollywood Sign', [], { n: 2 }), S('Lincoln Memorial', [], { n: 2 }), S('United States Capitol', [], { n: 2 }),
  S('White House', [], { n: 2 }), S('Washington Monument', [], { n: 2 }), S('Mount Rushmore', ['icat'], { n: 2 }), S('Niagara Falls', [], { n: 2 }),
  S('Space Needle', ['icat'], { n: 2 }), S('Wrigley Field', ['spor'], { n: 2 }), S('Fenway Park', ['spor']), S('Alamo Mission in San Antonio'), S('Gateway Arch', ['icat'], { n: 2 }),
  S('Hoover Dam', ['icat'], { n: 3 }), S('Panama Canal', ['ulasim', 'icat'], { n: 3 }), S('CN Tower'), S('Château Frontenac'), S('Kitty Hawk, North Carolina', ['icat'], { n: 2 }),
  S('Kennedy Space Center Launch Complex 39', ['icat'], { n: 2 }), S('Cape Canaveral Air Force Station', ['icat'], { n: 2 }), S('Pearl Harbor', ['savas'], { n: 2 }),
  S('Zócalo', ['sehir'], { n: 2 }), S('Palacio de Bellas Artes'), S('Golden Gate International Exposition', ['icat'], { years: [1938, 1940] }), S('World\'s Columbian Exposition', ['icat'], { n: 2, lat: 41.7906, lon: -87.5830, tr: '1893 Chicago Dünya Fuarı', years: [1891, 1894] }),
  S('Chicago Water Tower'), S('Las Vegas Strip', ['sehir'], { n: 2 }), S('Route 66', ['ulasim'], { n: 1, lat: 35.0272, lon: -111.0222, tr: 'Route 66 (Arizona)' }),
  S('Havana', ['sehir'], { n: 2, city: true }), S('El Capitolio', [], { n: 2 }), S('Montreal Olympic Stadium', ['spor']), S('Expo 67', ['icat'], { n: 2, lat: 45.5126, lon: -73.5319, tr: 'Expo 67 (Montreal)', years: [1965, 1968] }),
  // Güney Amerika
  S('Christ the Redeemer (statue)', ['icat'], { n: 2 }), S('Sugarloaf Mountain', [], { n: 2 }), S('Copacabana, Rio de Janeiro', ['sehir'], { n: 2 }), S('Maracanã Stadium', ['spor'], { n: 2 }),
  S('Obelisco de Buenos Aires', [], { n: 2 }), S('Casa Rosada'), S('Avenida de Mayo', ['sehir']), S('Machu Picchu', [], { n: 2 }), S('Estadio Centenario', ['spor']),
  S('Plaza de Armas of Lima', ['sehir']), S('Valparaíso', ['sehir'], { n: 2, city: true }), S('Bogotá', ['sehir'], { n: 1, city: true }), S('Brasília', ['sehir', 'icat'], { n: 2, city: true }),
  // Afrika
  S('Great Pyramid of Giza', [], { n: 2 }), S('Great Sphinx of Giza', [], { n: 2 }), S('Suez Canal', ['ulasim'], { n: 3, lat: 30.5852, lon: 32.2654, tr: 'Süveyş Kanalı' }), S('Cairo Citadel', [], { n: 2 }),
  S('Jemaa el-Fnaa', ['sehir']), S('Table Mountain', [], { n: 2 }), S('Victoria Falls', [], { n: 2 }), S('Victoria Falls Bridge', ['ulasim'], { n: 2 }),
  S('Alexandria', ['sehir'], { n: 2, city: true }), S('Tunis', ['sehir'], { n: 2, city: true }), S('Dakar', ['sehir'], { n: 1, city: true }), S('Nairobi', ['sehir'], { n: 2, city: true }),
  S('Abu Simbel temples', ['icat'], { n: 2 }), S('Aswan Dam', ['icat'], { n: 1 }), S('Cape Town', ['sehir'], { n: 2, city: true }), S('Zanzibar City', ['sehir'], { n: 1, city: true }),
  // Asya ve Okyanusya
  S('Taj Mahal', [], { n: 2 }), S('Gateway of India', [], { n: 2 }), S('Chhatrapati Shivaji Terminus', ['ulasim'], { n: 2 }), S('Golden Temple', [], { n: 2 }), S('Howrah Bridge', ['ulasim']),
  S('Forbidden City', [], { n: 2 }), S('Tiananmen Square', ['sehir'], { n: 2 }), S('The Bund', ['sehir'], { n: 3 }), S('Great Wall of China', [], { n: 2 }),
  S('Mount Fuji', [], { n: 2 }), S('Tokyo Station', ['ulasim'], { n: 2 }), S('Kinkaku-ji', [], { n: 2 }), S('Hiroshima Peace Memorial', ['savas'], { n: 2 }), S('Ginza', ['sehir'], { n: 2 }),
  S('Victoria Harbour', ['sehir'], { n: 2 }), S('Angkor Wat', [], { n: 2 }), S('Shwedagon Pagoda', [], { n: 2 }), S('Petronas Towers', ['icat']), S('Raffles Hotel'),
  S('Sydney Harbour Bridge', ['ulasim', 'icat'], { n: 3 }), S('Sydney Opera House', ['icat'], { n: 2 }), S('Flinders Street railway station', ['ulasim'], { n: 2 }),
  S('Melbourne Cricket Ground', ['spor'], { n: 2 }), S('Western Wall', [], { n: 2 }), S('Dome of the Rock', [], { n: 2 }), S('Jaffa Gate', ['sehir'], { n: 2 }), S('Al-Khazneh', [], { n: 2 }),
  S('Baalbek', [], { n: 2 }), S('Persepolis', [], { n: 2 }), S('Azadi Tower'), S('Naqsh-e Jahan Square', ['sehir'], { n: 2 }), S('Burj Khalifa', ['icat']),
  S('Hejaz Railway', ['ulasim'], { n: 2, lat: 31.9632, lon: 35.9304, tr: 'Hicaz Demiryolu (Amman)' }), S('Damascus', ['sehir'], { n: 2, city: true }), S('Baghdad', ['sehir'], { n: 2, city: true }),
  S('Beirut', ['sehir'], { n: 2, city: true }), S('Tbilisi', ['sehir'], { n: 2, city: true }), S('Baku', ['sehir'], { n: 2, city: true }), S('Samarkand', ['sehir'], { n: 2, city: true }),
  S('Registan', [], { n: 2 }), S('Kabul', ['sehir'], { n: 1, city: true }), S('Singapore River', ['sehir'], { n: 2 }), S('Bangkok', ['sehir'], { n: 2, city: true }),
  S('Seoul', ['sehir'], { n: 2, city: true }), S('Manila', ['sehir'], { n: 1, city: true }), S('Wellington', ['sehir'], { n: 1, city: true }), S('Auckland', ['sehir'], { n: 1, city: true }),
  S('Jakarta', ['sehir'], { n: 1, city: true }), S('Borobudur', [], { n: 2 }),
];

// ---------- Süzgeçler ----------

const LICENSE_OK = /^(public domain|pd\b|pd-|cc0|cc[- ]zero|cc by(-sa)? [0-9.]+|cc by(-sa)?$|cc-by(-sa)?-[0-9.]+|no restrictions)/i;
// Harita, belge, çizim, resim, portre, ceset/idam vb. (başlık + kategoriler + açıklama üzerinde)
const BAD = new RegExp([
  'map', 'karte', 'harita', '\\bplans?\\b', 'diagram', 'drawing', 'painting', 'engraving', 'lithograph', 'illustration', 'watercolou?r', 'sketch',
  'gravure', 'etching', 'woodcut', 'artwork', 'postage', 'stamp', 'coin', 'banknote', 'logo', 'poster', 'document', 'letter', 'manuscript',
  'newspaper', 'book', 'cover', 'page', 'portrait', 'corpse', 'dead', 'death', 'execut', 'hanged', 'hanging', 'massacre', 'killed', 'victim',
  'wounded', 'casualt', 'atrocit', 'genocide', 'funeral', 'burial', 'cemetery', 'grave', 'model', 'medal', 'seal\\b', 'signature', 'ticket',
  'holy land photographed', 'ETH-BIB-.*Dia', 'prisoner', 'blindfold', '\\bspy\\b', 'barren tree', 'expedition \\(', 'travel center', 'squad', '\\bteam\\b', 'group photo', 'group portrait', 'delegation', 'gazete', 'cumhuriyet \\d', 'piano', 'interior of a', 'award',
  'advert', 'menu', 'text', 'inscription', 'tughra', 'calligraph', 'blueprint', 'elevation', 'section', 'facsimile', 'nude', 'naked', 'x-ray',
  'microscop', 'specimen', 'scan of', 'leaflet', 'brochure', 'stereo', 'mugshot', 'icon', 'mosaic', 'fresco', 'relief', 'sculpture\\b',
].join('|'), 'i');
const PHOTO_HINT = /photo|photograph|fotoğraf|photochrom|postcard|negative|glass plate|lantern slide|albumen|gelatin|snapshot|aerial/i;
const HIST_CAT = /(by year|by decade|in the 1[89]\d0s|in the 20[01]0s|\bin (18[5-9]\d|19\d\d|200\d|201[0-5])\b|history of|historical|old photographs|photochrom|19th[- ]century|20th[- ]century|construction of|under construction|black and white photographs)/i;
const YEAR_RE = /\b(18[4-9]\d|19\d\d|20[01]\d)\b/g;

const stripHtml = (s) => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, ' ').trim();

// Kategori adından yıl ipucu: kesin yıl ("in 1925") ya da on yıl ("in the 1920s").
function catHint(name) {
  const exact = name.match(/\bin (18[4-9]\d|19\d\d|20[01]\d)\b/);
  if (exact) return { exact: Number(exact[1]) };
  const dec = name.match(/\bin the (18[4-9]0|19\d0|20[01]0)s\b/);
  if (dec) return { from: Number(dec[1]), to: Number(dec[1]) + 9 };
  return null;
}

// Dosyanın "Date" alanından yıl: tek yıl ya da ≤ 6 yıllık aralığın ortası. Belirsizse null.
export function dateYear(raw) {
  const s = stripHtml(raw).replace(/date QS:.*$/i, '');
  const ys = [...new Set((s.match(YEAR_RE) ?? []).map(Number))];
  if (!ys.length) return null;
  if (ys.length === 1) return ys[0];
  const lo = Math.min(...ys), hi = Math.max(...ys);
  return hi - lo <= 6 ? Math.round((lo + hi) / 2) : null;
}

function resolveYear(file, hint) {
  const d = dateYear(file.date);
  if (hint?.exact) {
    if (d != null && Math.abs(d - hint.exact) > 2) return null; // çelişki
    return hint.exact;
  }
  if (d == null) return null;
  if (hint?.from && (d < hint.from - 1 || d > hint.to + 1)) return null;
  // Taranmış eski fotoğrafta "Date" bazen tarama tarihidir: 1995 sonrası sadece EXIF saatli tarih (dijital çekim) kabul.
  if (d >= 1995 && !/\d{4}-\d\d-\d\d[ T]\d\d:\d\d/.test(stripHtml(file.date))) return null;
  return d;
}

// ---------- Commons gezinme ----------

async function catMembers(cat) {
  const out = { files: [], subs: [] };
  let cont = {};
  for (let page = 0; page < 4; page++) {
    const j = await commons({ action: 'query', list: 'categorymembers', cmtitle: `Category:${cat}`, cmlimit: '500', cmtype: 'file|subcat', ...cont });
    for (const m of j.query?.categorymembers ?? []) (m.ns === 6 ? out.files : out.subs).push(m.title);
    if (!j.continue) break;
    cont = { cmcontinue: j.continue.cmcontinue };
  }
  return out;
}

// Konu kategorisinden tarihli alt kategorilere in (en fazla maxCats kategori). → [{ title, hint }]
async function gatherFiles(seed, maxCats = Number(process.env.WW_MAX_CATS) || 30) {
  const seen = new Set();
  const files = new Map();
  const queue = [{ cat: seed.cat, hint: null, depth: 0 }];
  while (queue.length && seen.size < maxCats) {
    const { cat, hint, depth } = queue.shift();
    if (seen.has(cat)) continue;
    seen.add(cat);
    let m;
    try { m = await catMembers(cat); } catch (err) { console.warn(`  ! ${cat}: ${err.message}`); continue; }
    const h = catHint(cat) ?? hint;
    // Ana kategorinin doğrudan dosyaları çoğunlukla yeni fotoğraf: sadece tarihli/tarihçe kategorilerinden al
    // (şehir tohumlarında hiç alma).
    if (depth > 0 || !seed.city) for (const f of m.files.slice(0, 400)) if (!files.has(f)) files.set(f, h);
    for (const sub of m.subs) {
      const name = sub.replace(/^Category:/, '');
      if (!HIST_CAT.test(name)) continue;
      const yh = catHint(name);
      if (yh?.exact && (yh.exact < 1850 || yh.exact > 2015)) continue;
      if (yh?.from && (yh.to < 1850 || yh.from > 2015)) continue;
      // "<Şehir> in 1925" gibi büyük şehir kategorilerinin alt kategorileri (başka konular) gezilmez: depth sınırı
      if (depth < 3) queue.push({ cat: name, hint: yh ?? h, depth: depth + 1 });
    }
  }
  return [...files].map(([title, hint]) => ({ title, hint }));
}

const batchInfo = (batch) => commons({
  action: 'query', titles: batch.join('|'), prop: 'imageinfo|coordinates|categories',
  iiprop: 'url|size|mime|extmetadata', iiurlwidth: '1280', iiextmetadatafilter: 'DateTimeOriginal|LicenseShortName|LicenseUrl|Artist|ImageDescription|Categories|Credit',
  clshow: '!hidden', cllimit: 'max', colimit: 'max',
}, true);

async function fileInfos(titles) {
  const out = new Map();
  // Toplu sorgular (50 dosya) 3'er 3'er paralel; istek başlangıçları yine GAP_MS aralıklı.
  const starts = [];
  for (let i = 0; i < titles.length; i += 50) starts.push(i);
  const pages = [];
  const worker = async () => {
    for (let i = starts.shift(); i !== undefined; i = starts.shift()) pages.push(await batchInfo(titles.slice(i, i + 50)));
  };
  await Promise.all([worker(), worker(), worker()]);
  for (const j of pages) {
    for (const p of j.query?.pages ?? []) {
      const ii = p.imageinfo?.[0];
      if (!ii) continue;
      const em = ii.extmetadata ?? {};
      out.set(p.title, {
        title: p.title,
        mime: ii.mime, width: ii.width, height: ii.height, thumb: ii.thumburl, page: ii.descriptionurl,
        date: em.DateTimeOriginal?.value ?? '', license: stripHtml(em.LicenseShortName?.value), licenseUrl: stripHtml(em.LicenseUrl?.value),
        artist: stripHtml(em.Artist?.value).replace(/^(.+?) \1$/, '$1').slice(0, 120), desc: stripHtml(em.ImageDescription?.value).slice(0, 400),
        cats: `${stripHtml(em.Categories?.value)} ${(p.categories ?? []).map((c) => c.title).join(' ')}`,
        coord: p.coordinates?.[0] ? { lat: p.coordinates[0].lat, lon: p.coordinates[0].lon } : null,
      });
    }
  }
  return out;
}

// ---------- Wikidata: Commons kategorisi → yer ----------

const REGION_OF_CONTINENT = { Q46: 'avrupa', Q48: 'asya', Q15: 'afrika', Q49: 'kuzey-amerika', Q18: 'guney-amerika', Q538: 'okyanusya', Q55643: 'okyanusya' };

async function placesFor(cats) {
  const out = new Map();
  for (let i = 0; i < cats.length; i += 60) {
    const values = cats.slice(i, i + 60).map((c) => JSON.stringify(c)).join(' ');
    const q = `SELECT ?cat ?item ?coord ?lcoord ?trLabel ?enLabel ?trDesc ?country ?countryTr ?cityTr ?continent ?trwiki ?enwiki WHERE {
      VALUES ?cat { ${values} }
      ?item wdt:P373 ?cat .
      OPTIONAL { ?item wdt:P625 ?coord }
      OPTIONAL { ?item wdt:P276/wdt:P625 ?lcoord }
      OPTIONAL { ?item rdfs:label ?trLabel FILTER(LANG(?trLabel) = "tr") }
      OPTIONAL { ?item rdfs:label ?enLabel FILTER(LANG(?enLabel) = "en") }
      OPTIONAL { ?item schema:description ?trDesc FILTER(LANG(?trDesc) = "tr") }
      OPTIONAL { ?item wdt:P17 ?country . ?country rdfs:label ?countryTr FILTER(LANG(?countryTr) = "tr") . OPTIONAL { ?country wdt:P30 ?continent } }
      OPTIONAL { ?item wdt:P131 ?city . ?city rdfs:label ?cityTr FILTER(LANG(?cityTr) = "tr") }
      OPTIONAL { ?trwiki schema:about ?item ; schema:isPartOf <https://tr.wikipedia.org/> }
      OPTIONAL { ?enwiki schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> }
    }`;
    const j = await sparql(q);
    for (const b of j.results?.bindings ?? []) {
      const cat = b.cat.value;
      if (out.has(cat) && out.get(cat).coord) continue;
      const pt = (b.coord ?? b.lcoord)?.value.match(/Point\(([-\d.]+) ([-\d.]+)\)/);
      out.set(cat, {
        qid: b.item.value.split('/').pop(),
        coord: pt ? { lat: Number(pt[2]), lon: Number(pt[1]) } : null,
        tr: b.trLabel?.value ?? null, en: b.enLabel?.value ?? null, desc: b.trDesc?.value ?? null,
        country: b.country?.value.split('/').pop() ?? null, countryTr: b.countryTr?.value ?? null, cityTr: b.cityTr?.value ?? null,
        continent: b.continent?.value.split('/').pop() ?? null,
        wiki: b.trwiki?.value ?? b.enwiki?.value ?? null,
      });
    }
  }
  return out;
}

const wd = (ids) => getJson(`https://www.wikidata.org/w/api.php?${new URLSearchParams({ action: 'wbgetentities', format: 'json', ids: ids.join('|'), props: 'claims|labels|descriptions|sitelinks', languages: 'tr|en', sitefilter: 'trwiki|enwiki' })}`);
const claimVal = (e, p) => e?.claims?.[p]?.[0]?.mainsnak?.datavalue?.value;

async function placeFallback(cat) {
  const pp = await commons({ action: 'query', titles: `Category:${cat}`, prop: 'pageprops', ppprop: 'wikibase_item' });
  let qid = pp.query?.pages?.[0]?.pageprops?.wikibase_item;
  if (!qid) return null;
  let e = (await wd([qid])).entities?.[qid];
  const main = claimVal(e, 'P301')?.id;
  if (main) { qid = main; e = (await wd([qid])).entities?.[qid]; }
  let c = claimVal(e, 'P625');
  if (!c) {
    const loc = claimVal(e, 'P276')?.id;
    if (loc) c = claimVal((await wd([loc])).entities?.[loc], 'P625');
  }
  if (!c) return null;
  const country = claimVal(e, 'P17')?.id ?? null;
  const ce = country ? (await wd([country])).entities?.[country] : null;
  const city = claimVal(e, 'P131')?.id ?? null;
  const cie = city ? (await wd([city])).entities?.[city] : null;
  const site = e.sitelinks?.trwiki ? `https://tr.wikipedia.org/wiki/${encodeURIComponent(e.sitelinks.trwiki.title.replace(/ /g, '_'))}`
    : e.sitelinks?.enwiki ? `https://en.wikipedia.org/wiki/${encodeURIComponent(e.sitelinks.enwiki.title.replace(/ /g, '_'))}` : null;
  return {
    qid, coord: { lat: c.latitude, lon: c.longitude },
    tr: e.labels?.tr?.value ?? null, en: e.labels?.en?.value ?? null, desc: e.descriptions?.tr?.value ?? null,
    country, countryTr: ce?.labels?.tr?.value ?? null, cityTr: cie?.labels?.tr?.value ?? null,
    continent: claimVal(ce, 'P30')?.id ?? null, wiki: site,
  };
}

// Küçük resim adresi: API bazen thumb.wikimedia.org + izleme parametresi verir; sunucu sadece upload.wikimedia.org'a gider.
function thumbUrl(raw) {
  const u = new URL(raw);
  if (u.hostname === 'thumb.wikimedia.org') u.hostname = 'upload.wikimedia.org';
  u.search = '';
  u.hash = '';
  return u.href;
}

// ---------- Yardımcılar ----------

const R = 6371;
const rad = (d) => (d * Math.PI) / 180;
function km(a, b) {
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
const inIstanbul = (c) => c.lat > 40.8 && c.lat < 41.35 && c.lon > 28.4 && c.lon < 29.5;
const inTurkiye = (c) => c.lat > 35.8 && c.lat < 42.2 && c.lon > 25.6 && c.lon < 44.9; // kaba kutu; ülke kodu esas
const eraOf = (y) => (y < 1900 ? '1850-1900' : y < 1945 ? '1900-1945' : y < 1980 ? '1945-1980' : '1980-2015');

function regionOf(place, coord) {
  if (place?.country === 'Q43' || (!place?.country && inTurkiye(coord))) return 'turkiye';
  if (place?.continent && REGION_OF_CONTINENT[place.continent]) return REGION_OF_CONTINENT[place.continent];
  const { lat, lon } = coord;
  if (lon < -30) return lat > 12 ? 'kuzey-amerika' : 'guney-amerika';
  if (lat < -10 && lon > 110) return 'okyanusya';
  if (lat > 35 && lon < 40) return 'avrupa';
  if (lat < 35 && lon < 52 && lat > -35 && lon > -20 && !(lon > 34 && lat > 12)) return 'afrika';
  return 'asya';
}

const TR_COUNTRY_FIX = { 'Amerika Birleşik Devletleri': 'ABD', 'Birleşik Krallık': 'Birleşik Krallık' };

function captionOf(place, seed, year, coord) {
  const name = seed.tr ?? place?.tr ?? place?.en ?? seed.cat;
  const where = [place?.cityTr && place.cityTr !== name ? place.cityTr : null, TR_COUNTRY_FIX[place?.countryTr] ?? place?.countryTr].filter(Boolean);
  const loc = inIstanbul(coord) && !where.includes('İstanbul') ? ['İstanbul', ...where.filter((w) => w !== 'Türkiye')] : where;
  const desc = place?.desc && !seed.city ? ` — ${place.desc.replace(/\.$/, '')}` : '';
  const title = seed.city ? `${name}, ${year}` : name;
  const caption = `${name}${loc.length ? ` (${loc.join(', ')})` : ''}${desc}. Fotoğraf ${year} yılından.`;
  return { title, caption };
}

function themesOf(seed, file) {
  const t = new Set(seed.t);
  const txt = `${file.title} ${file.cats}`;
  if (/\btram|railway|train|station|locomotive|ferry|steamship|ship\b|harbou?r|port of|airport|aircraft|airplane|car\b|automobile|bus\b|bridge/i.test(txt)) t.add('ulasim');
  if (/\bwar\b|military|soldier|army|navy|battle|troops|wwi|wwii|world war/i.test(txt)) t.add('savas');
  if (/stadium|football|olympic|sport|match|race\b|athlet/i.test(txt)) t.add('spor');
  if (/street|square|avenue|market|bazaar|city|town|district/i.test(txt)) t.add('sehir');
  if (/construction|exposition|world's fair|expo\b|invent|first flight|zeppelin|airship|launch/i.test(txt)) t.add('icat');
  return [...t];
}

// ---------- Ana akış ----------

async function main() {
  const args = process.argv.slice(2);
  const sampleN = args.includes('--sample') ? Number(args[args.indexOf('--sample') + 1]) || 40 : 0;
  const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { photos: [] };
  const prevIds = new Map(prev.photos.map((p) => [p.src.file, p.id]));
  const reject = new Set(prev.rejected ?? []); // göz kontrolünde elenenler (dosya adı)
  const seeds = [...ISTANBUL.map((s) => ({ ...s, group: 'istanbul' })), ...TURKIYE.map((s) => ({ ...s, group: 'turkiye' })), ...WORLD.map((s) => ({ ...s, group: 'world' }))];
  console.log(`${seeds.length} tohum; Wikidata sorgusu…`);
  // Yönlendirmeli kategoriler ({{Category redirect|Hedef}}): hedef adla devam et (Big Ben → Elizabeth Tower gibi).
  for (let i = 0; i < seeds.length; i += 50) {
    const batch = seeds.slice(i, i + 50);
    const j = await commons({ action: 'query', titles: batch.map((x) => `Category:${x.cat}`).join('|'), prop: 'revisions', rvprop: 'content', rvslots: 'main' }, true);
    const norm = new Map((j.query?.normalized ?? []).map((n) => [n.to, n.from]));
    for (const p of j.query?.pages ?? []) {
      const text = p.revisions?.[0]?.slots?.main?.content ?? '';
      const m = text.match(/\{\{\s*(?:Category redirect|Cat redirect|Seecat|Categoryredirect)\s*\|\s*(?:1=)?\s*(?:Category:)?([^|}\n]+)/i);
      if (!m) continue;
      const from = (norm.get(p.title) ?? p.title).replace(/^Category:/, '');
      for (const seed of batch) if (seed.cat === from || seed.cat === from.replace(/_/g, ' ')) { seed.from = seed.cat; seed.cat = m[1].trim(); }
    }
  }
  const places = await placesFor(seeds.map((s) => s.cat));
  for (const seed of seeds) {
    if (seed.lat != null || places.get(seed.cat)?.coord) continue;
    try { const p = await placeFallback(seed.cat); if (p) places.set(seed.cat, p); } catch (err) { console.warn(`  ! yer ${seed.cat}: ${err.message}`); }
  }
  const used = new Set();
  const photos = [];
  const stats = { seedsNoPlace: [], seedsEmpty: [] };
  for (const seed of seeds) {
    const place = places.get(seed.cat);
    const center = seed.lat != null ? { lat: seed.lat, lon: seed.lon } : place?.coord;
    if (!center) { stats.seedsNoPlace.push(seed.cat); continue; }
    const listed = (await gatherFiles(seed)).slice(0, Number(process.env.WW_MAX_FILES) || 300);
    const infos = await fileInfos(listed.map((f) => f.title).filter((t) => !used.has(t) && !reject.has(t)));
    const cands = [];
    for (const { title, hint } of listed) {
      const f = infos.get(title);
      if (!f || used.has(title)) continue;
      if (!/^image\/(jpeg|png|tiff)$/.test(f.mime) || !f.thumb) continue;
      if (f.width < 900 || f.height < 500 || f.width / f.height > 2.6 || f.width / f.height < 0.55) continue;
      if (!LICENSE_OK.test(f.license)) continue;
      const text = `${title} ${f.cats} ${f.desc}`;
      if (BAD.test(text)) continue;
      const year = resolveYear(f, hint);
      if (year == null || year < 1850 || year > 2015) continue;
      // Konum: dosyanın kendi koordinatı (konuya ≤ 25 km ise), yoksa konunun koordinatı. Şehir tohumunda kendi koordinatı şart değil.
      let coord = center;
      let precise = !seed.city;
      if (f.coord && km(f.coord, center) > (seed.city ? 40 : 25)) continue;
      if (f.coord) { coord = f.coord; precise = true; }
      if (seed.years && (year < seed.years[0] || year > seed.years[1])) continue;
      if (seed.group === 'istanbul' && !inIstanbul(coord)) continue;
      cands.push({ f, year, coord, precise, photoHint: PHOTO_HINT.test(text) });
    }
    if (!cands.length) { stats.seedsEmpty.push(seed.cat); console.log(`- ${seed.cat}: 0/${listed.length}`); continue; }
    // Dönem çeşitliliği: önce fotoğraf olduğu belli olanlar, sonra farklı on yıllar.
    cands.sort((a, b) => Number(b.photoHint) - Number(a.photoHint) || Number(b.precise) - Number(a.precise) || a.year - b.year);
    const picked = [];
    const decades = new Set();
    for (const c of cands) {
      if (picked.length >= (seed.n ?? 1)) break;
      const dec = Math.floor(c.year / 10);
      if (decades.has(dec) && cands.some((o) => !decades.has(Math.floor(o.year / 10)) && !picked.includes(o))) continue;
      picked.push(c);
      decades.add(dec);
    }
    for (const c of picked.length ? picked : cands.slice(0, seed.n ?? 1)) {
      used.add(c.f.title);
      const region = regionOf(place, c.coord);
      const sets = [];
      if (region === 'turkiye') sets.push('turkiye');
      if (inIstanbul(c.coord) && c.precise && c.year <= 1990) sets.push('istanbul');
      const { title, caption } = captionOf(place, seed, c.year, c.coord);
      const file = c.f.title.replace(/^File:/, '');
      photos.push({
        id: prevIds.get(file) ?? randomBytes(6).toString('hex'),
        src: { file, thumb: thumbUrl(c.f.thumb) },
        lat: Math.round(c.coord.lat * 1e5) / 1e5,
        lon: Math.round(c.coord.lon * 1e5) / 1e5,
        precise: c.precise,
        year: c.year,
        title_tr: title,
        caption_tr: caption,
        desc_en: c.f.desc.slice(0, 160) || null,
        wikiUrl: place?.wiki ?? c.f.page,
        fileUrl: c.f.page,
        author: c.f.artist || 'Bilinmiyor',
        license: c.f.license,
        licenseUrl: c.f.licenseUrl || c.f.page,
        tags: { era: eraOf(c.year), region, sets, themes: themesOf(seed, c.f) },
        city: Boolean(seed.city),
      });
    }
    console.log(`+ ${seed.cat}: ${picked.length} (${cands.length} aday / ${listed.length})`);
  }
  const MAX_TR = Number(process.env.WW_MAX_TR_SHARE) || 0.3;
  const trOf = () => photos.filter((p) => p.tags.sets.includes('turkiye')).length;
  const droppable = photos.filter((p) => p.tags.sets.includes('turkiye') && !p.tags.sets.includes('istanbul'))
    .sort((a, b) => Number(b.city) - Number(a.city) || b.year - a.year);
  while (trOf() / photos.length > MAX_TR && droppable.length) photos.splice(photos.indexOf(droppable.shift()), 1);
  for (const p of photos) delete p.city;
  photos.sort((a, b) => a.id.localeCompare(b.id));
  const count = (fn) => photos.filter(fn).length;
  const summary = {
    total: photos.length,
    turkiye: count((p) => p.tags.sets.includes('turkiye')),
    istanbul: count((p) => p.tags.sets.includes('istanbul')),
    eras: Object.fromEntries(['1850-1900', '1900-1945', '1945-1980', '1980-2015'].map((e) => [e, count((p) => p.tags.era === e)])),
    regions: Object.fromEntries([...new Set(photos.map((p) => p.tags.region))].map((r) => [r, count((p) => p.tags.region === r)])),
    themes: Object.fromEntries(['savas', 'ulasim', 'spor', 'sehir', 'icat'].map((t) => [t, count((p) => p.tags.themes.includes(t))])),
  };
  mkdirSync(join(ROOT, 'content', 'whenwhere'), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify({ version: 1, builtAt: new Date().toISOString().slice(0, 10), summary, rejected: [...reject], photos }, null, 1)}\n`);
  console.log('Özet:', JSON.stringify(summary, null, 1));
  console.log('Yer bulunamayan tohumlar:', stats.seedsNoPlace.join(', '));
  console.log('Boş tohumlar:', stats.seedsEmpty.join(', '));
  if (sampleN) await sample(photos, sampleN);
}

async function sample(photos, n) {
  mkdirSync(SAMPLE_DIR, { recursive: true });
  const pick = [...photos].sort(() => Math.random() - 0.5).slice(0, n);
  for (const p of pick) {
    const url = p.src.thumb.replace(/\/\d+px-/, '/500px-');
    await sleep(GAP_MS);
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) { console.warn(`örnek alınamadı ${res.status}: ${p.src.file}`); continue; }
    writeFileSync(join(SAMPLE_DIR, `${p.id}.jpg`), Buffer.from(await res.arrayBuffer()));
    console.log(`${p.id}  ${p.year}  ${p.title_tr}  |  ${p.src.file}`);
  }
  console.log(`Örnekler: ${SAMPLE_DIR}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((err) => { console.error(err); process.exit(1); });
