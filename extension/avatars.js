/**
 * WatchSync — cute cartoon animal avatars (inline SVG).
 * Loaded before content.js; registers on window.WatchSyncAvatars.
 */
(function registerWatchSyncAvatars() {
  'use strict';

  const AVATARS = {
    cat: `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
      <circle cx="32" cy="32" r="30" fill="#FFE0B2"/>
      <path d="M14 28 L8 14 L22 22 Z" fill="#FFCC80"/>
      <path d="M50 28 L56 14 L42 22 Z" fill="#FFCC80"/>
      <ellipse cx="32" cy="36" rx="18" ry="16" fill="#FFF3E0"/>
      <circle cx="24" cy="34" r="4" fill="#4E342E"/>
      <circle cx="40" cy="34" r="4" fill="#4E342E"/>
      <circle cx="25" cy="33" r="1.5" fill="#fff"/>
      <circle cx="41" cy="33" r="1.5" fill="#fff"/>
      <ellipse cx="32" cy="40" rx="3" ry="2" fill="#FF8A65"/>
      <path d="M28 44 Q32 47 36 44" stroke="#4E342E" stroke-width="1.5" fill="none" stroke-linecap="round"/>
      <line x1="20" y1="40" x2="14" y2="38" stroke="#BCAAA4" stroke-width="1.2" stroke-linecap="round"/>
      <line x1="44" y1="40" x2="50" y2="38" stroke="#BCAAA4" stroke-width="1.2" stroke-linecap="round"/>
    </svg>`,

    dog: `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
      <circle cx="32" cy="32" r="30" fill="#D7CCC8"/>
      <ellipse cx="18" cy="30" rx="8" ry="14" fill="#A1887F" transform="rotate(-20 18 30)"/>
      <ellipse cx="46" cy="30" rx="8" ry="14" fill="#A1887F" transform="rotate(20 46 30)"/>
      <ellipse cx="32" cy="36" rx="18" ry="16" fill="#EFEBE9"/>
      <circle cx="24" cy="34" r="4" fill="#3E2723"/>
      <circle cx="40" cy="34" r="4" fill="#3E2723"/>
      <circle cx="25" cy="33" r="1.5" fill="#fff"/>
      <circle cx="41" cy="33" r="1.5" fill="#fff"/>
      <ellipse cx="32" cy="40" rx="5" ry="4" fill="#5D4037"/>
      <path d="M26 44 Q32 48 38 44" stroke="#3E2723" stroke-width="1.5" fill="none" stroke-linecap="round"/>
      <path d="M32 28 L32 24" stroke="#8D6E63" stroke-width="2" stroke-linecap="round"/>
    </svg>`,

    bunny: `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
      <circle cx="32" cy="36" r="26" fill="#F8BBD9"/>
      <ellipse cx="22" cy="14" rx="7" ry="18" fill="#FCE4EC"/>
      <ellipse cx="42" cy="14" rx="7" ry="18" fill="#FCE4EC"/>
      <ellipse cx="22" cy="16" rx="4" ry="12" fill="#F48FB1"/>
      <ellipse cx="42" cy="16" rx="4" ry="12" fill="#F48FB1"/>
      <ellipse cx="32" cy="38" rx="16" ry="14" fill="#FFF"/>
      <circle cx="25" cy="36" r="3.5" fill="#4A148C"/>
      <circle cx="39" cy="36" r="3.5" fill="#4A148C"/>
      <circle cx="26" cy="35" r="1.2" fill="#fff"/>
      <circle cx="40" cy="35" r="1.2" fill="#fff"/>
      <ellipse cx="32" cy="42" rx="2.5" ry="2" fill="#F48FB1"/>
      <path d="M28 45 Q32 47 36 45" stroke="#AD1457" stroke-width="1.2" fill="none" stroke-linecap="round"/>
    </svg>`,

    panda: `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
      <circle cx="32" cy="32" r="30" fill="#ECEFF1"/>
      <circle cx="20" cy="28" r="9" fill="#263238"/>
      <circle cx="44" cy="28" r="9" fill="#263238"/>
      <ellipse cx="32" cy="36" rx="18" ry="16" fill="#FAFAFA"/>
      <circle cx="24" cy="34" r="4" fill="#263238"/>
      <circle cx="40" cy="34" r="4" fill="#263238"/>
      <circle cx="25" cy="33" r="1.5" fill="#fff"/>
      <circle cx="41" cy="33" r="1.5" fill="#fff"/>
      <ellipse cx="32" cy="40" rx="3" ry="2.5" fill="#263238"/>
      <path d="M28 44 Q32 46 36 44" stroke="#455A64" stroke-width="1.2" fill="none" stroke-linecap="round"/>
    </svg>`,

    fox: `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
      <circle cx="32" cy="34" r="26" fill="#FF7043"/>
      <path d="M16 20 L10 6 L26 18 Z" fill="#FF7043"/>
      <path d="M48 20 L54 6 L38 18 Z" fill="#FF7043"/>
      <path d="M16 20 L10 6 L20 16 Z" fill="#FFF3E0"/>
      <path d="M48 20 L54 6 L44 16 Z" fill="#FFF3E0"/>
      <ellipse cx="32" cy="38" rx="16" ry="14" fill="#FFF8E1"/>
      <circle cx="25" cy="36" r="3.5" fill="#3E2723"/>
      <circle cx="39" cy="36" r="3.5" fill="#3E2723"/>
      <circle cx="26" cy="35" r="1.2" fill="#fff"/>
      <circle cx="40" cy="35" r="1.2" fill="#fff"/>
      <ellipse cx="32" cy="42" rx="3" ry="2" fill="#3E2723"/>
      <path d="M28 45 Q32 47 36 45" stroke="#BF360C" stroke-width="1.2" fill="none" stroke-linecap="round"/>
    </svg>`,

    bear: `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
      <circle cx="32" cy="34" r="26" fill="#A1887F"/>
      <circle cx="16" cy="20" r="9" fill="#8D6E63"/>
      <circle cx="48" cy="20" r="9" fill="#8D6E63"/>
      <ellipse cx="32" cy="38" rx="16" ry="14" fill="#D7CCC8"/>
      <circle cx="25" cy="36" r="3.5" fill="#3E2723"/>
      <circle cx="39" cy="36" r="3.5" fill="#3E2723"/>
      <circle cx="26" cy="35" r="1.2" fill="#fff"/>
      <circle cx="40" cy="35" r="1.2" fill="#fff"/>
      <ellipse cx="32" cy="42" rx="4" ry="3" fill="#5D4037"/>
      <path d="M28 45 Q32 47 36 45" stroke="#4E342E" stroke-width="1.2" fill="none" stroke-linecap="round"/>
    </svg>`,

    owl: `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
      <circle cx="32" cy="34" r="26" fill="#8D6E63"/>
      <circle cx="32" cy="34" r="22" fill="#D7CCC8"/>
      <circle cx="24" cy="34" r="10" fill="#FFF" stroke="#5D4037" stroke-width="2"/>
      <circle cx="40" cy="34" r="10" fill="#FFF" stroke="#5D4037" stroke-width="2"/>
      <circle cx="24" cy="34" r="5" fill="#FFC107"/>
      <circle cx="40" cy="34" r="5" fill="#FFC107"/>
      <circle cx="24" cy="34" r="2.5" fill="#3E2723"/>
      <circle cx="40" cy="34" r="2.5" fill="#3E2723"/>
      <path d="M32 40 L28 46 L36 46 Z" fill="#FF8F00"/>
      <path d="M26 48 Q32 50 38 48" stroke="#5D4037" stroke-width="1.2" fill="none"/>
    </svg>`,

    penguin: `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
      <ellipse cx="32" cy="36" rx="22" ry="24" fill="#263238"/>
      <ellipse cx="32" cy="38" rx="14" ry="18" fill="#FAFAFA"/>
      <circle cx="26" cy="30" r="4" fill="#FFF"/>
      <circle cx="38" cy="30" r="4" fill="#FFF"/>
      <circle cx="26" cy="30" r="2" fill="#212121"/>
      <circle cx="38" cy="30" r="2" fill="#212121"/>
      <path d="M32 34 L28 40 L36 40 Z" fill="#FF8F00"/>
      <ellipse cx="22" cy="52" rx="6" ry="3" fill="#FF8F00"/>
      <ellipse cx="42" cy="52" rx="6" ry="3" fill="#FF8F00"/>
    </svg>`,
  };

  const IDS = Object.keys(AVATARS);

  window.WatchSyncAvatars = {
    ids: IDS,

    getSvg(id) {
      return AVATARS[id] || AVATARS.cat;
    },

    random() {
      return IDS[Math.floor(Math.random() * IDS.length)];
    },
  };
})();
