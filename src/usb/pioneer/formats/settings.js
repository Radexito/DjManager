import fs from 'fs';
import path from 'path';

/**
 * CRC-16/XMODEM (polynomial 0x1021, initial value 0) of a buffer, the checksum
 * SETTING.DAT ends with.
 * @param {Buffer} buf
 * @returns {number}
 */
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
  const header = Buffer.alloc(104);
  header.writeUInt32LE(0x60, 0);
  header.write(brand, 4, 'ascii');
  header.write('rekordbox', 36, 'ascii');
  header.write('6.6.1', 68, 'ascii');
  header.writeUInt32LE(payload.length, 100);

  const footer = Buffer.alloc(4);
  footer.writeUInt16LE(crc16xmodem(payload), 0);

  return Buffer.concat([header, payload, footer]);
}

/** MYSETTING.DAT payload — 40 bytes, Pioneer CDJ player preferences */
export function buildMySettingPayload() {
  return Buffer.from([
    0x78, 0x56, 0x34, 0x12, 0x02, 0x00, 0x00, 0x00, 0x81, 0x83, 0x81, 0x88, 0x81, 0x01, 0x83, 0x81,
    0x81, 0x01, 0x01, 0x01, 0x83, 0x80, 0x80, 0x81, 0x80, 0x81, 0x80, 0x00, 0x00, 0x81, 0x00, 0x00,
    0x81, 0x81, 0x81, 0x80, 0x81, 0x80, 0x00, 0x00,
  ]);
}

/** MYSETTING2.DAT payload — 40 bytes, extended CDJ preferences */
export function buildMySetting2Payload() {
  const buf = Buffer.alloc(40);
  buf[0] = 0x81;
  buf[1] = 0x80;
  buf[2] = 0x83;
  buf[3] = 0x83;
  buf[4] = 0x81;
  buf[10] = 0x80;
  buf[11] = 0x81;
  buf[12] = 0x85;
  return buf;
}

/** DEVSETTING.DAT payload — 32 bytes, device display preferences */
export function buildDevSettingPayload() {
  const buf = Buffer.alloc(32);
  buf[0] = 0x78;
  buf[1] = 0x56;
  buf[2] = 0x34;
  buf[3] = 0x12;
  buf[4] = 0x01;
  buf[8] = 0x01;
  buf[9] = 0x01;
  buf[10] = 0x01;
  buf[11] = 0x01;
  buf[12] = 0x01;
  buf[13] = 0x01;
  return buf;
}

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
