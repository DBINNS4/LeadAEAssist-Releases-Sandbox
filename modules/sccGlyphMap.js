'use strict';

/**
 * CEA-608 two-byte glyph map for SCC output.
 *
 * SCC is a textual representation of CEA-608 line-21 closed captions.
 * Certain glyphs are encoded as *two-byte* character pairs ("Special North
 * American" and "Extended Western European" sets).
 *
 * IMPORTANT:
 *   - These are *data bytes* without parity. Odd parity is added by the encoder.
 *   - CEA-608 uses two "data channels":
 *       • CC1/CC3  (data channel 1)
 *       • CC2/CC4  (data channel 2)
 *     The first byte differs by data channel; the second byte (lo) is the same.
 *
 * Shape:
 *   { '<unicode>': { hiCh1: <7-bit>, hiCh2: <7-bit>, lo: <7-bit> } }
 */
const extendedGlyphMap = {
  // ------------------------ Special North American
  // First byte: 0x11 (CC1/CC3) or 0x19 (CC2/CC4)
  // Second byte: 0x30..0x3F

  '®': { hiCh1: 0x11, hiCh2: 0x19, lo: 0x30 },
  '°': { hiCh1: 0x11, hiCh2: 0x19, lo: 0x31 },
  '½': { hiCh1: 0x11, hiCh2: 0x19, lo: 0x32 },
  '¿': { hiCh1: 0x11, hiCh2: 0x19, lo: 0x33 },
  '™': { hiCh1: 0x11, hiCh2: 0x19, lo: 0x34 },
  '¢': { hiCh1: 0x11, hiCh2: 0x19, lo: 0x35 },
  '£': { hiCh1: 0x11, hiCh2: 0x19, lo: 0x36 },

  // Music 8th note — common "music is playing / singing" icon
  '♪': { hiCh1: 0x11, hiCh2: 0x19, lo: 0x37 },

  'à': { hiCh1: 0x11, hiCh2: 0x19, lo: 0x38 },
  // 0x39 is "transparent space"; it is intentionally not exposed here.
  'è': { hiCh1: 0x11, hiCh2: 0x19, lo: 0x3A },
  'â': { hiCh1: 0x11, hiCh2: 0x19, lo: 0x3B },
  'ê': { hiCh1: 0x11, hiCh2: 0x19, lo: 0x3C },
  'î': { hiCh1: 0x11, hiCh2: 0x19, lo: 0x3D },
  'ô': { hiCh1: 0x11, hiCh2: 0x19, lo: 0x3E },
  'û': { hiCh1: 0x11, hiCh2: 0x19, lo: 0x3F },

  // ------------------------ Extended Western European (set 1)
  // First byte: 0x12 (CC1/CC3) or 0x1A (CC2/CC4)
  // Second byte: 0x20..0x3F

  'Á': { hiCh1: 0x12, hiCh2: 0x1A, lo: 0x20 },
  'É': { hiCh1: 0x12, hiCh2: 0x1A, lo: 0x21 },
  'Ó': { hiCh1: 0x12, hiCh2: 0x1A, lo: 0x22 },
  'Ú': { hiCh1: 0x12, hiCh2: 0x1A, lo: 0x23 },
  'Ü': { hiCh1: 0x12, hiCh2: 0x1A, lo: 0x24 },
  'ü': { hiCh1: 0x12, hiCh2: 0x1A, lo: 0x25 },
  '‘': { hiCh1: 0x12, hiCh2: 0x1A, lo: 0x26 },
  '¡': { hiCh1: 0x12, hiCh2: 0x1A, lo: 0x27 },
  '*': { hiCh1: 0x12, hiCh2: 0x1A, lo: 0x28 },
  '’': { hiCh1: 0x12, hiCh2: 0x1A, lo: 0x29 },
  '━': { hiCh1: 0x12, hiCh2: 0x1A, lo: 0x2A },
  '©': { hiCh1: 0x12, hiCh2: 0x1A, lo: 0x2B },
  '℠': { hiCh1: 0x12, hiCh2: 0x1A, lo: 0x2C },
  '•': { hiCh1: 0x12, hiCh2: 0x1A, lo: 0x2D },
  '“': { hiCh1: 0x12, hiCh2: 0x1A, lo: 0x2E },
  '”': { hiCh1: 0x12, hiCh2: 0x1A, lo: 0x2F },
  'À': { hiCh1: 0x12, hiCh2: 0x1A, lo: 0x30 },
  'Â': { hiCh1: 0x12, hiCh2: 0x1A, lo: 0x31 },
  'Ç': { hiCh1: 0x12, hiCh2: 0x1A, lo: 0x32 },
  'È': { hiCh1: 0x12, hiCh2: 0x1A, lo: 0x33 },
  'Ê': { hiCh1: 0x12, hiCh2: 0x1A, lo: 0x34 },
  'Ë': { hiCh1: 0x12, hiCh2: 0x1A, lo: 0x35 },
  'ë': { hiCh1: 0x12, hiCh2: 0x1A, lo: 0x36 },
  'Î': { hiCh1: 0x12, hiCh2: 0x1A, lo: 0x37 },
  'Ï': { hiCh1: 0x12, hiCh2: 0x1A, lo: 0x38 },
  'ï': { hiCh1: 0x12, hiCh2: 0x1A, lo: 0x39 },
  'Ô': { hiCh1: 0x12, hiCh2: 0x1A, lo: 0x3A },
  'Ù': { hiCh1: 0x12, hiCh2: 0x1A, lo: 0x3B },
  'ù': { hiCh1: 0x12, hiCh2: 0x1A, lo: 0x3C },
  'Û': { hiCh1: 0x12, hiCh2: 0x1A, lo: 0x3D },
  '«': { hiCh1: 0x12, hiCh2: 0x1A, lo: 0x3E },
  '»': { hiCh1: 0x12, hiCh2: 0x1A, lo: 0x3F },

  // ------------------------ Extended Western European (set 2)
  // First byte: 0x13 (CC1/CC3) or 0x1B (CC2/CC4)
  // Second byte: 0x20..0x3F

  'Ã': { hiCh1: 0x13, hiCh2: 0x1B, lo: 0x20 },
  'ã': { hiCh1: 0x13, hiCh2: 0x1B, lo: 0x21 },
  'Í': { hiCh1: 0x13, hiCh2: 0x1B, lo: 0x22 },
  'Ì': { hiCh1: 0x13, hiCh2: 0x1B, lo: 0x23 },
  'ì': { hiCh1: 0x13, hiCh2: 0x1B, lo: 0x24 },
  'Ò': { hiCh1: 0x13, hiCh2: 0x1B, lo: 0x25 },
  'ò': { hiCh1: 0x13, hiCh2: 0x1B, lo: 0x26 },
  'Õ': { hiCh1: 0x13, hiCh2: 0x1B, lo: 0x27 },
  'õ': { hiCh1: 0x13, hiCh2: 0x1B, lo: 0x28 },
  '{': { hiCh1: 0x13, hiCh2: 0x1B, lo: 0x29 },
  '}': { hiCh1: 0x13, hiCh2: 0x1B, lo: 0x2A },
  '\\': { hiCh1: 0x13, hiCh2: 0x1B, lo: 0x2B },
  '^': { hiCh1: 0x13, hiCh2: 0x1B, lo: 0x2C },
  '_': { hiCh1: 0x13, hiCh2: 0x1B, lo: 0x2D },
  '|': { hiCh1: 0x13, hiCh2: 0x1B, lo: 0x2E },
  '∼': { hiCh1: 0x13, hiCh2: 0x1B, lo: 0x2F },
  'Ä': { hiCh1: 0x13, hiCh2: 0x1B, lo: 0x30 },
  'ä': { hiCh1: 0x13, hiCh2: 0x1B, lo: 0x31 },
  'Ö': { hiCh1: 0x13, hiCh2: 0x1B, lo: 0x32 },
  'ö': { hiCh1: 0x13, hiCh2: 0x1B, lo: 0x33 },
  'ß': { hiCh1: 0x13, hiCh2: 0x1B, lo: 0x34 },
  '¥': { hiCh1: 0x13, hiCh2: 0x1B, lo: 0x35 },
  '¤': { hiCh1: 0x13, hiCh2: 0x1B, lo: 0x36 },
  '┃': { hiCh1: 0x13, hiCh2: 0x1B, lo: 0x37 },
  'Å': { hiCh1: 0x13, hiCh2: 0x1B, lo: 0x38 },
  'å': { hiCh1: 0x13, hiCh2: 0x1B, lo: 0x39 },
  'Ø': { hiCh1: 0x13, hiCh2: 0x1B, lo: 0x3A },
  'ø': { hiCh1: 0x13, hiCh2: 0x1B, lo: 0x3B },
  '┏': { hiCh1: 0x13, hiCh2: 0x1B, lo: 0x3C },
  '┓': { hiCh1: 0x13, hiCh2: 0x1B, lo: 0x3D },
  '┗': { hiCh1: 0x13, hiCh2: 0x1B, lo: 0x3E },
  '┛': { hiCh1: 0x13, hiCh2: 0x1B, lo: 0x3F }
};

module.exports = {
  extendedGlyphMap
};


// This is the canonical place to maintain any extended icons you want in SCC.
