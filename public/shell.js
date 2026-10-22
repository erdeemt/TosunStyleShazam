// Uygulama kabuğu: sol menü, ana sayfa ve oyunlar arası geçiş (#/kategori/oyun).
import { CATEGORIES, GAMES } from './games.js';

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

const gamesIn = (categoryId) => GAMES.filter((g) => g.categories.includes(categoryId));
const href = (categoryId, gameId) => `#/${categoryId}/${gameId}`;

function renderNav() {
  $('nav').replaceChildren(...CATEGORIES.map((cat) =>
    el('div', { class: 'nav-group' },
      el('div', { class: 'nav-cat' }, `${cat.icon} ${cat.name}`),
      ...gamesIn(cat.id).map((g) =>
        el('a', { class: 'nav-item', href: href(cat.id, g.id), 'data-route': `${cat.id}/${g.id}` },
          el('span', { class: 'nav-icon' }, g.icon), g.name)),
      el('div', { class: 'nav-item soon' }, el('span', { class: 'nav-icon' }, '➕'), 'Yakında')),
  ));
}

function renderHome() {
  $('home-cats').replaceChildren(...CATEGORIES.map((cat) =>
    el('section', { class: 'home-cat' },
      el('h2', {}, `${cat.icon} ${cat.name}`),
      el('div', { class: 'game-grid' },
        ...gamesIn(cat.id).map((g) =>
          el('a', { class: 'game-card-link', href: href(cat.id, g.id) },
            el('span', { class: 'game-card-icon' }, g.icon),
            el('b', {}, g.name),
            el('small', {}, g.desc))),
        el('div', { class: 'game-card-link soon' },
          el('span', { class: 'game-card-icon' }, '➕'), el('b', {}, 'Yakında'), el('small', {}, 'Yeni oyunlar geliyor'))))));
}

let active = null; // { game, module }

async function route() {
  const [categoryId, gameId] = location.hash.replace(/^#\/?/, '').split('/');
  const category = CATEGORIES.find((c) => c.id === categoryId);
  const game = category && gamesIn(category.id).find((g) => g.id === gameId);

  for (const a of document.querySelectorAll('.nav-item[data-route]')) {
    a.classList.toggle('active', a.dataset.route === `${categoryId}/${gameId}`);
  }
  document.body.classList.remove('nav-open');

  if (active && active.game !== game) {
    active.module.leave();
    $(`game-${active.game.id}`).classList.add('hidden');
    active = null;
  }
  $('game-title').classList.toggle('hidden', !game);
  if (!game) {
    $('view-home').classList.remove('hidden');
    document.title = 'Tosun Style';
    return;
  }
  $('view-home').classList.add('hidden');
  $(`game-${game.id}`).classList.remove('hidden');
  $('game-title').textContent = `${game.icon} ${game.name} · ${category.name}`;
  document.title = `${game.name} · Tosun Style`;
  const module = active?.module ?? await game.load();
  active = { game, module };
  module.enter(category.id);
}

$('nav-toggle').addEventListener('click', () => document.body.classList.toggle('nav-open'));
$('nav-backdrop').addEventListener('click', () => document.body.classList.remove('nav-open'));
window.addEventListener('hashchange', route);

renderNav();
renderHome();
route();
