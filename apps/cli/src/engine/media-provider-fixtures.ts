/** Offline format vectors: ADTS AAC-LC 44.1kHz stereo silent raw-data block; RFC 7845
 * stereo mapping-family 0 Ogg Opus pages with RFC 6716 silence packet and independent Ogg CRCs.
 * PCM is eight literal sample bytes; no rate/endianness correction is implied. */
export const PROVIDER_MEDIA_BYTES = {
  aac: Uint8Array.from(Buffer.from('fff1508001bffc211004608c1c', 'hex')),
  opus: Uint8Array.from(
    Buffer.from(
      '4f6767530002000000000000000053455431000000002f8fa6e101134f707573486561640102000080bb00000000004f67675300000000000000000000534554310100000082f6e5de01104f7075735461677300000000000000004f6767530004c00300000000000053455431020000008eb19cdd0103f8fffe',
      'hex',
    ),
  ),
  pcm: new Uint8Array([0, 0, 1, 0, 255, 255, 0, 128]),
} as const;
