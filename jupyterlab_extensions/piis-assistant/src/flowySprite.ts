/**
 * Flowy's SVG sprite — the single source of truth for how the mascot looks.
 *
 * Both the floating :class:`AvatarAssistant` and the sidebar's Flowy tab render
 * Flowy from here, so the character stays consistent everywhere. The function
 * is pure (mood + a unique id in, SVG string out); callers own animation and
 * placement via CSS.
 */

export type FlowyMood =
  | 'idle'
  | 'thinking'
  | 'happy'
  | 'celebrating'
  | 'concerned'
  | 'angry'
  | 'suspicious'
  | 'sleepy';

export interface FlowySpriteOptions {
  /** Unique suffix for gradient ids so multiple sprites don't collide. */
  uid: string;
  /** SVG pixel width (height scales with the 64×72 viewBox). */
  width?: number;
}

export function renderFlowySvg(mood: FlowyMood, options: FlowySpriteOptions): string {
  const { uid } = options;
  const width = options.width ?? 58;
  const height = Math.round((width * 72) / 64);

  const eyeOffset = mood === 'concerned' ? '2' : '0';
  const sleepy = mood === 'sleepy';
  const mouthPath = mouthPathFor(mood);
  const body = bodyFillFor(mood);
  const angry = mood === 'angry';
  const suspicious = mood === 'suspicious';
  const happy = mood === 'happy' || mood === 'celebrating';
  const browOpacity = angry || suspicious ? '1' : '0';
  const leftBrow = angry ? 'M 15 20 L 27 24' : 'M 15 22 L 27 21';
  const rightBrow = angry
    ? 'M 49 20 L 37 24'
    : suspicious
      ? 'M 49 17 L 37 20'
      : 'M 49 22 L 37 21';

  const antennaFill =
    mood === 'celebrating'
      ? '#ffd24a'
      : mood === 'happy'
        ? '#7be495'
        : angry
          ? '#ff5b5b'
          : '#4dc6ff';

  const eyes = sleepy
    ? `
      <path d="M 17 29 Q 23 33 29 29" fill="none" stroke="#10243a" stroke-width="2.4" stroke-linecap="round"/>
      <path d="M 35 29 Q 41 33 47 29" fill="none" stroke="#10243a" stroke-width="2.4" stroke-linecap="round"/>
    `
    : `
      <g class="flowquest-avatarEyes" transform="translate(0, ${eyeOffset})">
        <ellipse cx="23" cy="29" rx="5" ry="6" fill="#10243a"/>
        <ellipse cx="41" cy="29" rx="5" ry="6" fill="#10243a"/>
        <circle cx="24.9" cy="26.8" r="1.8" fill="#ffffff"/>
        <circle cx="42.9" cy="26.8" r="1.8" fill="#ffffff"/>
        <circle cx="21.4" cy="31.6" r="1" fill="#ffffff" opacity="0.7"/>
        <circle cx="39.4" cy="31.6" r="1" fill="#ffffff" opacity="0.7"/>
      </g>
    `;

  const steam = angry
    ? `
      <g class="flowquest-avatarSteam" fill="none" stroke="#ff5b5b" stroke-width="2.2" stroke-linecap="round">
        <path d="M49 11 q 4 -4 0 -8"/>
        <path d="M55 15 q 5 -4 1 -9"/>
      </g>`
    : '';

  const think =
    mood === 'thinking'
      ? `
      <g class="flowquest-avatarThink">
        <circle cx="52" cy="16" r="3" fill="#4dc6ff" stroke="#10243a" stroke-width="0.8"/>
        <circle cx="58" cy="10" r="2" fill="#4dc6ff" stroke="#10243a" stroke-width="0.7"/>
        <circle cx="62" cy="5" r="1.4" fill="#4dc6ff"/>
      </g>`
      : '';

  const stars =
    mood === 'celebrating'
      ? `
      <g class="flowquest-avatarStars">
        <path d="M7 11 L9 16 L14 18 L9 20 L7 25 L5 20 L0 18 L5 16 Z" fill="#ffd24a" stroke="#10243a" stroke-width="0.6"/>
        <path d="M57 7 L58.5 11 L62 12 L58.5 13 L57 17 L55.5 13 L52 12 L55.5 11 Z" fill="#ff5b8d" stroke="#10243a" stroke-width="0.6"/>
        <path d="M54 51 L55 54 L58 55 L55 56 L54 59 L53 56 L50 55 L53 54 Z" fill="#7be495" stroke="#10243a" stroke-width="0.6"/>
      </g>`
      : '';

  const blush = happy
    ? `
      <ellipse cx="17" cy="40" rx="4.6" ry="2.9" fill="#ff5b8d" opacity="0.4"/>
      <ellipse cx="47" cy="40" rx="4.6" ry="2.9" fill="#ff5b8d" opacity="0.4"/>`
    : angry
      ? `
      <ellipse cx="16" cy="41" rx="4.6" ry="2.9" fill="#ff3b3b" opacity="0.4"/>
      <ellipse cx="48" cy="41" rx="4.6" ry="2.9" fill="#ff3b3b" opacity="0.4"/>`
      : '';

  return `
    <svg viewBox="0 0 64 72" width="${width}" height="${height}" class="flowquest-avatarSvg">
      <defs>
        <radialGradient id="${uid}-body" cx="38%" cy="30%" r="80%">
          <stop offset="0%" stop-color="${body.light}"/>
          <stop offset="55%" stop-color="${body.mid}"/>
          <stop offset="100%" stop-color="${body.dark}"/>
        </radialGradient>
        <radialGradient id="${uid}-ao" cx="50%" cy="92%" r="55%">
          <stop offset="0%" stop-color="#10243a" stop-opacity="0.30"/>
          <stop offset="100%" stop-color="#10243a" stop-opacity="0"/>
        </radialGradient>
        <linearGradient id="${uid}-rim" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stop-color="#ffffff" stop-opacity="0.55"/>
          <stop offset="45%" stop-color="#ffffff" stop-opacity="0"/>
        </linearGradient>
        <linearGradient id="${uid}-fin" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${body.mid}"/>
          <stop offset="100%" stop-color="${body.dark}"/>
        </linearGradient>
        <radialGradient id="${uid}-spec" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="#ffffff" stop-opacity="0.9"/>
          <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
        </radialGradient>
      </defs>

      <ellipse class="flowquest-avatarShadow" cx="32" cy="67" rx="15" ry="3.5" fill="#10243a" opacity="0.18"/>

      ${steam}
      ${think}
      ${stars}

      <line x1="32" y1="9" x2="32" y2="3" stroke="#10243a" stroke-width="2" stroke-linecap="round"/>
      <g transform="translate(32 5)">
        <path class="flowquest-avatarAntenna" d="M0 -4.2 L1.3 -1.3 L4.2 0 L1.3 1.3 L0 4.2 L-1.3 1.3 L-4.2 0 L-1.3 -1.3 Z"
          fill="${antennaFill}" stroke="#10243a" stroke-width="0.8"/>
      </g>

      <g class="flowquest-avatarCreature">
        <path class="flowquest-avatarFin flowquest-avatarFin-l" d="M9 31 q -7 4 -2 13 q 6 -1 8 -7 Z" fill="url(#${uid}-fin)" stroke="#10243a" stroke-width="2" stroke-linejoin="round"/>
        <path class="flowquest-avatarFin flowquest-avatarFin-r" d="M55 31 q 7 4 2 13 q -6 -1 -8 -7 Z" fill="url(#${uid}-fin)" stroke="#10243a" stroke-width="2" stroke-linejoin="round"/>

        <ellipse cx="25" cy="59" rx="4.6" ry="3" fill="${body.dark}" stroke="#10243a" stroke-width="2"/>
        <ellipse cx="39" cy="59" rx="4.6" ry="3" fill="${body.dark}" stroke="#10243a" stroke-width="2"/>

        <path d="M32 8 C 47 8 54 19 54 33 C 54 49 44 58 32 58 C 20 58 10 49 10 33 C 10 19 17 8 32 8 Z"
          fill="url(#${uid}-body)" stroke="#10243a" stroke-width="2.6" stroke-linejoin="round"/>
        <path d="M32 8 C 47 8 54 19 54 33 C 54 49 44 58 32 58 C 20 58 10 49 10 33 C 10 19 17 8 32 8 Z"
          fill="url(#${uid}-ao)"/>
        <path d="M50 30 C 54 38 50 50 38 56 C 46 51 51 42 50 30 Z" fill="url(#${uid}-rim)" opacity="0.7"/>

        <ellipse cx="26" cy="19" rx="12" ry="7" fill="url(#${uid}-spec)" transform="rotate(-18 26 19)"/>
        <ellipse cx="24" cy="16" rx="4" ry="2.2" fill="#ffffff" opacity="0.85"/>

        ${blush}

        <g opacity="${browOpacity}" stroke="#10243a" stroke-width="2.6" stroke-linecap="round">
          <path d="${leftBrow}"/>
          <path d="${rightBrow}"/>
        </g>

        ${eyes}

        <path d="${mouthPath}" fill="none" stroke="#10243a" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
      </g>
    </svg>
  `;
}

export function mouthPathFor(mood: FlowyMood): string {
  switch (mood) {
    case 'happy':
      return 'M 22 42 Q 32 51 42 42';
    case 'celebrating':
      return 'M 20 43 Q 32 55 44 43 Q 32 49 20 43 Z';
    case 'concerned':
      return 'M 24 45 Q 32 40 40 45';
    case 'angry':
      return 'M 23 47 Q 32 39 41 47';
    case 'suspicious':
      return 'M 25 45 L 39 43';
    case 'sleepy':
      return 'M 27 44 Q 32 47 37 44';
    case 'thinking':
      return 'M 27 44 Q 32 47 37 41';
    case 'idle':
    default:
      return 'M 24 43 Q 32 48 40 43';
  }
}

export function bodyFillFor(mood: FlowyMood): { light: string; mid: string; dark: string } {
  switch (mood) {
    case 'happy':
      return { light: '#d8ffe6', mid: '#7be495', dark: '#34a866' };
    case 'celebrating':
      return { light: '#fff0c2', mid: '#ffd24a', dark: '#ff8f4a' };
    case 'concerned':
      return { light: '#ffe0bf', mid: '#ffaa3b', dark: '#e0631f' };
    case 'angry':
      return { light: '#ffc4b3', mid: '#ff7a5b', dark: '#e02a1f' };
    case 'suspicious':
      return { light: '#fff0c2', mid: '#ffcf57', dark: '#e0962a' };
    case 'sleepy':
      return { light: '#e6dcff', mid: '#b48bff', dark: '#7a5fb8' };
    case 'thinking':
      return { light: '#cdeeff', mid: '#4dc6ff', dark: '#2a7fcc' };
    case 'idle':
    default:
      return { light: '#ffffff', mid: '#dfe8ff', dark: '#aebde6' };
  }
}
