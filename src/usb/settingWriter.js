import fs from 'fs';
import path from 'path';

// ─── CRC-16/XMODEM ────────────────────────────────────────────────────────────
// Polynomial: 0x1021  Init: 0x0000  RefIn: false  RefOut: false  XorOut: 0x0000

export function crc16xmodem(buf) {
  let crc = 0x0000;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i] << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

// ─── File builder ─────────────────────────────────────────────────────────────

/**
 * Builds a complete SETTING.DAT binary file.
 *
 * Layout per rekordcrate:
 *   u32 LE  len_stringdata = 0x60 (96)
 *   32 B    brand string (null-padded)
 *   32 B    software = "rekordbox" (null-padded)
 *   32 B    version  = "6.6.1"    (null-padded)
 *   u32 LE  len_data
 *   N  B    payload
 *   u16 LE  CRC-16/XMODEM of payload bytes
 *   u16 LE  0x0000
 *
 * @param {string} brand    - Brand string (e.g. "PIONEER" or "PIONEER DJ")
 * @param {Buffer} payload  - Setting-specific data bytes
 */
export function buildSettingFile(brand, payload) {
  const header = Buffer.alloc(104); // 4 + 32 + 32 + 32 + 4
  header.writeUInt32LE(0x60, 0); // len_stringdata
  header.write(brand, 4, 'ascii'); // brand (remaining bytes stay 0)
  header.write('rekordbox', 36, 'ascii'); // software
  header.write('6.6.1', 68, 'ascii'); // version
  header.writeUInt32LE(payload.length, 100); // len_data

  const footer = Buffer.alloc(4);
  footer.writeUInt16LE(crc16xmodem(payload), 0);
  // bytes 2-3 stay 0x0000

  return Buffer.concat([header, payload, footer]);
}

// ─── Payloads ─────────────────────────────────────────────────────────────────

/** MYSETTING.DAT payload — 40 bytes, Pioneer CDJ player preferences */
export function buildMySettingPayload() {
  return Buffer.from([
    0x78,
    0x56,
    0x34,
    0x12,
    0x02,
    0x00,
    0x00,
    0x00, // unknown1
    0x81, // on_air_display        = On
    0x83, // lcd_brightness        = Three
    0x81, // quantize              = On
    0x88, // auto_cue_level        = Memory
    0x81, // language              = English
    0x01, // unknown2
    0x83, // jog_ring_brightness   = Bright
    0x81, // jog_ring_indicator    = On
    0x81, // slip_flashing         = On
    0x01,
    0x01,
    0x01, // unknown3
    0x83, // disc_slot_illumination = Bright
    0x80, // eject_lock            = Unlock
    0x80, // sync                  = Off
    0x81, // play_mode             = Single
    0x80, // quantize_beat_value   = FullBeat
    0x81, // hotcue_autoload       = On
    0x80, // hotcue_color          = Off
    0x00,
    0x00, // unknown4
    0x81, // needle_lock           = Lock
    0x00,
    0x00, // unknown5
    0x81, // time_mode             = Remain
    0x81, // jog_mode              = Vinyl
    0x81, // auto_cue              = On
    0x80, // master_tempo          = Off
    0x81, // tempo_range           = TenPercent
    0x80, // phase_meter           = Type1
    0x00,
    0x00, // unknown6
  ]);
}

/** MYSETTING2.DAT payload — 40 bytes, extended CDJ preferences */
export function buildMySetting2Payload() {
  const buf = Buffer.alloc(40);
  buf[0] = 0x81; // vinyl_speed_adjust       = Touch
  buf[1] = 0x80; // jog_display_mode         = Auto
  buf[2] = 0x83; // pad_button_brightness    = Three
  buf[3] = 0x83; // jog_lcd_brightness       = Three
  buf[4] = 0x81; // waveform_divisions       = Phrase
  // buf[5..9] = 0x00 (unknown1, 5 bytes)
  buf[10] = 0x80; // waveform                 = Waveform
  buf[11] = 0x81; // unknown2
  buf[12] = 0x85; // beat_jump_beat_value     = SixteenBeat (0x80 + 5)
  // buf[13..39] = 0x00 (unknown3, 27 bytes)
  return buf;
}

/** DEVSETTING.DAT payload — 32 bytes, device display preferences */
export function buildDevSettingPayload() {
  const buf = Buffer.alloc(32);
  buf[0] = 0x78;
  buf[1] = 0x56;
  buf[2] = 0x34;
  buf[3] = 0x12;
  buf[4] = 0x01; // unknown1[4..8]
  // buf[5..7] = 0x00
  buf[8] = 0x01; // unknown1[8]
  buf[9] = 0x01; // overview_waveform_type   = HalfWaveform
  buf[10] = 0x01; // waveform_color           = Blue
  buf[11] = 0x01; // unknown2
  buf[12] = 0x01; // key_display_format       = Classic
  buf[13] = 0x01; // waveform_current_position = Center
  // buf[14..31] = 0x00 (unknown3, 18 bytes)
  return buf;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Write Pioneer SETTING.DAT files to the PIONEER/ directory on a USB drive.
 * These configure CDJ/XDJ player defaults when a drive is first inserted.
 *
 * Files written:
 *   PIONEER/MYSETTING.DAT   — CDJ player preferences
 *   PIONEER/MYSETTING2.DAT  — Extended CDJ preferences
 *   PIONEER/DEVSETTING.DAT  — Device display preferences
 *
 * @param {string} usbRoot - Absolute path to USB drive root
 */
export function writeSettingFiles(usbRoot) {
  const pioneerDir = path.join(usbRoot, 'PIONEER');
  fs.mkdirSync(pioneerDir, { recursive: true });

  fs.writeFileSync(
    path.join(pioneerDir, 'MYSETTING.DAT'),
    buildSettingFile('PIONEER', buildMySettingPayload())
  );
  fs.writeFileSync(
    path.join(pioneerDir, 'MYSETTING2.DAT'),
    buildSettingFile('PIONEER', buildMySetting2Payload())
  );
  fs.writeFileSync(
    path.join(pioneerDir, 'DEVSETTING.DAT'),
    buildSettingFile('PIONEER DJ', buildDevSettingPayload())
  );
}
