// SADECE TEST: sunucu sürecine NODE_OPTIONS="--import=<bu dosya>" ile önyüklenir (ürün koduna dokunmaz).
// lobby.js'in zaten dışa aktardığı stats() ile bellek kullanımını düzenli aralıklarla stdout'a yazar:
//   @@probe {"t":..., "rss":..., "heapUsed":..., "rooms":..., "identities":...}
// Aynı modül URL'si olduğu için server.js ile aynı lobby.js örneğini görür.
const { stats } = await import(new URL('../../server/lobby.js', import.meta.url));

const every = Number(process.env.PROBE_MS) || 200;
function emit() {
  if (typeof globalThis.gc === 'function' && process.env.PROBE_GC === '1') globalThis.gc();
  const m = process.memoryUsage();
  process.stdout.write(`@@probe ${JSON.stringify({ t: Date.now(), rss: m.rss, heapUsed: m.heapUsed, ...stats() })}\n`);
}
setInterval(emit, every).unref();
emit();
