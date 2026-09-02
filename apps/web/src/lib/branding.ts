/**
 * Organisation branding, on the browser's side of the line.
 *
 * The renderer is the authority on every rule in here. `services/hermes/hermes/
 * tools/branding.py` decides what a logo may be, which accent is legible and
 * which name goes on the document; this module exists so the settings screen can
 * *show* those decisions before a report is generated rather than approximate
 * them and disagree.
 *
 * Two things are deliberately duplicated rather than shared. The contrast
 * formula, because WCAG relative luminance is four lines and an HTTP call to
 * compute it would make a colour picker feel broken. And the image checks,
 * because the upload route holds the service-role key and has to refuse a bad
 * file *before* it writes it, not after a worker later declines to draw it.
 *
 * Nothing here is a security boundary on its own: the same checks run again on
 * the server for every upload, which is where the refusals that matter happen.
 */

export const BRANDING_BUCKET = 'branding';

/** Matches `SUPPORTED_LOGO_MIMES` in branding.py. SVG is excluded there. */
export const LOGO_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type LogoMimeType = (typeof LOGO_MIME_TYPES)[number];

export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
export const MIN_LOGO_EDGE = 32;
export const MAX_LOGO_EDGE = 4000;

/** The product's own accent, used when an organisation has not chosen one. */
export const DEFAULT_ACCENT = '#1f5fbf';

/** What a report says when no name resolves. Matches FALLBACK_BUSINESS_NAME. */
export const FALLBACK_BUSINESS_NAME = 'DataEngine Report';

export function logoObjectPath(organizationId: string): string {
  return `organizations/${organizationId}/branding/logo`;
}

/** A validated `#rrggbb`, or null. Accepts three-digit shorthand. */
export function normaliseAccent(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/^#/, '').toLowerCase();
  if (!/^(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(trimmed)) return null;
  const digits =
    trimmed.length === 3
      ? trimmed
          .split('')
          .map((character) => character + character)
          .join('')
      : trimmed;
  return `#${digits}`;
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(colour: string): number {
  const digits = colour.replace(/^#/, '');
  const r = channel(parseInt(digits.slice(0, 2), 16));
  const g = channel(parseInt(digits.slice(2, 4), 16));
  const b = channel(parseInt(digits.slice(4, 6), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(first: string, second: string): number {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  const [lighter, darker] = a > b ? [a, b] : [b, a];
  return Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100;
}

/**
 * The ink the renderer will choose for this band. Same threshold as
 * `_ink_on` in documents.py, so the preview is the document.
 */
export function inkOn(background: string): string {
  return relativeLuminance(background) < 0.45 ? '#ffffff' : '#10131a';
}

/**
 * Whether either ink choice clears WCAG AA on this accent.
 *
 * Returned rather than enforced by refusal. The band's own type is large and
 * bold, and the renderer already flips its ink to whichever side survives, so
 * the honest thing to tell an administrator is "this will be hard to read"
 * with the number, not "no".
 */
export function accentIsAccessible(accent: string, minimum = 4.5): boolean {
  return Math.max(contrastRatio(accent, '#ffffff'), contrastRatio(accent, '#10131a')) >= minimum;
}

export type BrandingRow = {
  business_name: string | null;
  legal_name?: string | null;
  logo_storage_path: string | null;
  logo_url: string | null;
  accent_color: string | null;
  footer_text: string | null;
};

/**
 * The name a report will carry, and which rule produced it.
 *
 * The order is section 10's, and it is the same order `resolve_business_name`
 * walks in the worker. It is repeated here only so the settings screen can say
 * "reports currently say Acme Accounting, because no business name is set"
 * instead of leaving somebody to generate one and find out.
 */
export function resolveBusinessName(input: {
  branding?: BrandingRow | null;
  organizationName?: string | null;
  workspaceName?: string | null;
}): { name: string; source: 'organization_branding' | 'organization' | 'workspace' | 'fallback' } {
  const clean = (value: string | null | undefined) =>
    typeof value === 'string' && value.trim() ? value.trim().slice(0, 120) : null;

  const stored = clean(input.branding?.business_name);
  if (stored) return { name: stored, source: 'organization_branding' };

  const organization = clean(input.organizationName);
  if (organization) return { name: organization, source: 'organization' };

  const workspace = clean(input.workspaceName);
  if (workspace) return { name: workspace, source: 'workspace' };

  return { name: FALLBACK_BUSINESS_NAME, source: 'fallback' };
}

/**
 * The image format the bytes actually are, not what the browser called them.
 *
 * Sniffed from magic numbers for the same reason the worker sniffs them: an
 * upload's Content-Type is chosen by whatever posted it, and the bucket's own
 * MIME allowlist checks that same claim. A `.png` that is really an SVG has to
 * be refused here or it reaches a renderer that cannot draw it.
 */
export function sniffImageMime(bytes: Uint8Array): string | null {
  const starts = (...signature: number[]) =>
    signature.every((byte, index) => bytes[index] === byte);

  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (
    starts(0x52, 0x49, 0x46, 0x46) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  return null;
}

/**
 * Pixel dimensions, read out of the file's own header.
 *
 * Three small parsers rather than an image library: the web app is a Next
 * server that has never needed to decode an image, and adding sharp — a native
 * binary with a platform-specific build — to check that a logo is not 12 pixels
 * wide is a bad trade. Anything these cannot read returns null, and the caller
 * treats an unreadable header as a refusal rather than as a pass.
 */
export function imageDimensions(
  bytes: Uint8Array,
  mime: string,
): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  try {
    if (mime === 'image/png') {
      // IHDR is always the first chunk: width and height at bytes 16 and 20.
      if (bytes.length < 24) return null;
      return { width: view.getUint32(16), height: view.getUint32(20) };
    }

    if (mime === 'image/jpeg') {
      // Walk the segment markers to the start-of-frame, which carries the size.
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = bytes[offset + 1];
        // SOF0..SOF15, excluding the four that are not frame headers.
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
        }
        offset += 2 + view.getUint16(offset + 2);
      }
      return null;
    }

    if (mime === 'image/webp') {
      const format = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
      if (format === 'VP8 ') {
        return {
          width: view.getUint16(26, true) & 0x3fff,
          height: view.getUint16(28, true) & 0x3fff,
        };
      }
      if (format === 'VP8L') {
        const bits = view.getUint32(21, true);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (format === 'VP8X') {
        const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
        const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
        return { width, height };
      }
      return null;
    }
  } catch {
    return null;
  }

  return null;
}

export type LogoCheck =
  | { ok: true; mime: LogoMimeType; width: number; height: number }
  | { ok: false; reason: string };

/** The whole refusal set, in the order that costs least to evaluate. */
export function checkLogo(bytes: Uint8Array): LogoCheck {
  if (bytes.length === 0) return { ok: false, reason: 'That file is empty.' };
  if (bytes.length > MAX_LOGO_BYTES) {
    return {
      ok: false,
      reason: `A logo must be under ${MAX_LOGO_BYTES / (1024 * 1024)} MB; this one is ${(
        bytes.length /
        (1024 * 1024)
      ).toFixed(1)} MB.`,
    };
  }

  const mime = sniffImageMime(bytes);
  if (!mime) return { ok: false, reason: 'That file is not an image we recognise.' };
  if (!(LOGO_MIME_TYPES as readonly string[]).includes(mime)) {
    return {
      ok: false,
      reason: `${mime} cannot be placed in a PDF or Word document. Use PNG, JPEG or WebP.`,
    };
  }

  const size = imageDimensions(bytes, mime);
  if (!size) return { ok: false, reason: 'That image could not be read.' };
  if (Math.min(size.width, size.height) < MIN_LOGO_EDGE) {
    return {
      ok: false,
      reason: `That image is ${size.width}×${size.height}. A logo needs at least ${MIN_LOGO_EDGE} pixels on each side to print legibly.`,
    };
  }
  if (Math.max(size.width, size.height) > MAX_LOGO_EDGE) {
    return {
      ok: false,
      reason: `That image is ${size.width}×${size.height}, which is a photograph rather than a logo.`,
    };
  }

  return { ok: true, mime: mime as LogoMimeType, width: size.width, height: size.height };
}
