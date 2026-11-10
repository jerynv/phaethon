import zlib from "node:zlib";

/** Tests only: small PDFs built by hand, as the Rust tests built them. */

/** A PDF from `objects` (numbered from 1; the catalog first), with an xref. */
export function pdf(objects: (string | Buffer)[]): Buffer {
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")];
  let len = parts[0].length;
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(len);
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, "latin1"), typeof o === "string" ? Buffer.from(o, "latin1") : o, Buffer.from("\nendobj\n", "latin1")]);
    parts.push(b);
    len += b.length;
  });
  let tail = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) tail += `${String(o).padStart(10, "0")} 00000 n \n`;
  tail += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${len}\n%%EOF\n`;
  parts.push(Buffer.from(tail, "latin1"));
  return Buffer.concat(parts);
}

export function stream(dict: string, body: Buffer | string): Buffer {
  const b = typeof body === "string" ? Buffer.from(body, "latin1") : body;
  return Buffer.concat([Buffer.from(`<< ${dict} /Length ${b.length} >>\nstream\n`, "latin1"), b, Buffer.from("\nendstream", "latin1")]);
}

/** A small, valid one-page PDF showing `text`. */
export function testPdf(text: string): Buffer {
  const content = `BT /F1 12 Tf 72 712 Td (${text}) Tj ET`;
  return pdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ]);
}

/** A one-page PDF that is only a stored grey picture, `w`×`h` pixels at 150 dpi, no text layer. */
export function greyPdf(w: number, h: number, grey: Buffer): Buffer {
  const packed = zlib.deflateSync(grey, { level: 6 });
  const pw = (w * 72) / 150;
  const ph = (h * 72) / 150;
  return pdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>`,
    stream("", `q ${pw} 0 0 ${ph} 0 0 cm /Im1 Do Q`),
    stream(`/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, packed),
  ]);
}

/**
 * Three pages with typed text. Page 1 draws a 300×200 grey picture (through a
 * form) and a 16×16 icon twice; page 2 draws nothing although every picture
 * is in the page tree's shared resources; page 3 draws a JPEG and an inline image.
 */
export function sample(): Buffer {
  const grey = Buffer.alloc(300 * 200);
  for (let i = 0; i < grey.length; i++) grey[i] = i % 251;
  const packed = zlib.deflateSync(grey, { level: 6 });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 1, 144, 1, 44, 3, 0, 0, 0, 0xff, 0xd9]);
  const text = "BT /F1 12 Tf 72 712 Td (A typed paragraph with plenty of words on it.) Tj ET";
  const p1 = `${text} q 300 0 0 200 72 300 cm /Fm1 Do Q q 16 0 0 16 10 10 cm /Icon Do Q /Icon Do`;
  const p3 = `${text} q 400 0 0 300 0 0 cm /Photo Do Q q 1 0 0 1 300 400 cm 200 0 0 200 0 0 cm BI /W 200 /H 200 /BPC 8 /CS /Gray ID ${"x".repeat(200 * 200)} EI Q`;
  return pdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 /Resources << /Font << /F1 9 0 R >> /XObject << /Fm1 10 0 R /Icon 11 0 R /Pic 12 0 R /Photo 13 0 R >> >> >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 7 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 8 0 R >>",
    stream("", p1),
    stream("", text),
    stream("", p3),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    stream("/Type /XObject /Subtype /Form /BBox [0 0 1 1]", "/Pic Do"),
    stream("/Type /XObject /Subtype /Image /Width 16 /Height 16 /ColorSpace /DeviceGray /BitsPerComponent 8", Buffer.alloc(256)),
    stream("/Type /XObject /Subtype /Image /Width 300 /Height 200 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode", packed),
    stream("/Type /XObject /Subtype /Image /Width 300 /Height 400 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode", jpeg),
  ]);
}

function greyImage(w: number, h: number, seed: number): Buffer {
  const px = Buffer.alloc(w * h);
  for (let i = 0; i < px.length; i++) px[i] = (i % 241) ^ seed;
  return stream(`/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 8`, px);
}

/** Slides as a template makes them (see pictures.rs `slides`). */
export function slides(): Buffer {
  const text = "BT /F1 12 Tf 72 712 Td (Speaker notes for this slide, with plenty of words.) Tj ET";
  const bg = "q 512 0 0 288 256 450 cm";
  const icon = "q 40 0 0 40 960 700 cm /Icon Do Q";
  const pages = [
    `${bg} /Title Do Q ${icon} ${text}`,
    `q 1024 0 0 768 0 0 cm /Paper Do Q ${bg} /Bg1 Do Q ${icon} ${text}`,
    `${bg} /Bg2 Do Q ${icon} q 300 0 0 200 100 100 cm /Figure Do Q ${text}`,
    `${bg} /Bg2 Do Q ${icon} q 60 0 0 40 100 100 cm /Thumb Do Q ${text}`,
  ];
  const objects: (string | Buffer)[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R 6 0 R] /Count 4 /Resources << /Font << /F1 11 0 R >> /XObject << /Title 12 0 R /Bg1 13 0 R /Bg2 14 0 R /Icon 15 0 R /Paper 16 0 R /Figure 17 0 R /Thumb 18 0 R >> >> >>",
  ];
  for (let i = 0; i < 4; i++) objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1024 768] /Contents ${7 + i} 0 R >>`);
  for (const p of pages) objects.push(stream("", p));
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const flat = (seed: number) =>
    stream("/Type /XObject /Subtype /Image /Width 3840 /Height 2160 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode", zlib.deflateSync(Buffer.alloc(3840 * 2160, seed), { level: 9 }));
  objects.push(flat(10), flat(20), flat(20), greyImage(346, 346, 1), greyImage(1000, 1000, 2), greyImage(600, 400, 3), greyImage(300, 200, 4));
  return pdf(objects);
}

/** A zip of stored (uncompressed) entries, CRC left 0, as the Rust test built one. */
export function storedZip(files: [string, string][]): Buffer {
  const out: Buffer[] = [];
  const central: Buffer[] = [];
  let at = 0;
  for (const [name, body] of files) {
    const b = Buffer.from(body, "utf8");
    const n = Buffer.from(name, "utf8");
    const head = (sig: number, isCentral: boolean) => {
      const h = Buffer.alloc(isCentral ? 46 : 30);
      h.writeUInt32LE(sig, 0);
      let o = 4;
      if (isCentral) {
        h.writeUInt16LE(20, o);
        o += 2;
      }
      h.writeUInt16LE(20, o);
      o += 10; // version, flags, method, time, date
      o += 4; // crc
      h.writeUInt32LE(b.length, o);
      h.writeUInt32LE(b.length, o + 4);
      h.writeUInt16LE(n.length, o + 8);
      o += 12;
      if (isCentral) h.writeUInt32LE(at, o + 10);
      return Buffer.concat([h, n]);
    };
    const local = Buffer.concat([head(0x04034b50, false), b]);
    central.push(head(0x02014b50, true));
    out.push(local);
    at += local.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(at, 16);
  return Buffer.concat([...out, cd, end]);
}
