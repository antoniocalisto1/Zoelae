// Client-side state. The server remains the only authority — this is a cache of what it returned.
import { api } from './api.js';

export const state = {
  user: null,
  firstSignIn: false,
  artworks: [],
  shares: [],
  clients: null,              // loaded on first need
  summary: null,

  view: 'welcome',            // welcome | collection | detail | shared-links
  detailId: null,

  // collection view controls (same shape as the v1 prototype)
  q: '',
  type: '',
  artist: '',
  status: '',                 // '' | collection | for_sale | sold
  sort: 'added',
  layout: 'grid',

  // selection mode
  selecting: false,
  selected: new Set(),
  lastToggledId: null
};

export const TYPES = ['Painting', 'Sculpture', 'Work on paper', 'Print', 'Photography', 'Other'];
export const STATUSES = ['collection', 'for_sale', 'sold'];
export const STATUS_LABEL = { collection: 'In the collection', for_sale: 'For sale', sold: 'Sold' };

export async function loadArtworks() {
  state.artworks = (await api.get('/api/artworks')).artworks;
  return state.artworks;
}

export async function loadClients(force = false) {
  if (state.clients && !force) return state.clients;
  state.clients = (await api.get('/api/clients')).clients;
  return state.clients;
}

export async function loadShares() {
  state.shares = (await api.get('/api/shares')).shares;
  return state.shares;
}

export async function loadSummary() {
  state.summary = (await api.get('/api/summary')).summary;
  return state.summary;
}

export function resetFilters() {
  state.q = ''; state.type = ''; state.artist = ''; state.status = ''; state.sort = 'added'; state.layout = 'grid';
  state.selecting = false; state.selected.clear(); state.lastToggledId = null;
}

/** Filter + sort, matching the v1 rules — unpriced works always sink to the bottom of price sorts. */
export function visibleArtworks() {
  const q = state.q.trim().toLowerCase();
  const list = state.artworks.filter(w => {
    if (state.artist && w.artist !== state.artist) return false;
    if (state.type && w.type !== state.type) return false;
    if (state.status && w.status !== state.status) return false;
    if (!q) return true;
    return [w.title, w.artist, w.medium, w.type, w.notes, w.storageLocation, w.year, w.inventoryNumber]
      .join(' ').toLowerCase().includes(q);
  });

  const byNumber = (key, dir) => (a, b) => {
    const av = a[key] == null ? null : Number(a[key]);
    const bv = b[key] == null ? null : Number(b[key]);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return dir * (av - bv);
  };

  // Pieces with no recorded year sink to the bottom of the age sorts, the way unpriced ones do.
  const byYear = (dir) => (a, b) => {
    if (a.year == null && b.year == null) return 0;
    if (a.year == null) return 1;
    if (b.year == null) return -1;
    return dir * (a.year - b.year);
  };

  const sorters = {
    age_desc: byYear(1),
    age_asc: byYear(-1),
    price_asc: byNumber('purchasePrice', 1),
    price_desc: byNumber('purchasePrice', -1),
    value_desc: byNumber('currentValuation', -1),
    artist_az: (a, b) => a.artist.localeCompare(b.artist) || (a.year ?? 9999) - (b.year ?? 9999),
    title_az: (a, b) => a.title.localeCompare(b.title),
    added: (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  };
  return list.sort(sorters[state.sort] || sorters.added);
}
