'use strict';
const { migrate } = require('./db');

const count = migrate();
console.log(count ? `Migrations complete — ${count} applied.` : 'Migrations complete — already up to date.');
