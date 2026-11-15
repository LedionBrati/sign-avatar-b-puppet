// Writes assets/noise.png: a tileable 160x160 film-grain texture (white/black specks, low alpha),
// laid over the cobalt gradients like the prototype's feTurbulence grain. No dependencies.
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const W = 160, H = 160;
let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0;
  for (let x = 0; x < W; x++) {
    const o = y * (W * 4 + 1) + 1 + x * 4, light = rnd() < 0.55, a = Math.round(Math.pow(rnd(), 1.4) * 46);
    const v = light ? 255 : 10;
    raw[o] = v; raw[o + 1] = v; raw[o + 2] = v; raw[o + 3] = a;
  }
}
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
writeFileSync(new URL("../assets/noise.png", import.meta.url), Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
console.log("assets/noise.png", W, H);
