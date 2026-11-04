/** Tar ustar mínimo y determinista (archivos regulares, mtime 0, orden fijo). */
export function metadataTar(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const path of Object.keys(files).sort()) {
    const body = Buffer.from(files[path] ?? '', 'utf8');
    const header = Buffer.alloc(512);
    const name = Buffer.from(path, 'utf8');
    if (name.length > 100) {
      // ustar: prefijo (155) + nombre (100), partidos en una barra.
      const cut = path.lastIndexOf('/');
      const prefix = path.slice(0, cut), rest = path.slice(cut + 1);
      if (Buffer.byteLength(prefix) > 155 || Buffer.byteLength(rest) > 100) throw new Error('PROFILE_PATH_TOO_LONG');
      header.write(rest, 0, 'utf8');
      header.write(prefix, 345, 'utf8');
    } else {
      header.write(path, 0, 'utf8');
    }
    header.write('0000600\0', 100, 'ascii');
    header.write('0000000\0', 108, 'ascii');
    header.write('0000000\0', 116, 'ascii');
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
    header.write('00000000000\0', 136, 'ascii');
    header.write('        ', 148, 'ascii');
    header.write('0', 156, 'ascii');
    header.write('ustar\0', 257, 'ascii');
    header.write('00', 263, 'ascii');
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
