import { writeFileSync } from "node:fs";

/** Float32 to IEEE half precision (round to nearest even), for compact training and audit files. */
export function toHalf(v: number): number {
  const f = new Float32Array(1);
  const u = new Uint32Array(f.buffer);
  f[0] = v;
  const x = u[0];
  const sign = (x >>> 16) & 0x8000;
  let exp = ((x >>> 23) & 0xff) - 127 + 15;
  let mant = x & 0x7fffff;
  if (((x >>> 23) & 0xff) === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0); // inf / nan
  if (exp >= 0x1f) return sign | 0x7c00;
  if (exp <= 0) {
    if (exp < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - exp;
    let half = mant >>> shift;
    const rem = mant & ((1 << shift) - 1);
    const mid = 1 << (shift - 1);
    if (rem > mid || (rem === mid && half & 1)) half++;
    return sign | half;
  }
  let half = sign | (exp << 10) | (mant >>> 13);
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && half & 1)) half++;
  return half;
}

/** Write a C-ordered .npy file (float16 or float32 or uint8) readable by numpy.load. */
export function writeNpy(path: string, data: ArrayLike<number>, shape: number[], dtype: "f2" | "f4" | "u1" = "f2") {
  const descr = dtype === "u1" ? "|u1" : `<${dtype}`;
  let header = `{'descr': '${descr}', 'fortran_order': False, 'shape': (${shape.join(", ")}${shape.length === 1 ? "," : ""}), }`;
  const total = 10 + header.length + 1;
  header += " ".repeat((64 - (total % 64)) % 64) + "\n";
  const pre = Buffer.alloc(10);
  pre.write("\x93NUMPY", 0, "latin1");
  pre[6] = 1;
  pre[7] = 0;
  pre.writeUInt16LE(header.length, 8);
  let body: Buffer;
  if (dtype === "f2") {
    const h = new Uint16Array(data.length);
    for (let i = 0; i < data.length; i++) h[i] = toHalf(data[i]);
    body = Buffer.from(h.buffer);
  } else if (dtype === "f4") {
    body = Buffer.from(Float32Array.from(data).buffer);
  } else {
    body = Buffer.from(Uint8Array.from(data).buffer);
  }
  writeFileSync(path, Buffer.concat([pre, Buffer.from(header, "latin1"), body]));
}
