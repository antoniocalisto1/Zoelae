// The quiet public pages (privacy, terms, not found): header, footer and favicon.
import { paintChrome, reflectSession } from './site-chrome.js';

paintChrome({ current: location.pathname });
reflectSession();
